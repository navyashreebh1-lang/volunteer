import mongoose from 'mongoose';
import type { AppContext } from '../context.js';
import { HttpError, conflict } from '../errors.js';
import { Activity, Assignment, type ActivityDoc, type UserDoc } from '../models.js';
import { placeVolunteer, rankCandidates } from './assignments.js';
import { loadVolunteers, type Violation } from './eligibility.js';
import { loadManagedEvent, seatCounts } from './events.js';

const REASON_LABELS: Record<Violation['code'], string> = {
  NOT_ACTIVE_STUDENT: 'are not active students',
  PROFILE_INCOMPLETE: 'have not completed their volunteer profile',
  MISSING_SKILL: 'lack a required skill',
  EXPERIENCE: 'do not have the required experience',
  UNAVAILABLE: 'are not available at that time',
  TIME_CONFLICT: 'have an overlapping assignment',
  HOURS_EXCEEDED: 'would exceed their daily hours limit',
  ALREADY_ASSIGNED: 'are already assigned to it',
  TEST_REQUIRED: 'have not passed the required mock test',
};

/** Explains a shortage from the reasons volunteers were ruled out. */
function shortageReason(eligible: number, total: number, ineligible: { violations: Violation[] }[], vacancies: number) {
  if (total === 0) return 'No students have registered yet.';
  const tally = new Map<Violation['code'], number>();
  for (const { violations } of ineligible) tally.set(violations[0].code, (tally.get(violations[0].code) ?? 0) + 1);
  const parts = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => `${n} ${REASON_LABELS[code]}`);
  const head =
    eligible === 0
      ? `None of the ${total} registered volunteers is eligible for the ${vacancies} open position${vacancies === 1 ? '' : 's'}`
      : `Only ${eligible} of ${total} registered volunteers ${eligible === 1 ? 'is' : 'are'} eligible`;
  return parts.length ? `${head}: ${parts.join(', ')}.` : `${head}.`;
}

/**
 * Generates assignments for an event's open, upcoming activities.
 *
 * Only vacant positions are filled: confirmed and pending assignments are
 * never overwritten. With `clearPending`, earlier automatic proposals that
 * nobody has confirmed yet are discarded first so they can be recomputed.
 *
 * Hard constraints (skills, experience, a required mock-test pass,
 * availability, overlaps, daily hours, capacity) decide who may be assigned; the score only orders those who
 * pass. Everything is saved as pending for a person to approve, and where
 * there are not enough eligible volunteers the position is left vacant and
 * reported, never filled with someone who does not qualify.
 */
export async function generateAllocation(ctx: AppContext, manager: UserDoc, eventId: string, options: { clearPending: boolean }) {
  const event = await loadManagedEvent(manager, eventId);
  if (event.status === 'cancelled' || event.status === 'completed') {
    throw conflict(`Allocations cannot be generated for a ${event.status} event`, 'INVALID_STATE');
  }

  const now = new Date();
  const all = await Activity.find({ eventId: event._id }).sort({ startAt: 1 });
  const targets = all.filter((a) => a.status === 'open' && a.endAt > now);

  let cleared = 0;
  if (options.clearPending && targets.length) {
    const result = await Assignment.deleteMany({ activityId: { $in: targets.map((a) => a._id) }, status: 'pending', source: 'auto' });
    cleared = result.deletedCount;
  }

  const volunteers = await loadVolunteers();
  const counts = await seatCounts(all.map((a) => a._id));
  const liveSeats = (a: ActivityDoc) => counts(a.id as string).pending + counts(a.id as string).confirmed;

  // Scarcest first: an activity few people qualify for gets first pick, so a
  // widely-qualified volunteer is not used up on an easy-to-fill activity.
  const scarcity = new Map<string, number>();
  for (const activity of targets) {
    const { ranked } = await rankCandidates(ctx, activity, volunteers);
    scarcity.set(activity.id as string, ranked.length - (activity.requiredCount - liveSeats(activity)));
  }
  const order = [...targets].sort(
    (a, b) => scarcity.get(a.id as string)! - scarcity.get(b.id as string)! || a.startAt.getTime() - b.startAt.getTime(),
  );

  interface Planned {
    studentId: string;
    fullName: string;
    usn: string;
    score: number;
    explanation: string[];
  }
  const plan = new Map<string, { planned: Planned[]; eligible: number; ineligible: { violations: Violation[] }[] }>();

  for (const activity of order) {
    const vacancies = activity.requiredCount - liveSeats(activity);
    // Re-ranked here because earlier picks changed people's seats and workload.
    const { ranked, ineligible } = await rankCandidates(ctx, activity, volunteers);
    const picks = vacancies > 0 ? ranked.slice(0, vacancies) : [];
    for (const pick of picks) {
      // Reserve the time so later activities see this volunteer as busy.
      pick.volunteer.seats.push({
        assignmentId: `planned:${activity.id}:${pick.volunteer.id}`,
        activityId: activity.id as string,
        activityName: activity.name,
        date: activity.date,
        startAt: activity.startAt,
        endAt: activity.endAt,
        status: 'pending',
      });
    }
    plan.set(activity.id as string, {
      planned: picks.map((p) => ({ studentId: p.volunteer.id, fullName: p.volunteer.user.fullName, usn: p.volunteer.usn, score: p.score, explanation: p.explanation })),
      eligible: ranked.length,
      ineligible,
    });
  }

  // Save. Each placement re-checks every rule against committed data in its
  // own transaction; anything that no longer holds is dropped with a warning.
  const saved = new Map<string, Planned[]>();
  const warnings = new Map<string, string[]>();
  for (const activity of order) {
    for (const planned of plan.get(activity.id as string)!.planned) {
      try {
        await mongoose.connection.transaction((session) =>
          placeVolunteer({ activityId: activity._id, studentId: planned.studentId, source: 'auto', actor: manager, score: planned.score, explanation: planned.explanation }, session),
        );
        saved.set(activity.id as string, [...(saved.get(activity.id as string) ?? []), planned]);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status >= 500) throw err;
        warnings.set(activity.id as string, [...(warnings.get(activity.id as string) ?? []), `${planned.fullName} was not assigned: ${err.message}`]);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: manager.fullName,
    totalVolunteers: volunteers.size,
    clearedPending: cleared,
    activities: all.map((activity) => {
      const id = activity.id as string;
      const entry = plan.get(id);
      const assigned = saved.get(id) ?? [];
      const already = liveSeats(activity);
      const vacancies = Math.max(0, activity.requiredCount - already - assigned.length);
      const notes = [...(warnings.get(id) ?? [])];
      let status: 'filled' | 'shortage' | 'skipped' = vacancies === 0 ? 'filled' : 'shortage';
      let reason: string | null = null;
      if (!entry) {
        status = 'skipped';
        notes.push(activity.status !== 'open' ? `Skipped: the activity is ${activity.status}.` : 'Skipped: the activity has already ended.');
      } else if (vacancies > 0) {
        reason = shortageReason(entry.eligible, volunteers.size, entry.ineligible, activity.requiredCount - already);
      }
      return {
        activityId: id,
        name: activity.name,
        date: activity.date,
        startTime: activity.startTime,
        endTime: activity.endTime,
        required: activity.requiredCount,
        alreadyAssigned: already,
        newlyAssigned: assigned,
        assigned: already + assigned.length,
        vacancies,
        status,
        shortageReason: reason,
        warnings: notes,
      };
    }),
  };

  event.set('lastAllocation', report);
  await event.save();
  return report;
}


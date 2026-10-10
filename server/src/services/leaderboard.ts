import { CATEGORY_SKILLS, type ActivityCategory } from '../catalog.js';
import type { AppContext } from '../context.js';
import { forbidden, unprocessable } from '../errors.js';
import { Activity, Event, type UserDoc } from '../models.js';
import { checkVolunteer, loadVolunteers } from './eligibility.js';
import { canManageEvent, isManager } from './events.js';
import { isCategory, loadTestSettings } from './questionBank.js';
import { defaultScoring, relevantSkillsFor, suitability } from './scoring.js';
import { loadQualifyingResults } from './tests.js';

export interface LeaderboardFilters {
  category?: string;
  activityId?: string;
  minScore?: number;
  maxScore?: number;
  eligible?: boolean;
}

/**
 * The ranking for one activity category (optionally for one specific
 * activity in it). Nothing is stored: every request recomputes it from the
 * qualifying test attempts, current profile skills and performance
 * evaluations, so it reflects a new submission, a retake, a skill change or
 * a corrected rating as soon as it happens. Categories are never mixed.
 *
 * Order: overall suitability, then mock-test score, then the earlier
 * submission, then USN — so the order is always fully determined.
 *
 * Students see the public columns only. Organizers additionally get USNs,
 * the reasons behind an eligibility status and the score components.
 */
export async function getLeaderboard(ctx: AppContext, viewer: UserDoc, filters: LeaderboardFilters) {
  const manager = await isManager(viewer);
  if (!manager && viewer.role !== 'student') throw forbidden();

  let category = filters.category;
  let activity = null;
  let event = null;
  if (filters.activityId) {
    // Ranking against a specific activity reveals who can be assigned; that is for its organizers.
    activity = await Activity.findById(filters.activityId);
    event = activity ? await Event.findById(activity.eventId) : null;
    if (!activity || !event || !(await canManageEvent(viewer, event))) throw forbidden();
    if (!activity.activityType) throw unprocessable('This activity has no activity type, so no mock test applies to it', 'NO_CATEGORY');
    category = activity.activityType;
  }
  if (!isCategory(category)) throw unprocessable('Choose an activity category', 'NO_CATEGORY');

  const [results, settings] = await Promise.all([loadQualifyingResults({ category }), loadTestSettings()]);
  const config = { ...defaultScoring, ...ctx.scoring };
  const passMark = settings.get(category)!.passingPercent;
  const volunteers = await loadVolunteers({ studentIds: [...results.values()].map((r) => r.studentId) });
  const skills = relevantSkillsFor(category as ActivityCategory, activity ?? undefined);

  const rows = [...results.values()].flatMap((result) => {
    const volunteer = volunteers.get(result.studentId);
    // Only people who are still active students are ranked.
    if (!volunteer || volunteer.user.role !== 'student' || volunteer.user.accountStatus !== 'active') return [];
    const score = suitability(volunteer, category as ActivityCategory, skills, config);
    const reasons = activity
      ? checkVolunteer(volunteer, activity).map((v) => v.message)
      : result.passed
        ? []
        : [`Mock-test score is below the ${passMark}% pass mark`];
    return [{ result, volunteer, score, reasons }];
  });

  rows.sort(
    (a, b) =>
      b.score.overall - a.score.overall ||
      b.result.percent - a.result.percent ||
      a.result.submittedAt.getTime() - b.result.submittedAt.getTime() ||
      a.volunteer.usn.localeCompare(b.volunteer.usn),
  );

  const ranked = rows.map((row, index) => ({
    rank: index + 1,
    displayName: row.volunteer.user.fullName,
    isMe: row.volunteer.id === viewer.id,
    category,
    testPercent: row.result.percent,
    skillMatch: row.score.skillMatch,
    history: {
      label: row.score.history.label,
      score: row.score.history.score,
      provisional: row.score.history.provisional,
    },
    overall: row.score.overall,
    eligible: row.reasons.length === 0,
    eligibility: row.reasons.length === 0 ? (activity ? 'Eligible' : 'Qualified') : activity ? 'Not eligible' : 'Below pass mark',
    ...(manager
      ? {
          studentId: row.volunteer.id,
          usn: row.volunteer.usn,
          department: row.volunteer.department,
          reasons: row.reasons,
          testSubmittedAt: row.result.submittedAt,
          attemptsUsed: row.result.attemptsUsed,
          historyCount: row.score.history.count,
          skills: row.volunteer.skills,
        }
      : {}),
  }));

  // Filters narrow what is shown; ranks stay the positions in the full ranking.
  const entries = ranked.filter(
    (r) =>
      (filters.minScore === undefined || r.overall >= filters.minScore) &&
      (filters.maxScore === undefined || r.overall <= filters.maxScore) &&
      (filters.eligible === undefined || r.eligible === filters.eligible),
  );

  return {
    category,
    activity: activity ? { id: activity.id as string, name: activity.name, eventName: event!.name } : null,
    weights: config.suitability,
    historyPolicy: config.history,
    relevantSkills: skills.length ? skills : CATEGORY_SKILLS[category as ActivityCategory],
    total: ranked.length,
    myRank: ranked.find((r) => r.isMe)?.rank ?? null,
    entries,
    generatedAt: new Date().toISOString(),
  };
}

/** A student's position in each category they have a qualifying result for. */
export async function myRanks(ctx: AppContext, student: UserDoc) {
  const mine = await loadQualifyingResults({ studentIds: [student._id] });
  const ranks = [];
  for (const result of mine.values()) {
    const board = await getLeaderboard(ctx, student, { category: result.category });
    ranks.push({ category: result.category, rank: board.myRank, total: board.total, testPercent: result.percent, passed: result.passed });
  }
  return ranks;
}

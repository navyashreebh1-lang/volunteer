import { hoursBetween, localToday } from '../catalog.js';
import type { AppContext } from '../context.js';
import { ACTIVE_ASSIGNMENT_STATUSES } from '../domain.js';
import { forbidden } from '../errors.js';
import { Activity, Assignment, Event, StudentProfile, User, type UserDoc } from '../models.js';
import { findIssues, listOwnAssignments } from './assignments.js';
import { activityBlocker, checkVolunteer, loadVolunteers } from './eligibility.js';
import { isManager, managedEventFilter, seatCounts, serializeActivity, serializeEvent } from './events.js';
import { totalLoad } from './scoring.js';
import { getOwnProfile } from './volunteerProfile.js';

const round = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ student

/**
 * Open, upcoming activities in published events, with whether the signed-in
 * student currently meets the mandatory requirements. Shows vacancy counts
 * but never who else is assigned.
 */
export async function listAvailableActivities(student: UserDoc) {
  const now = new Date();
  const events = await Event.find({ status: 'published' });
  const eventById = new Map(events.map((e) => [e.id as string, e]));
  const activities = await Activity.find({ eventId: { $in: events.map((e) => e._id) }, status: 'open', endAt: { $gt: now } }).sort({ startAt: 1 });
  const counts = await seatCounts(activities.map((a) => a._id));
  const me = (await loadVolunteers({ studentIds: [student._id] })).get(student.id as string);

  return activities.map((activity) => {
    const event = eventById.get(String(activity.eventId))!;
    const c = counts(activity.id as string);
    const mine = me?.seats.find((s) => s.activityId === activity.id);
    const reasons = me ? checkVolunteer(me, activity).filter((v) => v.code !== 'ALREADY_ASSIGNED').map((v) => v.message) : ['Not a student account'];
    return {
      ...serializeActivity(activity),
      event: { id: event.id as string, name: event.name, venue: event.venue },
      vacancies: Math.max(0, activity.requiredCount - c.pending - c.confirmed),
      myStatus: mine?.status ?? null,
      eligible: reasons.length === 0,
      reasons,
    };
  });
}

export async function studentDashboard(ctx: AppContext, student: UserDoc) {
  const [profile, assignments, activities] = await Promise.all([
    getOwnProfile(student),
    listOwnAssignments(student),
    listAvailableActivities(student),
  ]);
  const today = localToday(ctx.config.utcOffsetMinutes);
  const upcomingEvents = await Event.find({ status: 'published', endDate: { $gte: today } }).sort({ startDate: 1 }).limit(10);

  const confirmed = assignments.filter((a) => a.status === 'confirmed');
  const upcomingConfirmed = confirmed.filter((a) => !a.ended);
  // Hours count once the activity is over, unless the volunteer was marked absent.
  const completedHours = confirmed.filter((a) => a.ended && a.attendance !== 'absent').reduce((sum, a) => sum + a.hours, 0);

  return {
    profile: { complete: profile.complete, completion: profile.completion, skills: profile.skills },
    upcomingEvents: upcomingEvents.map(serializeEvent),
    availableActivities: activities.slice(0, 6),
    pendingAssignments: assignments.filter((a) => a.status === 'pending' && !a.ended),
    confirmedAssignments: upcomingConfirmed,
    schedule: upcomingConfirmed,
    totals: {
      completedHours: round(completedHours),
      upcomingHours: round(upcomingConfirmed.reduce((sum, a) => sum + a.hours, 0)),
      completedActivities: confirmed.filter((a) => a.ended && a.attendance !== 'absent').length,
    },
  };
}

// ------------------------------------------------------------------ managers

/** Registered students with the profile details organizers need for staffing. */
export async function listVolunteers(manager: UserDoc, filters: { q?: string; skill?: string }) {
  if (!(await isManager(manager))) throw forbidden();
  const volunteers = [...(await loadVolunteers()).values()];
  const needle = filters.q?.trim().toLowerCase();
  const skill = filters.skill?.trim().toLowerCase();
  return volunteers
    .filter((v) => !needle || v.user.fullName.toLowerCase().includes(needle) || v.usn.toLowerCase().includes(needle))
    .filter((v) => !skill || v.skillKeys.has(skill))
    .sort((a, b) => a.user.fullName.localeCompare(b.user.fullName))
    .map((v) => ({
      id: v.id,
      fullName: v.user.fullName,
      usn: v.usn,
      email: v.user.email,
      phone: v.user.phone,
      department: v.department,
      semester: v.semester,
      skills: v.skills,
      preferences: v.preferences,
      availability: v.availability,
      maxHoursPerDay: v.maxHoursPerDay,
      profileComplete: v.profileComplete,
      attendedCount: v.attendedCount,
      assignedHours: round(totalLoad(v)),
      liveAssignments: v.seats.length,
    }));
}

/**
 * Every figure is computed from the stored records at request time.
 * Position, vacancy and workload figures cover upcoming activities only. Faculty
 * see all events; an organizer sees the events they manage. Volunteer
 * totals are institution-wide for both.
 */
export async function analytics(manager: UserDoc, eventId?: string) {
  if (!(await isManager(manager))) throw forbidden();
  const events = await Event.find({ ...managedEventFilter(manager), ...(eventId ? { _id: eventId } : {}) });
  const eventById = new Map(events.map((e) => [e.id as string, e]));
  const now = new Date();
  const allActivities = await Activity.find({ eventId: { $in: events.map((e) => e._id) }, status: { $ne: 'cancelled' } }).sort({ startAt: 1 });
  // Staffing figures describe work still to be done, so finished activities
  // and finished or cancelled events are left out of them.
  const activities = allActivities.filter((a) => {
    const status = eventById.get(String(a.eventId))!.status;
    return a.endAt > now && status !== 'completed' && status !== 'cancelled';
  });
  const activityById = new Map(activities.map((a) => [a.id as string, a]));
  const live = await Assignment.find({ activityId: { $in: activities.map((a) => a._id) }, status: { $in: ACTIVE_ASSIGNMENT_STATUSES } });
  const issues = await findIssues(live, activityById, eventById);

  const perActivity = activities.map((activity) => {
    const own = live.filter((a) => String(a.activityId) === activity.id);
    const confirmed = own.filter((a) => a.status === 'confirmed').length;
    const pending = own.length - confirmed;
    return {
      activityId: activity.id as string,
      name: activity.name,
      eventName: eventById.get(String(activity.eventId))!.name,
      date: activity.date,
      required: activity.requiredCount,
      confirmed,
      pending,
      vacancies: Math.max(0, activity.requiredCount - own.length),
      upcoming: activity.endAt > now && !activityBlocker(activity, eventById.get(String(activity.eventId))!, now),
    };
  });

  const [studentCount, profiles] = await Promise.all([
    User.countDocuments({ role: 'student', accountStatus: 'active' }),
    StudentProfile.find({ userId: { $in: await User.find({ role: 'student', accountStatus: 'active' }).distinct('_id') } }),
  ]);

  const skillCounts = new Map<string, number>();
  for (const profile of profiles) for (const skill of profile.skills) skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);

  // Workload = hours of live (pending or confirmed) seats in the events in scope.
  const hoursByStudent = new Map<string, number>();
  for (const a of live) {
    const activity = activityById.get(String(a.activityId))!;
    hoursByStudent.set(String(a.studentId), (hoursByStudent.get(String(a.studentId)) ?? 0) + hoursBetween(activity.startAt, activity.endAt));
  }
  const buckets = [
    { label: 'No duties', test: (h: number) => h === 0 },
    { label: 'Up to 2 h', test: (h: number) => h > 0 && h <= 2 },
    { label: '2–5 h', test: (h: number) => h > 2 && h <= 5 },
    { label: '5–10 h', test: (h: number) => h > 5 && h <= 10 },
    { label: 'Over 10 h', test: (h: number) => h > 10 },
  ];
  const workload = buckets.map((b) => ({
    label: b.label,
    volunteers: profiles.filter((p) => b.test(hoursByStudent.get(String(p.userId)) ?? 0)).length,
  }));

  const required = perActivity.reduce((sum, a) => sum + a.required, 0);
  const confirmed = perActivity.reduce((sum, a) => sum + a.confirmed, 0);
  const pending = perActivity.reduce((sum, a) => sum + a.pending, 0);

  return {
    totals: {
      volunteers: studentCount,
      volunteersWithCompleteProfile: profiles.filter((p) => p.profileCompletedAt).length,
      events: events.length,
      activities: allActivities.length,
      upcomingActivities: activities.length,
      positionsRequired: required,
      positionsAssigned: confirmed + pending,
      positionsConfirmed: confirmed,
      pendingApprovals: pending,
      vacancies: perActivity.reduce((sum, a) => sum + a.vacancies, 0),
      conflicts: issues.size,
    },
    activityAllocation: perActivity,
    understaffed: perActivity.filter((a) => a.upcoming && a.vacancies > 0),
    skillDistribution: [...skillCounts.entries()].map(([skill, volunteers]) => ({ skill, volunteers })).sort((a, b) => b.volunteers - a.volunteers || a.skill.localeCompare(b.skill)),
    workloadDistribution: workload,
    events: events.map(serializeEvent).sort((a, b) => b.startDate.localeCompare(a.startDate)),
  };
}

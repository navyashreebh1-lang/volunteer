import mongoose from 'mongoose';
import { z } from 'zod';
import { EVALUATION_CRITERIA, type EvaluationCriterion } from '../domain.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import {
  Activity,
  Assignment,
  Event,
  Notification,
  PerformanceEvaluation,
  RatingAudit,
  StudentProfile,
  User,
  type PerformanceEvaluationDoc,
  type UserDoc,
} from '../models.js';
import { isVerifiedFaculty } from './accounts.js';
import { loadManagedActivity, managedEventFilter } from './events.js';

/**
 * Relative weight of each criterion in the overall rating. Equal by
 * default; change these to make, say, task completion count for more.
 */
export const CRITERIA_WEIGHTS: Record<EvaluationCriterion, number> = {
  taskCompletion: 1,
  punctuality: 1,
  communication: 1,
  teamwork: 1,
  responsibility: 1,
  problemSolving: 1,
};

export const CRITERIA_LABELS: Record<EvaluationCriterion, string> = {
  taskCompletion: 'Task completion',
  punctuality: 'Punctuality and attendance',
  communication: 'Communication',
  teamwork: 'Teamwork',
  responsibility: 'Responsibility',
  problemSolving: 'Problem-solving',
};

type Criteria = Record<EvaluationCriterion, number>;

/** The overall rating is always derived here from the criteria; a client cannot supply it. */
export function overallRating(criteria: Criteria) {
  const totalWeight = EVALUATION_CRITERIA.reduce((sum, c) => sum + CRITERIA_WEIGHTS[c], 0);
  const weighted = EVALUATION_CRITERIA.reduce((sum, c) => sum + criteria[c] * CRITERIA_WEIGHTS[c], 0);
  return Math.round((weighted / totalWeight) * 100) / 100;
}

const rating = z.number({ required_error: 'Give a rating from 1 to 5', invalid_type_error: 'Give a rating from 1 to 5' }).int('Ratings are whole numbers from 1 to 5').min(1).max(5);
const criteriaSchema = z.object(Object.fromEntries(EVALUATION_CRITERIA.map((c) => [c, rating])) as Record<EvaluationCriterion, typeof rating>).strict();
const createSchema = z.object({ criteria: criteriaSchema, feedback: z.string().trim().max(2000).default('') }).strict();
const correctionSchema = z
  .object({
    criteria: criteriaSchema,
    feedback: z.string().trim().max(2000).default(''),
    reason: z.string({ required_error: 'Explain why the rating is being corrected' }).trim().min(5, 'Explain why the rating is being corrected (at least 5 characters)').max(500),
  })
  .strict();

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.code === 'unrecognized_keys' ? issue.keys[0] : issue.path.join('.') || '_';
    fields[key] ??= issue.code === 'unrecognized_keys' ? 'This field cannot be set' : issue.message;
  }
  throw badRequest('Some fields are invalid', fields);
}

const criteriaOf = (e: PerformanceEvaluationDoc) => Object.fromEntries(EVALUATION_CRITERIA.map((c) => [c, (e.criteria as unknown as Criteria)[c]])) as Criteria;
const snapshot = (e: PerformanceEvaluationDoc) => ({ criteria: criteriaOf(e), overall: e.overall, feedback: e.feedback });

/**
 * Records a reviewer's evaluation of one volunteer on one finished
 * assignment. Only someone who manages that event may do it, only for a
 * volunteer who was actually confirmed on the activity, and never for
 * themselves.
 */
export async function submitEvaluation(reviewer: UserDoc, assignmentId: string, body: unknown) {
  const assignment = await Assignment.findById(assignmentId);
  if (!assignment) throw notFound('Assignment not found');
  const { activity, event } = await loadManagedActivity(reviewer, String(assignment.activityId));
  const input = parse(createSchema, body);

  if (String(assignment.studentId) === String(reviewer._id)) throw forbidden('You cannot evaluate your own performance');
  if (assignment.status !== 'confirmed') throw conflict('Only volunteers with a confirmed assignment can be evaluated', 'INVALID_STATE');
  if (activity.endAt > new Date()) throw conflict('Evaluations can be submitted after the activity has ended', 'INVALID_STATE');
  if (assignment.attendance === 'absent') throw unprocessable('This volunteer was marked absent, so there is no performance to evaluate', 'VOLUNTEER_ABSENT');

  try {
    return await mongoose.connection.transaction(async (session) => {
      const [evaluation] = await PerformanceEvaluation.create(
        [
          {
            assignmentId: assignment._id,
            studentId: assignment.studentId,
            eventId: event._id,
            activityId: activity._id,
            reviewerId: reviewer._id,
            criteria: input.criteria,
            overall: overallRating(input.criteria),
            feedback: input.feedback,
          },
        ],
        { session },
      );
      await RatingAudit.create([{ evaluationId: evaluation._id, action: 'created', actorId: reviewer._id, after: snapshot(evaluation) }], { session });
      await Notification.create(
        [
          {
            userId: assignment.studentId,
            type: 'performance_evaluated',
            title: 'New performance feedback',
            message: `Your work on "${activity.name}" (${event.name}) has been evaluated. See it under My Feedback.`,
          },
        ],
        { session },
      );
      return { id: evaluation.id as string, overall: evaluation.overall };
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw conflict('You have already evaluated this assignment. Use the correction option to change it.', 'ALREADY_EVALUATED');
    }
    throw err;
  }
}

/**
 * Changes an existing evaluation. Allowed for the reviewer who wrote it and
 * for verified faculty; a reason is mandatory and the previous values are
 * kept in the audit trail, so a rating is never silently rewritten.
 */
export async function correctEvaluation(actor: UserDoc, evaluationId: string, body: unknown) {
  const evaluation = await PerformanceEvaluation.findById(evaluationId);
  if (!evaluation) throw notFound('Evaluation not found');
  const input = parse(correctionSchema, body);
  if (String(evaluation.studentId) === String(actor._id)) throw forbidden('You cannot change an evaluation of yourself');
  const isAuthor = String(evaluation.reviewerId) === String(actor._id);
  if (!isAuthor && !(await isVerifiedFaculty(actor))) throw forbidden('Only the original reviewer or a faculty member can correct this evaluation');

  await mongoose.connection.transaction(async (session) => {
    const before = snapshot(evaluation);
    evaluation.set({ criteria: input.criteria, overall: overallRating(input.criteria), feedback: input.feedback, status: 'corrected' });
    await evaluation.save({ session });
    await RatingAudit.create(
      [{ evaluationId: evaluation._id, action: 'corrected', actorId: actor._id, reason: input.reason, before, after: snapshot(evaluation) }],
      { session },
    );
    await Notification.create(
      [{ userId: evaluation.studentId, type: 'performance_corrected', title: 'Performance feedback updated', message: 'An evaluation of your performance was corrected. See it under My Feedback.' }],
      { session },
    );
  });
  return { id: evaluation.id as string, overall: evaluation.overall, status: evaluation.status };
}

async function describe(evaluations: PerformanceEvaluationDoc[], forStudent: boolean) {
  const [activities, events, people, profiles] = await Promise.all([
    Activity.find({ _id: { $in: evaluations.map((e) => e.activityId) } }),
    Event.find({ _id: { $in: evaluations.map((e) => e.eventId) } }),
    User.find({ _id: { $in: evaluations.flatMap((e) => [e.reviewerId, e.studentId]) } }),
    StudentProfile.find({ userId: { $in: evaluations.map((e) => e.studentId) } }),
  ]);
  const activityById = new Map(activities.map((a) => [a.id as string, a]));
  const eventById = new Map(events.map((e) => [e.id as string, e]));
  const personById = new Map(people.map((p) => [p.id as string, p]));
  const usnById = new Map(profiles.map((p) => [String(p.userId), p.usn]));

  return evaluations.map((e) => {
    const activity = activityById.get(String(e.activityId));
    const reviewer = personById.get(String(e.reviewerId));
    const student = personById.get(String(e.studentId));
    return {
      id: e.id as string,
      assignmentId: String(e.assignmentId),
      criteria: criteriaOf(e),
      overall: e.overall,
      feedback: e.feedback,
      status: e.status,
      submittedAt: e.createdAt,
      updatedAt: e.updatedAt,
      activity: activity ? { id: activity.id as string, name: activity.name, date: activity.date, activityType: activity.activityType ?? null } : null,
      event: { id: String(e.eventId), name: eventById.get(String(e.eventId))?.name ?? 'Event' },
      reviewer: { name: reviewer?.fullName ?? 'Reviewer', role: reviewer?.role ?? 'faculty' },
      ...(forStudent ? {} : { student: { id: String(e.studentId), fullName: student?.fullName ?? 'Student', usn: usnById.get(String(e.studentId)) ?? '' }, reviewerId: String(e.reviewerId) }),
    };
  });
}

/** A student's own feedback — the query is always scoped to their id. */
export async function listOwnEvaluations(student: UserDoc) {
  const evaluations = await PerformanceEvaluation.find({ studentId: student._id }).sort({ createdAt: -1 });
  const items = await describe(evaluations, true);
  const average = items.length ? Math.round((items.reduce((sum, e) => sum + e.overall, 0) / items.length) * 100) / 100 : null;
  return { evaluations: items, average, count: items.length };
}

export interface EvaluationFilters {
  eventId?: string;
  activityId?: string;
  studentId?: string;
  q?: string;
  from?: string;
  to?: string;
}

async function scopeEventIds(manager: UserDoc, eventId?: string) {
  const events = await Event.find({ ...managedEventFilter(manager), ...(eventId ? { _id: eventId } : {}) }).select('_id');
  if (eventId && !events.length) throw forbidden();
  return events.map((e) => e._id);
}

export async function listEvaluations(manager: UserDoc, filters: EvaluationFilters) {
  const query: Record<string, unknown> = { eventId: { $in: await scopeEventIds(manager, filters.eventId) } };
  if (filters.activityId) query.activityId = filters.activityId;
  if (filters.studentId) query.studentId = filters.studentId;
  if (filters.from || filters.to) {
    query.createdAt = {
      ...(filters.from ? { $gte: new Date(`${filters.from}T00:00:00Z`) } : {}),
      ...(filters.to ? { $lte: new Date(`${filters.to}T23:59:59Z`) } : {}),
    };
  }
  const items = await describe(await PerformanceEvaluation.find(query).sort({ createdAt: -1 }).limit(1000), false);
  const needle = filters.q?.trim().toLowerCase();
  return items.filter((e) => !needle || `${e.student!.fullName} ${e.student!.usn}`.toLowerCase().includes(needle));
}

/** Confirmed assignments on finished activities that this reviewer has not evaluated yet. */
export async function listAwaitingEvaluation(manager: UserDoc, filters: EvaluationFilters) {
  const eventIds = await scopeEventIds(manager, filters.eventId);
  const now = new Date();
  const activities = await Activity.find({ eventId: { $in: eventIds }, endAt: { $lte: now }, ...(filters.activityId ? { _id: filters.activityId } : {}) });
  const activityById = new Map(activities.map((a) => [a.id as string, a]));
  const assignments = await Assignment.find({
    activityId: { $in: activities.map((a) => a._id) },
    status: 'confirmed',
    attendance: { $ne: 'absent' },
    studentId: { $ne: manager._id },
    ...(filters.studentId ? { studentId: filters.studentId } : {}),
  });
  const done = await PerformanceEvaluation.find({ assignmentId: { $in: assignments.map((a) => a._id) }, reviewerId: manager._id }).select('assignmentId');
  const doneIds = new Set(done.map((d) => String(d.assignmentId)));
  const waiting = assignments.filter((a) => !doneIds.has(a.id as string));

  const [students, profiles, events] = await Promise.all([
    User.find({ _id: { $in: waiting.map((a) => a.studentId) } }),
    StudentProfile.find({ userId: { $in: waiting.map((a) => a.studentId) } }),
    Event.find({ _id: { $in: eventIds } }),
  ]);
  const studentById = new Map(students.map((s) => [s.id as string, s]));
  const usnById = new Map(profiles.map((p) => [String(p.userId), p.usn]));
  const eventById = new Map(events.map((e) => [e.id as string, e]));
  const needle = filters.q?.trim().toLowerCase();

  return waiting
    .flatMap((a) => {
      const activity = activityById.get(String(a.activityId))!;
      const student = studentById.get(String(a.studentId));
      if (!student) return [];
      const usn = usnById.get(student.id as string) ?? '';
      if (needle && !`${student.fullName} ${usn}`.toLowerCase().includes(needle)) return [];
      return [
        {
          assignmentId: a.id as string,
          attendance: a.attendance ?? null,
          student: { id: student.id as string, fullName: student.fullName, usn },
          activity: { id: activity.id as string, name: activity.name, date: activity.date, activityType: activity.activityType ?? null },
          event: { id: String(a.eventId), name: eventById.get(String(a.eventId))?.name ?? 'Event' },
        },
      ];
    })
    .sort((x, y) => y.activity.date.localeCompare(x.activity.date));
}

export async function evaluationAudit(manager: UserDoc, evaluationId: string) {
  const evaluation = await PerformanceEvaluation.findById(evaluationId);
  if (!evaluation) throw notFound('Evaluation not found');
  if (!(await scopeEventIds(manager, String(evaluation.eventId))).length) throw forbidden();
  const entries = await RatingAudit.find({ evaluationId: evaluation._id }).sort({ createdAt: 1 });
  const actors = await User.find({ _id: { $in: entries.map((e) => e.actorId) } });
  const nameOf = new Map(actors.map((a) => [a.id as string, a.fullName]));
  return entries.map((e) => ({
    action: e.action,
    actor: nameOf.get(String(e.actorId)) ?? 'Unknown',
    reason: e.reason,
    before: e.before ?? null,
    after: e.after,
    at: e.createdAt,
  }));
}

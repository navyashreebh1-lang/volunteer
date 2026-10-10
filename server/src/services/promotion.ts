import mongoose from 'mongoose';
import type { AppContext } from '../context.js';
import {
  DECISION_TO_STATUS,
  PROMOTION_STATUSES,
  canTransitionPromotion,
  isRoleTransitionAllowed,
  type PromotionDecision,
  type PromotionStatus,
} from '../domain.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import {
  Notification,
  PromotionRequest,
  RoleAuditLog,
  Session,
  StudentProfile,
  User,
  type PromotionRequestDoc,
  type UserDoc,
} from '../models.js';
import { isVerifiedFaculty } from './accounts.js';
import { evaluateEligibility, getEvidence } from './evidence.js';

/**
 * Which students a faculty member may review. This phase has no department
 * or event-ownership data to scope by, so every verified faculty member can
 * review every student in the institution. Narrow it here when that exists;
 * every faculty read and decision goes through this function.
 */
export async function canFacultyReview(faculty: UserDoc, student: UserDoc): Promise<boolean> {
  return (await isVerifiedFaculty(faculty)) && String(faculty._id) !== String(student._id);
}

function summarize(request: PromotionRequestDoc) {
  return {
    id: request.id as string,
    status: request.status as PromotionStatus,
    statement: request.statement,
    createdAt: request.createdAt,
    reviewReason: request.reviewReason,
    reviewedAt: request.reviewedAt,
  };
}

/**
 * Opens a promotion request. A student may ask for themselves; a verified
 * faculty member may nominate a student by USN. Opening a request grants
 * nothing — only decidePromotion can change a role.
 */
export async function createPromotionRequest(ctx: AppContext, actor: UserDoc, input: { statement: string; usn?: string }) {
  let student: UserDoc | null;
  if (actor.role === 'student') {
    if (input.usn) throw forbidden('Students can only request a promotion for themselves');
    student = actor;
  } else if (await isVerifiedFaculty(actor)) {
    if (!input.usn) throw unprocessable('Provide the USN of the student to nominate', 'USN_REQUIRED');
    const profile = await StudentProfile.findOne({ usn: input.usn });
    student = profile ? await User.findById(profile.userId) : null;
    if (!student) throw notFound('No student found with that USN');
    if (!(await canFacultyReview(actor, student))) throw forbidden();
  } else {
    throw forbidden();
  }

  if (student.role !== 'student') throw conflict('This account already holds the organizer role', 'NOT_A_STUDENT');
  if (student.accountStatus !== 'active') throw unprocessable('The student account is not active', 'STUDENT_INACTIVE');

  if (ctx.policy.reapplyCooldownDays > 0) {
    const lastRejection = await PromotionRequest.findOne({ studentId: student._id, status: 'rejected' }).sort({ reviewedAt: -1 });
    const until = lastRejection?.reviewedAt
      ? new Date(lastRejection.reviewedAt.getTime() + ctx.policy.reapplyCooldownDays * 86_400_000)
      : null;
    if (until && until.getTime() > Date.now()) {
      throw unprocessable(`A new request can be made after ${until.toISOString().slice(0, 10)}`, 'COOLDOWN_ACTIVE');
    }
  }

  try {
    const request = await PromotionRequest.create({
      studentId: student._id,
      requestedBy: actor._id,
      statement: input.statement,
    });
    return summarize(request);
  } catch (err) {
    // Lost the race against the partial unique index: a request is already open.
    if ((err as { code?: number }).code === 11000) {
      throw conflict('There is already an open promotion request for this student', 'DUPLICATE_REQUEST');
    }
    throw err;
  }
}

export async function listOwnRequests(userId: mongoose.Types.ObjectId) {
  const requests = await PromotionRequest.find({ studentId: userId }).sort({ createdAt: -1 });
  return requests.map(summarize);
}

async function studentSummary(student: UserDoc) {
  const profile = await StudentProfile.findOne({ userId: student._id });
  return {
    id: student.id as string,
    fullName: student.fullName,
    username: student.username,
    email: student.email,
    usn: profile?.usn ?? null,
    role: student.role,
    accountStatus: student.accountStatus,
    hasPhoto: Boolean(student.photoKey),
    memberSince: student.createdAt,
  };
}

export async function listRequestsForFaculty(faculty: UserDoc, status?: PromotionStatus) {
  const requests = await PromotionRequest.find(status ? { status } : {})
    .sort({ createdAt: -1 })
    .limit(200);
  const students = await User.find({ _id: { $in: requests.map((r) => r.studentId) } });
  const byId = new Map(students.map((s) => [s.id as string, s]));

  const rows = [];
  for (const request of requests) {
    const student = byId.get(String(request.studentId));
    if (!student || !(await canFacultyReview(faculty, student))) continue;
    rows.push({ ...summarize(request), student: await studentSummary(student) });
  }
  return rows;
}

async function loadForReview(faculty: UserDoc, requestId: string) {
  const request = await PromotionRequest.findById(requestId);
  const student = request ? await User.findById(request.studentId) : null;
  if (!request || !student) throw notFound('Promotion request not found');
  if (!(await canFacultyReview(faculty, student))) throw forbidden();
  return { request, student };
}

export async function getRequestDetail(ctx: AppContext, faculty: UserDoc, requestId: string) {
  const { request, student } = await loadForReview(faculty, requestId);
  const evidence = await getEvidence(student._id);

  const [audit, reviewers] = await Promise.all([
    RoleAuditLog.find({ userId: student._id }).sort({ createdAt: -1 }).limit(50),
    User.find({ _id: { $in: request.reviewHistory.map((h) => h.reviewedBy) } }),
  ]);
  const actors = await User.find({ _id: { $in: audit.map((a) => a.actorId).filter(Boolean) } });
  const nameOf = (id: unknown) =>
    [...reviewers, ...actors].find((u) => String(u._id) === String(id))?.fullName ?? 'Unknown';

  return {
    ...summarize(request),
    student: await studentSummary(student),
    evidence: { records: evidence.records, summary: evidence.summary },
    eligibility: evaluateEligibility(student, evidence.summary, ctx.policy),
    policy: ctx.policy,
    allowedDecisions: (['approve', 'reject', 'needs_review'] as PromotionDecision[]).filter((d) =>
      canTransitionPromotion(request.status as PromotionStatus, DECISION_TO_STATUS[d]),
    ),
    reviewHistory: request.reviewHistory.map((h) => ({
      status: h.status,
      reason: h.reason,
      at: h.at,
      reviewedBy: nameOf(h.reviewedBy),
    })),
    auditHistory: audit.map((a) => ({
      id: a.id as string,
      action: a.action,
      previousRole: a.previousRole,
      newRole: a.newRole,
      actor: a.actorId ? nameOf(a.actorId) : 'System',
      actorRole: a.actorRole,
      reason: a.reason,
      at: a.createdAt,
    })),
  };
}

/**
 * Records a faculty decision. Approval is the only place a student becomes an
 * organizer, and it is all-or-nothing: the request status, the role change,
 * the audit record and the notification commit in one transaction. If any
 * write fails, the request stays open and the role is untouched, so the
 * reviewer can simply retry.
 *
 * The conditional updates make it safe against double submits and concurrent
 * reviewers: only one decision can move a request out of an open status.
 */
export async function decidePromotion(
  ctx: AppContext,
  faculty: UserDoc,
  requestId: string,
  decision: PromotionDecision,
  reason: string,
) {
  const { request, student } = await loadForReview(faculty, requestId);
  const target = DECISION_TO_STATUS[decision];

  if (!canTransitionPromotion(request.status as PromotionStatus, target)) {
    throw conflict(`A request that is ${request.status.replace('_', ' ')} cannot be moved to ${target.replace('_', ' ')}`, 'INVALID_STATE');
  }

  const evidence = await getEvidence(student._id);
  if (decision === 'approve') {
    if (!isRoleTransitionAllowed('student', 'organizer', 'faculty_promotion')) throw forbidden();
    const eligibility = evaluateEligibility(student, evidence.summary, ctx.policy);
    const mandatoryFailed = eligibility.checks.some((c) => !c.passed && (c.id === 'active_account' || c.id === 'is_student'));
    if (mandatoryFailed || (!eligibility.eligible && ctx.policy.enforceOnApproval)) {
      throw unprocessable('This student does not currently meet the promotion policy', 'POLICY_NOT_MET', {
        failed: eligibility.checks.filter((c) => !c.passed),
      });
    }
  }

  const allowedFrom = PROMOTION_STATUSES.filter((s) => canTransitionPromotion(s, target));
  const now = new Date();

  await mongoose.connection.transaction(async (session) => {
    const updated = await PromotionRequest.findOneAndUpdate(
      { _id: request._id, status: { $in: allowedFrom } },
      {
        $set: {
          status: target,
          reviewedBy: faculty._id,
          reviewReason: reason,
          reviewedAt: now,
          evidence: evidence.refs,
        },
        $push: { reviewHistory: { status: target, reviewedBy: faculty._id, reason, at: now } },
      },
      { session },
    );
    if (!updated) throw conflict('This request has already been decided', 'INVALID_STATE');

    if (decision === 'approve') {
      const promoted = await User.findOneAndUpdate(
        { _id: student._id, role: 'student', accountStatus: 'active' },
        { role: 'organizer' },
        { session },
      );
      // Throwing aborts the transaction, so the request does not end up
      // "approved" without the role actually having changed.
      if (!promoted) throw conflict('The student account is no longer eligible for promotion', 'INVALID_STATE');

      await RoleAuditLog.create(
        [
          {
            action: 'organizer_promotion',
            userId: student._id,
            previousRole: 'student',
            newRole: 'organizer',
            actorId: faculty._id,
            actorRole: faculty.role,
            reason,
            promotionRequestId: request._id,
          },
        ],
        { session },
      );
      // Sessions opened as a student end here; the organizer login is next.
      await Session.updateMany({ userId: student._id, revokedAt: null }, { revokedAt: now }, { session });
    }

    const notice = {
      approve: {
        title: 'You are now an organizer',
        message: `Your promotion was approved. Sign in again and choose Organizer, using your existing username and password. Reason: ${reason}`,
      },
      reject: { title: 'Promotion request not approved', message: `Reason: ${reason}` },
      needs_review: { title: 'Promotion request needs further review', message: `Note from the reviewer: ${reason}` },
    }[decision];
    await Notification.create(
      [{ userId: student._id, type: `promotion_${target}`, ...notice, relatedPromotionRequestId: request._id }],
      { session },
    );
  });

  return { id: request.id as string, status: target };
}

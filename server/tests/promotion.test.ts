import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Assignment,
  FacultyProfile,
  Notification,
  PromotionRequest,
  RoleAuditLog,
  StudentProfile,
  User,
} from '../src/models.js';
import { PASSWORD, addAttendance, createFaculty, createStudent, loginAs, useTestApp } from './helpers.js';

const t = useTestApp('promotion');
afterEach(() => vi.restoreAllMocks());

/** A student with an open request, plus a verified faculty reviewer. */
async function scenario() {
  const student = await createStudent(t.app);
  const studentAgent = await loginAs(t.app, student.username, 'student');
  const created = await studentAgent.post('/api/promotion-requests').send({ statement: 'I would like to organize.' }).expect(201);
  const faculty = await createFaculty(t.app);
  const facultyAgent = await loginAs(t.app, faculty.username, 'faculty');
  const requestId = created.body.request.id as string;
  const decide = (decision: string, reason = 'Reviewed the record carefully') =>
    facultyAgent.post(`/api/faculty/promotion-requests/${requestId}/decision`).send({ decision, reason });
  return { student, studentAgent, faculty, facultyAgent, requestId, decide };
}

const roleOf = async (id: string) => (await User.findById(id))?.role;
const statusOf = async (id: string) => (await PromotionRequest.findById(id))?.status;

describe('requesting a promotion', () => {
  it('lets a student open one request and refuses duplicates', async () => {
    const { studentAgent, student } = await scenario();
    const dup = await studentAgent.post('/api/promotion-requests').send({}).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_REQUEST');
    expect(await PromotionRequest.countDocuments({ studentId: student.id })).toBe(1);
    // Opening a request grants nothing.
    expect(await roleOf(student.id)).toBe('student');
  });

  it('creates exactly one request when submitted concurrently', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    const results = await Promise.all(Array.from({ length: 5 }, () => agent.post('/api/promotion-requests').send({})));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await PromotionRequest.countDocuments()).toBe(1);
  });

  it('lets verified faculty nominate by USN, but nobody else', async () => {
    const student = await createStudent(t.app);
    const other = await createStudent(t.app);
    const faculty = await createFaculty(t.app);
    const facultyAgent = await loginAs(t.app, faculty.username, 'faculty');

    await facultyAgent.post('/api/promotion-requests').send({ usn: student.usn }).expect(201);
    await facultyAgent.post('/api/promotion-requests').send({ usn: '1VX22CS999' }).expect(404);

    // A student cannot open a request for someone else.
    const studentAgent = await loginAs(t.app, student.username, 'student');
    await studentAgent.post('/api/promotion-requests').send({ usn: other.usn }).expect(403);
    await request(t.app).post('/api/promotion-requests').send({}).expect(401);
    expect(await PromotionRequest.countDocuments({ studentId: other.id })).toBe(0);
  });
});

describe('faculty review', () => {
  it('shows real evidence and reports missing feedback as missing', async () => {
    const { student, facultyAgent, requestId } = await scenario();
    await addAttendance(student.id, 'attended', 4);
    await addAttendance(student.id, 'attended'); // attended, no feedback recorded
    await addAttendance(student.id, 'absent');

    const res = await facultyAgent.get(`/api/faculty/promotion-requests/${requestId}`).expect(200);
    const { evidence, student: summary } = res.body.request;
    expect(summary.usn).toBe(student.usn);
    expect(evidence.summary).toMatchObject({
      recordedEvents: 3,
      attendedEvents: 2,
      feedbackCount: 1,
      attendedEventsMissingFeedback: 1,
      averageRating: 4,
      containsTestData: true,
    });
    expect(evidence.records.filter((r: { feedback: unknown }) => r.feedback === null)).toHaveLength(2);
  });

  it('reports no rating at all, rather than a favourable one, when no feedback exists', async () => {
    const { facultyAgent, requestId } = await scenario();
    const res = await facultyAgent.get(`/api/faculty/promotion-requests/${requestId}`).expect(200);
    expect(res.body.request.evidence.summary).toMatchObject({ recordedEvents: 0, attendanceRate: null, averageRating: null, feedbackCount: 0 });
    expect(res.body.request.evidence.records).toEqual([]);
  });

  it('does not reject or block a student because of a single low rating', async () => {
    const { student, facultyAgent, requestId, decide } = await scenario();
    await addAttendance(student.id, 'attended', 1);
    const detail = await facultyAgent.get(`/api/faculty/promotion-requests/${requestId}`).expect(200);
    expect(detail.body.request.status).toBe('pending');
    expect(detail.body.request.eligibility.eligible).toBe(true);
    await decide('approve').expect(200);
    expect(await roleOf(student.id)).toBe('organizer');
  });

  it('requires a decision and a reason', async () => {
    const { decide, facultyAgent, requestId, student } = await scenario();
    await decide('approve', '').expect(400);
    await decide('approve', 'ok').expect(400);
    await decide('promote').expect(400);
    await facultyAgent.post(`/api/faculty/promotion-requests/${requestId}/decision`).send({ reason: 'No decision given' }).expect(400);
    expect(await statusOf(requestId)).toBe('pending');
    expect(await roleOf(student.id)).toBe('student');
  });
});

describe('approving a promotion', () => {
  it('promotes the existing account, audits it, notifies the student and keeps their history', async () => {
    const { student, studentAgent, faculty, requestId, decide } = await scenario();
    const attendance = await addAttendance(student.id, 'attended', 5);

    const res = await decide('approve', 'Consistent attendance and strong feedback').expect(200);
    expect(res.body.request.status).toBe('approved');

    // Same account, new role — no duplicate user.
    expect(await User.countDocuments({ username: student.username })).toBe(1);
    expect(await roleOf(student.id)).toBe('organizer');

    const request_ = await PromotionRequest.findById(requestId);
    expect(request_).toMatchObject({ status: 'approved', reviewReason: 'Consistent attendance and strong feedback' });
    expect(String(request_?.reviewedBy)).toBe(faculty.id);
    expect(request_?.reviewedAt).toBeInstanceOf(Date);
    expect(request_?.evidence?.assignmentIds.map(String)).toEqual([String(attendance._id)]);

    const audit = await RoleAuditLog.find({ userId: student.id, action: 'organizer_promotion' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      previousRole: 'student',
      newRole: 'organizer',
      actorRole: 'faculty',
      reason: 'Consistent attendance and strong feedback',
    });
    expect(String(audit[0].actorId)).toBe(faculty.id);
    expect(audit[0].createdAt).toBeInstanceOf(Date);

    const notes = await Notification.find({ userId: student.id });
    expect(notes.map((n) => n.type)).toEqual(['promotion_approved']);

    // The session opened as a student is no longer valid.
    await studentAgent.get('/api/me').expect(401);

    // Same username and password now work through the Organizer option only.
    await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role: 'student' }).expect(403);
    const organizer = await loginAs(t.app, student.username, 'organizer');
    await organizer.get('/api/organizer/overview').expect(200);

    // Student profile and volunteering history are untouched.
    const me = await organizer.get('/api/me').expect(200);
    expect(me.body.user).toMatchObject({ id: student.id, role: 'organizer' });
    expect(me.body.studentProfile.usn).toBe(student.usn);
    expect(await StudentProfile.countDocuments({ userId: student.id })).toBe(1);
    expect(await Assignment.countDocuments({ studentId: student.id })).toBe(1);
    const inbox = await organizer.get('/api/notifications').expect(200);
    expect(inbox.body.notifications[0].title).toMatch(/organizer/i);
  });

  it('applies a duplicate or concurrent approval only once', async () => {
    const { student, decide } = await scenario();
    const results = await Promise.all([decide('approve'), decide('approve'), decide('approve')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await RoleAuditLog.countDocuments({ userId: student.id, action: 'organizer_promotion' })).toBe(1);
    expect(await Notification.countDocuments({ userId: student.id })).toBe(1);

    const again = await decide('approve').expect(409);
    expect(again.body.code).toBe('INVALID_STATE');
    await decide('reject').expect(409);
    expect(await roleOf(student.id)).toBe('organizer');
  });

  it('rolls everything back if the role change cannot be fully recorded, and can be retried', async () => {
    const { student, studentAgent, requestId, decide } = await scenario();
    vi.spyOn(RoleAuditLog, 'create').mockRejectedValueOnce(new Error('simulated database failure'));

    const failed = await decide('approve').expect(500);
    expect(JSON.stringify(failed.body)).not.toContain('simulated');

    // No misleading "approved" request, no role change, no notification.
    expect(await statusOf(requestId)).toBe('pending');
    expect(await roleOf(student.id)).toBe('student');
    expect(await RoleAuditLog.countDocuments({ userId: student.id })).toBe(0);
    expect(await Notification.countDocuments({ userId: student.id })).toBe(0);
    await studentAgent.get('/api/me').expect(200);

    await decide('approve').expect(200);
    expect(await roleOf(student.id)).toBe('organizer');
    expect(await RoleAuditLog.countDocuments({ userId: student.id })).toBe(1);
  });

  it('does not approve when the student account is not active', async () => {
    const { student, requestId, decide } = await scenario();
    await User.updateOne({ _id: student.id }, { accountStatus: 'suspended' });
    const res = await decide('approve').expect(422);
    expect(res.body.code).toBe('POLICY_NOT_MET');
    expect(await statusOf(requestId)).toBe('pending');
    expect(await roleOf(student.id)).toBe('student');
  });

  it('enforces a configured minimum without deciding for the reviewer', async () => {
    t.ctx.policy.minAttendedEvents = 2;
    const { student, facultyAgent, requestId, decide } = await scenario();
    await addAttendance(student.id, 'attended');

    const detail = await facultyAgent.get(`/api/faculty/promotion-requests/${requestId}`).expect(200);
    expect(detail.body.request.eligibility.eligible).toBe(false);
    // Failing the policy does not reject the request by itself.
    expect(detail.body.request.status).toBe('pending');

    await decide('approve').expect(422);
    expect(await roleOf(student.id)).toBe('student');

    await addAttendance(student.id, 'attended');
    await decide('approve').expect(200);
    expect(await roleOf(student.id)).toBe('organizer');
  });
});

describe('rejecting and requesting further review', () => {
  it('rejects without changing the role, notifies the student and allows a later request', async () => {
    const { student, studentAgent, requestId, decide } = await scenario();
    await decide('reject', 'Needs more event experience first').expect(200);

    expect(await statusOf(requestId)).toBe('rejected');
    expect(await roleOf(student.id)).toBe('student');
    expect(await RoleAuditLog.countDocuments({ userId: student.id })).toBe(0);
    await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role: 'organizer' }).expect(403);

    const me = await studentAgent.get('/api/me').expect(200);
    expect(me.body.promotionRequests[0]).toMatchObject({ status: 'rejected', reviewReason: 'Needs more event experience first' });
    const inbox = await studentAgent.get('/api/notifications').expect(200);
    expect(inbox.body.notifications[0].type).toBe('promotion_rejected');

    // A rejected request is final…
    await decide('approve').expect(409);
    await decide('needs_review').expect(409);
    expect(await roleOf(student.id)).toBe('student');
    // …but the student may apply again.
    await studentAgent.post('/api/promotion-requests').send({}).expect(201);
  });

  it('supports needs_review followed by a final decision, keeping the history', async () => {
    const { student, studentAgent, facultyAgent, requestId, decide } = await scenario();
    await decide('needs_review', 'Waiting for feedback from the last event').expect(200);
    expect(await statusOf(requestId)).toBe('needs_review');
    expect(await roleOf(student.id)).toBe('student');
    // Still an open request, so a second one is refused.
    await studentAgent.post('/api/promotion-requests').send({}).expect(409);
    await decide('needs_review').expect(409);

    await decide('approve', 'Feedback received and positive').expect(200);
    expect(await roleOf(student.id)).toBe('organizer');

    const detail = await facultyAgent.get(`/api/faculty/promotion-requests/${requestId}`).expect(200);
    expect(detail.body.request.reviewHistory.map((h: { status: string }) => h.status)).toEqual(['needs_review', 'approved']);
    expect(detail.body.request.auditHistory).toHaveLength(1);
    expect(detail.body.request.allowedDecisions).toEqual([]);
  });

  it('honours a configured re-application cooldown', async () => {
    t.ctx.policy.reapplyCooldownDays = 30;
    const { studentAgent, decide } = await scenario();
    await decide('reject').expect(200);
    const res = await studentAgent.post('/api/promotion-requests').send({}).expect(422);
    expect(res.body.code).toBe('COOLDOWN_ACTIVE');
  });
});

describe('who may promote', () => {
  it('refuses everyone except verified faculty', async () => {
    const { student, studentAgent, requestId } = await scenario();
    const url = `/api/faculty/promotion-requests/${requestId}/decision`;
    const body = { decision: 'approve', reason: 'Trying to escalate privileges' };

    await request(t.app).post(url).send(body).expect(401);
    // The student themselves (self-promotion).
    await studentAgent.post(url).send(body).expect(403);
    await studentAgent.get(`/api/faculty/promotion-requests/${requestId}`).expect(403);
    await studentAgent.get('/api/faculty/promotion-requests').expect(403);
    // Another student.
    const other = await createStudent(t.app);
    await (await loginAs(t.app, other.username, 'student')).post(url).send(body).expect(403);

    expect(await roleOf(student.id)).toBe('student');
    expect(await statusOf(requestId)).toBe('pending');
    expect(await RoleAuditLog.countDocuments({ action: 'organizer_promotion' })).toBe(0);
  });

  it('does not let an organizer promote themselves or other students', async () => {
    const first = await scenario();
    await first.decide('approve').expect(200);
    const organizer = await loginAs(t.app, first.student.username, 'organizer');

    const second = await createStudent(t.app);
    const secondAgent = await loginAs(t.app, second.username, 'student');
    const created = await secondAgent.post('/api/promotion-requests').send({}).expect(201);
    const url = `/api/faculty/promotion-requests/${created.body.request.id}/decision`;

    await organizer.post(url).send({ decision: 'approve', reason: 'Organizer approving a friend' }).expect(403);
    await organizer.get('/api/faculty/promotion-requests').expect(403);
    await organizer.post('/api/promotion-requests').send({ usn: second.usn }).expect(403);
    // Nor grant themselves faculty privileges.
    await organizer.patch('/api/me').send({ role: 'faculty' }).expect(400);

    expect(await roleOf(second.id)).toBe('student');
    expect(await roleOf(first.student.id)).toBe('organizer');
  });

  it('stops a faculty member whose verification is withdrawn mid-session', async () => {
    const { student, faculty, facultyAgent, requestId, decide } = await scenario();
    await FacultyProfile.updateOne({ userId: faculty.id }, { verificationStatus: 'rejected' });
    await decide('approve').expect(403);
    await facultyAgent.get('/api/faculty/promotion-requests').expect(403);
    expect(await roleOf(student.id)).toBe('student');
    expect(await statusOf(requestId)).toBe('pending');
  });

  it('returns 404 for unknown requests and 400 for malformed ids', async () => {
    const { facultyAgent } = await scenario();
    const body = { decision: 'approve', reason: 'Reviewed the record carefully' };
    await facultyAgent.post('/api/faculty/promotion-requests/64b7f0f0f0f0f0f0f0f0f0f0/decision').send(body).expect(404);
    await facultyAgent.post('/api/faculty/promotion-requests/not-an-id/decision').send(body).expect(400);
  });
});

describe('role-scoped areas and private data', () => {
  it('keeps the organizer area for organizers only', async () => {
    const { student, studentAgent, facultyAgent } = await scenario();
    await studentAgent.get('/api/organizer/overview').expect(403);
    await facultyAgent.get('/api/organizer/overview').expect(403);
    await request(t.app).get('/api/organizer/overview').expect(401);
    expect(await roleOf(student.id)).toBe('student');
  });

  it("does not let a user read or change another user's notifications", async () => {
    const { student, studentAgent, decide } = await scenario();
    await decide('reject').expect(200);
    const note = await Notification.findOne({ userId: student.id });

    const other = await createStudent(t.app);
    const otherAgent = await loginAs(t.app, other.username, 'student');
    expect((await otherAgent.get('/api/notifications').expect(200)).body.notifications).toEqual([]);
    await otherAgent.post(`/api/notifications/${note!.id}/read`).expect(404);
    expect((await Notification.findById(note!.id))?.readAt).toBeNull();

    await studentAgent.post(`/api/notifications/${note!.id}/read`).expect(200);
    expect((await Notification.findById(note!.id))?.readAt).toBeInstanceOf(Date);
  });

});

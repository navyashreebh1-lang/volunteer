import { Types } from 'mongoose';
import type { PromotionPolicy } from '../config/promotionPolicy.js';
import { Activity, Assignment, Event, PerformanceEvaluation, type UserDoc } from '../models.js';

export interface EvidenceSummary {
  recordedEvents: number;
  attendedEvents: number;
  /** null when there are no attendance records at all. */
  attendanceRate: number | null;
  feedbackCount: number;
  /** Attended events for which nobody has recorded feedback. */
  attendedEventsMissingFeedback: number;
  /** Mean of the ratings that exist; null (not zero, not "good") when none do. */
  averageRating: number | null;
  containsTestData: boolean;
}

/**
 * Reads the student's volunteering history from their confirmed assignments
 * to activities that have ended. Attendance and feedback are whatever the
 * organizer recorded; nothing is inferred when they recorded nothing.
 */
export async function getEvidence(studentId: Types.ObjectId | string) {
  const assignments = await Assignment.find({ studentId, status: 'confirmed' });
  const [activities, events] = await Promise.all([
    Activity.find({ _id: { $in: assignments.map((a) => a.activityId) }, endAt: { $lte: new Date() } }),
    Event.find({ _id: { $in: assignments.map((a) => a.eventId) } }),
  ]);
  // Feedback is the post-event performance evaluations of each assignment.
  const evaluations = await PerformanceEvaluation.find({ assignmentId: { $in: assignments.map((a) => a._id) } }).sort({ createdAt: 1 });
  const evaluationsByAssignment = new Map<string, typeof evaluations>();
  for (const e of evaluations) evaluationsByAssignment.set(String(e.assignmentId), [...(evaluationsByAssignment.get(String(e.assignmentId)) ?? []), e]);
  const activityById = new Map(activities.map((a) => [a.id as string, a]));
  const eventById = new Map(events.map((e) => [e.id as string, e]));

  const records = assignments
    .flatMap((assignment) => {
      const activity = activityById.get(String(assignment.activityId));
      const event = eventById.get(String(assignment.eventId));
      if (!activity || !event) return []; // not finished yet
      return [
        {
          id: assignment.id as string,
          eventTitle: event.name,
          roleTitle: activity.name,
          eventDate: activity.startAt,
          // 'not_recorded' is shown as such and never counted as attended.
          status: (assignment.attendance ?? 'not_recorded') as 'attended' | 'absent' | 'not_recorded',
          isTestData: Boolean(event.isSampleData),
          // null means "no feedback on record" and is shown to the reviewer as missing.
          feedback: (() => {
            const own = evaluationsByAssignment.get(assignment.id as string) ?? [];
            if (!own.length) return null;
            return {
              id: own[0].id as string,
              rating: Math.round((own.reduce((sum, e) => sum + e.overall, 0) / own.length) * 10) / 10,
              comments: own.map((e) => e.feedback).filter(Boolean).join(' · '),
              isTestData: Boolean(event.isSampleData),
            };
          })(),
        },
      ];
    })
    .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime());

  const withAttendance = records.filter((r) => r.status !== 'not_recorded');
  const attended = records.filter((r) => r.status === 'attended');
  const ratings = records.flatMap((r) => (r.feedback ? [r.feedback.rating] : []));
  const summary: EvidenceSummary = {
    recordedEvents: records.length,
    attendedEvents: attended.length,
    attendanceRate: withAttendance.length ? attended.length / withAttendance.length : null,
    feedbackCount: ratings.length,
    attendedEventsMissingFeedback: attended.filter((r) => !r.feedback).length,
    averageRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    containsTestData: records.some((r) => r.isTestData),
  };

  return { records, summary, refs: { assignmentIds: records.map((r) => new Types.ObjectId(r.id)) } };
}

export interface EligibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

/**
 * Pure policy evaluation. The result informs the faculty reviewer and can
 * block an approval, but it never approves or rejects anything by itself.
 */
export function evaluateEligibility(student: UserDoc, summary: EvidenceSummary, policy: PromotionPolicy) {
  const checks: EligibilityCheck[] = [
    {
      id: 'active_account',
      label: 'Student account is active',
      passed: student.accountStatus === 'active',
      detail: `Account status: ${student.accountStatus}`,
    },
    {
      id: 'is_student',
      label: 'Account currently holds the student role',
      passed: student.role === 'student',
      detail: `Current role: ${student.role}`,
    },
  ];

  if (policy.minAttendedEvents > 0) {
    checks.push({
      id: 'min_attended_events',
      label: `Attended at least ${policy.minAttendedEvents} event(s)`,
      passed: summary.attendedEvents >= policy.minAttendedEvents,
      detail: `${summary.attendedEvents} attended`,
    });
  }
  if (policy.minAttendanceRate !== null) {
    checks.push({
      id: 'min_attendance_rate',
      label: `Attendance rate of at least ${Math.round(policy.minAttendanceRate * 100)}%`,
      // No records means the rate is unknown, which does not satisfy a minimum.
      passed: summary.attendanceRate !== null && summary.attendanceRate >= policy.minAttendanceRate,
      detail: summary.attendanceRate === null ? 'No attendance on record' : `${Math.round(summary.attendanceRate * 100)}%`,
    });
  }
  if (policy.minFeedbackCount > 0) {
    checks.push({
      id: 'min_feedback_count',
      label: `At least ${policy.minFeedbackCount} feedback entr${policy.minFeedbackCount === 1 ? 'y' : 'ies'} on record`,
      passed: summary.feedbackCount >= policy.minFeedbackCount,
      detail: `${summary.feedbackCount} on record`,
    });
  }

  return { eligible: checks.every((c) => c.passed), checks };
}

/**
 * Institution-configurable organizer promotion policy.
 *
 * The policy only decides whether a student is *eligible to be considered*.
 * It never promotes anyone: the final decision is always an explicit action
 * by a verified faculty member (see services/promotion.ts).
 *
 * There is deliberately no rating threshold here. Feedback ratings are shown
 * to the reviewer as evidence, but a low rating never rejects a student
 * automatically.
 */
export interface PromotionPolicy {
  /** Minimum number of events the student actually attended. 0 = no minimum. */
  minAttendedEvents: number;
  /** Minimum attended / recorded ratio (0..1). null = not required. */
  minAttendanceRate: number | null;
  /** Minimum number of feedback entries on record. 0 = not required. */
  minFeedbackCount: number;
  /** Days a student must wait after a rejection before requesting again. */
  reapplyCooldownDays: number;
  /** When true, faculty cannot approve a request that fails the checks above. */
  enforceOnApproval: boolean;
}

export const defaultPromotionPolicy: PromotionPolicy = {
  minAttendedEvents: 0,
  minAttendanceRate: null,
  minFeedbackCount: 0,
  reapplyCooldownDays: 0,
  enforceOnApproval: true,
};

function num(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadPromotionPolicy(): PromotionPolicy {
  const rate = num('PROMOTION_MIN_ATTENDANCE_RATE');
  if (rate !== undefined && rate > 1) throw new Error('PROMOTION_MIN_ATTENDANCE_RATE must be between 0 and 1');
  return {
    minAttendedEvents: num('PROMOTION_MIN_ATTENDED_EVENTS') ?? defaultPromotionPolicy.minAttendedEvents,
    minAttendanceRate: rate ?? defaultPromotionPolicy.minAttendanceRate,
    minFeedbackCount: num('PROMOTION_MIN_FEEDBACK_COUNT') ?? defaultPromotionPolicy.minFeedbackCount,
    reapplyCooldownDays: num('PROMOTION_REAPPLY_COOLDOWN_DAYS') ?? defaultPromotionPolicy.reapplyCooldownDays,
    enforceOnApproval: process.env.PROMOTION_ENFORCE_POLICY !== 'false',
  };
}

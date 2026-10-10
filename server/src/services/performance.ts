import { ACTIVITY_TYPES } from '../catalog.js';
import type { AppContext } from '../context.js';
import { OPEN_PROMOTION_STATUSES } from '../domain.js';
import { PerformanceEvaluation, PromotionRequest, TestAttempt, type UserDoc } from '../models.js';
import { loadVolunteers } from './eligibility.js';
import { listAwaitingEvaluation } from './evaluations.js';
import { defaultScoring, historyScore } from './scoring.js';
import { closeExpiredAttempts, loadQualifyingResults } from './tests.js';

/** Thresholds for the "may be ready for organizer promotion" hint. It is only a hint. */
const PROMOTION_HINT = { minAttended: 1, minEvaluations: 1, minAverageRating: 4 };

export interface PerformanceFilters {
  category?: string;
  q?: string;
  from?: string;
  to?: string;
}

/**
 * Faculty overview of mock-test participation, results and performance
 * history. The promotion column only points out students worth looking at;
 * promoting anyone still goes through the faculty approval workflow.
 */
export async function performanceSummary(ctx: AppContext, faculty: UserDoc, filters: PerformanceFilters) {
  await closeExpiredAttempts();
  const config = { ...defaultScoring, ...ctx.scoring };
  const volunteers = [...(await loadVolunteers()).values()];
  const ids = volunteers.map((v) => v.user._id);

  const dateRange =
    filters.from || filters.to
      ? { submittedAt: { ...(filters.from ? { $gte: new Date(`${filters.from}T00:00:00Z`) } : {}), ...(filters.to ? { $lte: new Date(`${filters.to}T23:59:59Z`) } : {}) } }
      : {};
  const [attempts, qualifying, openPromotions, evaluationCount, awaiting] = await Promise.all([
    TestAttempt.find({ studentId: { $in: ids }, status: 'submitted', ...(filters.category ? { category: filters.category } : {}), ...dateRange })
      .select('studentId category attemptNumber submittedAt result autoSubmitted')
      .sort({ submittedAt: -1 }),
    loadQualifyingResults({ studentIds: ids, category: filters.category }),
    PromotionRequest.find({ studentId: { $in: ids }, status: { $in: OPEN_PROMOTION_STATUSES } }).select('studentId'),
    PerformanceEvaluation.countDocuments({ studentId: { $in: ids } }),
    listAwaitingEvaluation(faculty, {}),
  ]);
  const byId = new Map(volunteers.map((v) => [v.id, v]));
  const hasOpenPromotion = new Set(openPromotions.map((p) => String(p.studentId)));

  const byCategory = ACTIVITY_TYPES.filter((c) => !filters.category || c === filters.category).map((category) => {
    const own = [...qualifying.values()].filter((r) => r.category === category);
    const attemptsHere = attempts.filter((a) => a.category === category);
    return {
      category,
      participants: own.length,
      attempts: attemptsHere.length,
      averagePercent: own.length ? Math.round((own.reduce((sum, r) => sum + r.percent, 0) / own.length) * 10) / 10 : null,
      passRate: own.length ? Math.round((own.filter((r) => r.passed).length / own.length) * 100) : null,
    };
  });

  const needle = filters.q?.trim().toLowerCase();
  const students = volunteers
    .filter((v) => !needle || `${v.user.fullName} ${v.usn}`.toLowerCase().includes(needle))
    .map((v) => {
      const results = [...qualifying.values()].filter((r) => r.studentId === v.id).map((r) => ({ category: r.category, percent: r.percent, passed: r.passed }));
      const history = historyScore(v.history, config.history);
      const hints: string[] = [];
      if (v.attendedCount < PROMOTION_HINT.minAttended) hints.push('No attended activities yet');
      if (history.count < PROMOTION_HINT.minEvaluations) hints.push('No performance evaluations yet');
      else if ((history.average ?? 0) < PROMOTION_HINT.minAverageRating) hints.push(`Average rating below ${PROMOTION_HINT.minAverageRating}`);
      return {
        id: v.id,
        fullName: v.user.fullName,
        usn: v.usn,
        department: v.department,
        profileComplete: v.profileComplete,
        testsTaken: results.length,
        results,
        history: { label: history.label, score: history.score, provisional: history.provisional, count: history.count, average: history.average },
        attendedCount: v.attendedCount,
        promotion: {
          // A pointer for faculty, never an automatic decision.
          mayBeReady: hints.length === 0,
          openRequest: hasOpenPromotion.has(v.id),
          notes: hints,
        },
      };
    })
    .sort((a, b) => Number(b.promotion.mayBeReady) - Number(a.promotion.mayBeReady) || b.testsTaken - a.testsTaken || a.fullName.localeCompare(b.fullName));

  const tested = new Set([...qualifying.values()].map((r) => r.studentId));
  return {
    participation: {
      students: volunteers.length,
      studentsTested: tested.size,
      attempts: attempts.length,
      awaitingEvaluation: awaiting.length,
      completedEvaluations: evaluationCount,
    },
    byCategory,
    recentResults: attempts.slice(0, 50).flatMap((a) => {
      const v = byId.get(String(a.studentId));
      if (!v) return [];
      if (needle && !`${v.user.fullName} ${v.usn}`.toLowerCase().includes(needle)) return [];
      return [
        {
          id: a.id as string,
          student: { id: v.id, fullName: v.user.fullName, usn: v.usn },
          category: a.category,
          attemptNumber: a.attemptNumber,
          percent: a.result?.percent ?? 0,
          passed: Boolean(a.result?.passed),
          autoSubmitted: a.autoSubmitted,
          submittedAt: a.submittedAt,
        },
      ];
    }),
    students,
    promotionHint: PROMOTION_HINT,
  };
}

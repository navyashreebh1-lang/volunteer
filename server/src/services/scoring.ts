import { CATEGORY_SKILLS, hoursBetween, skillKey, type ActivityCategory } from '../catalog.js';
import type { ActivityDoc } from '../models.js';
import type { Volunteer } from './eligibility.js';

/**
 * The 100-point suitability model. Each component is first normalised to
 * 0–100, then weighted. It only ranks; it never makes anyone eligible.
 */
export interface SuitabilityWeights {
  /** Qualifying mock-test percentage for the same activity category. */
  test: number;
  /** Share of the relevant skills the volunteer lists in their profile. */
  skills: number;
  /** Past event performance, from post-event evaluations. */
  history: number;
}

export const defaultSuitabilityWeights: SuitabilityWeights = { test: 50, skills: 30, history: 20 };

/**
 * How past evaluations become the history component.
 *
 * A volunteer with no evaluations is not scored as zero, which would punish
 * everyone new. They get `neutralBaseline` instead and are marked
 * provisional. As evaluations arrive, the score moves from the baseline
 * towards the volunteer's own average: with n evaluations it is
 *   (n × own average + priorWeight × baseline) / (n + priorWeight)
 * so one unusually good or bad rating cannot swing it, and it stays
 * provisional until there are `provisionalBelow` evaluations.
 */
export interface HistoryPolicy {
  neutralBaseline: number;
  priorWeight: number;
  provisionalBelow: number;
}

export const defaultHistoryPolicy: HistoryPolicy = { neutralBaseline: 70, priorWeight: 2, provisionalBelow: 3 };

/**
 * How suitability combines with the two allocation-only factors when the
 * engine chooses between eligible volunteers for a specific activity.
 */
export interface AllocationWeights {
  suitability: number;
  /** The activity's category is one of the volunteer's preferences. */
  preference: number;
  /** Lighter current workload than the other candidates. */
  fairness: number;
}

export const defaultAllocationWeights: AllocationWeights = { suitability: 70, preference: 10, fairness: 20 };

export interface ScoringConfig {
  suitability: SuitabilityWeights;
  history: HistoryPolicy;
  allocation: AllocationWeights;
}

export const defaultScoring: ScoringConfig = {
  suitability: defaultSuitabilityWeights,
  history: defaultHistoryPolicy,
  allocation: defaultAllocationWeights,
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function historyScore(history: { count: number; average: number | null }, policy: HistoryPolicy) {
  if (!history.count || history.average === null) {
    return { score: policy.neutralBaseline, provisional: true, count: 0, average: null as number | null, label: 'No history yet' };
  }
  const own = ((history.average - 1) / 4) * 100;
  const score = (history.count * own + policy.priorWeight * policy.neutralBaseline) / (history.count + policy.priorWeight);
  return {
    score: round1(score),
    provisional: history.count < policy.provisionalBelow,
    count: history.count,
    average: round1(history.average),
    label: `${round1(history.average)}/5 from ${history.count} evaluation${history.count === 1 ? '' : 's'}`,
  };
}

/** Percentage of the relevant skills the volunteer has. With nothing to match against, nobody is penalised. */
export function skillMatch(volunteer: Volunteer, relevantSkills: string[]) {
  const keys = [...new Set(relevantSkills.map(skillKey))];
  if (!keys.length) return 100;
  return round1((keys.filter((k) => volunteer.skillKeys.has(k)).length / keys.length) * 100);
}

export type ScoredActivity = Pick<ActivityDoc, 'activityType' | 'requiredSkills' | 'preferredSkills' | 'date' | 'startAt' | 'endAt'>;

/** Skills that count for an activity: its own required and nice-to-have skills, or the category's when it lists none. */
export function relevantSkillsFor(category: ActivityCategory | null, activity?: Pick<ActivityDoc, 'requiredSkills' | 'preferredSkills'>) {
  const own = activity ? [...activity.requiredSkills, ...activity.preferredSkills] : [];
  if (own.length) return own;
  return category ? CATEGORY_SKILLS[category] : [];
}

/**
 * The suitability score and its parts. Test results only count for the
 * category they were taken in; where no category applies, the test weight
 * is left out of the scale rather than counted as zero for everyone.
 */
export function suitability(volunteer: Volunteer, category: ActivityCategory | null, relevantSkills: string[], config: ScoringConfig) {
  const test = category ? (volunteer.tests.get(category) ?? null) : null;
  const history = historyScore(volunteer.history, config.history);
  const skills = skillMatch(volunteer, relevantSkills);
  const w = config.suitability;
  const testWeight = category ? w.test : 0;
  const total = testWeight + w.skills + w.history;
  const points = testWeight * (test?.percent ?? 0) + w.skills * skills + w.history * history.score;
  return {
    overall: total ? round1(points / total) : 0,
    testPercent: test ? test.percent : null,
    testPassed: test ? test.passed : null,
    skillMatch: skills,
    history,
  };
}

/** Total hours of all upcoming seats the volunteer currently holds. */
export const totalLoad = (volunteer: Volunteer) => volunteer.seats.reduce((sum, s) => sum + hoursBetween(s.startAt, s.endAt), 0);

/**
 * Orders the volunteers who already passed every mandatory rule for one
 * activity: suitability, plus preference match and fair workload.
 */
export function scoreVolunteer(volunteer: Volunteer, activity: ScoredActivity, maxLoadAmongCandidates: number, config: ScoringConfig) {
  const category = (activity.activityType ?? null) as ActivityCategory | null;
  const suit = suitability(volunteer, category, relevantSkillsFor(category, activity), config);
  const explanation: string[] = [];

  if (category) explanation.push(suit.testPercent === null ? `No ${category} mock test taken` : `Mock test ${suit.testPercent}%`);
  explanation.push(`Skill match ${suit.skillMatch}%`);
  explanation.push(suit.history.count ? `Past performance ${suit.history.label}` : 'No performance history yet (neutral baseline)');

  const w = config.allocation;
  let points = w.suitability * suit.overall;
  let available = w.suitability;

  if (category) {
    available += w.preference;
    if (volunteer.preferences.includes(category)) {
      points += w.preference * 100;
      explanation.push(`Prefers ${category} activities`);
    }
  }

  available += w.fairness;
  const load = totalLoad(volunteer);
  points += w.fairness * 100 * (maxLoadAmongCandidates > 0 ? 1 - load / maxLoadAmongCandidates : 1);
  explanation.push(load === 0 ? 'No other duties assigned yet' : `Currently assigned ${round1(load)} h`);

  return { score: Math.round(points / available), explanation, suitability: suit };
}

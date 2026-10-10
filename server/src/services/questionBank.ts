import { z } from 'zod';
import { ACTIVITY_TYPES, type ActivityCategory } from '../catalog.js';
import { DIFFICULTIES } from '../domain.js';
import { badRequest, notFound } from '../errors.js';
import { Question, TestConfig, type QuestionDoc, type UserDoc } from '../models.js';
import { QUESTION_BANK, marksFor } from './questionBankData.js';

// ------------------------------------------------------------ test settings

export interface TestSettings {
  category: ActivityCategory;
  durationMinutes: number;
  questionCount: number;
  /** Minimum percentage to pass. 0 means the test has no pass mark. */
  passingPercent: number;
  /** How many times a student may take this category's test. */
  maxAttempts: number;
  /** Which completed attempt counts for rankings and allocation. */
  qualifyingAttempt: 'best' | 'latest';
  /**
   * When the correct answers and explanations are shown in the review.
   * 'after_final_attempt' holds them back while a retake is still possible.
   */
  showAnswers: 'never' | 'after_final_attempt' | 'always';
  active: boolean;
}

export const DEFAULT_TEST_SETTINGS: Omit<TestSettings, 'category'> = {
  durationMinutes: 15,
  questionCount: 8,
  passingPercent: 60,
  maxAttempts: 2,
  qualifyingAttempt: 'best',
  showAnswers: 'after_final_attempt',
  active: true,
};

export const isCategory = (value: unknown): value is ActivityCategory => (ACTIVITY_TYPES as readonly unknown[]).includes(value);

export function parseCategory(value: unknown): ActivityCategory {
  if (!isCategory(value)) throw badRequest('Choose a valid activity category', { category: 'Unknown activity category' });
  return value;
}

/** Every category's settings: the stored override where one exists, otherwise the defaults. */
export async function loadTestSettings(): Promise<Map<ActivityCategory, TestSettings>> {
  const stored = await TestConfig.find();
  const byCategory = new Map(stored.map((c) => [c.category, c]));
  return new Map(
    ACTIVITY_TYPES.map((category) => {
      const s = byCategory.get(category);
      return [
        category,
        s
          ? {
              category,
              durationMinutes: s.durationMinutes,
              questionCount: s.questionCount,
              passingPercent: s.passingPercent,
              maxAttempts: s.maxAttempts,
              qualifyingAttempt: s.qualifyingAttempt,
              showAnswers: s.showAnswers,
              active: s.active,
            }
          : { category, ...DEFAULT_TEST_SETTINGS },
      ];
    }),
  );
}

const settingsSchema = z
  .object({
    durationMinutes: z.number().int().min(1).max(180),
    questionCount: z.number().int().min(1).max(100),
    passingPercent: z.number().min(0).max(100),
    maxAttempts: z.number().int().min(1).max(20),
    qualifyingAttempt: z.enum(['best', 'latest']),
    showAnswers: z.enum(['never', 'after_final_attempt', 'always']),
    active: z.boolean(),
  })
  .strict();

function fieldErrors(error: z.ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.code === 'unrecognized_keys' ? issue.keys[0] : String(issue.path[0] ?? '_');
    fields[key] ??= issue.code === 'unrecognized_keys' ? 'This field cannot be set' : issue.message;
  }
  return fields;
}

export async function saveTestSettings(faculty: UserDoc, category: ActivityCategory, body: unknown) {
  const parsed = settingsSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest('Some fields are invalid', fieldErrors(parsed.error));
  await TestConfig.findOneAndUpdate({ category }, { ...parsed.data, category, updatedBy: faculty._id }, { upsert: true, runValidators: true });
  return (await loadTestSettings()).get(category)!;
}

// ---------------------------------------------------------------- questions

const questionSchema = z
  .object({
    category: z.enum(ACTIVITY_TYPES),
    text: z.string().trim().min(10, 'Write the full question (at least 10 characters)').max(1000),
    topic: z.string().trim().min(2, 'Enter a topic').max(60),
    difficulty: z.enum(DIFFICULTIES),
    options: z.array(z.string().trim().min(1, 'Options cannot be empty').max(300)).min(2, 'Give at least two options').max(6, 'At most six options'),
    correctIndex: z.number().int().min(0),
    explanation: z.string().trim().max(1000).default(''),
    marks: z.number().int().min(1).max(10),
    active: z.boolean().default(true),
  })
  .strict();

function parseQuestion(body: unknown) {
  const parsed = questionSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest('Some fields are invalid', fieldErrors(parsed.error));
  const data = parsed.data;
  if (data.correctIndex >= data.options.length) throw badRequest('Some fields are invalid', { correctIndex: 'Mark one of the listed options as correct' });
  if (new Set(data.options.map((o) => o.toLowerCase())).size !== data.options.length) {
    throw badRequest('Some fields are invalid', { options: 'Two options are the same' });
  }
  return data;
}

/** Full question including the answer key: only ever returned to faculty. */
export function serializeQuestion(q: QuestionDoc) {
  return {
    id: q.id as string,
    category: q.category,
    text: q.text,
    topic: q.topic,
    difficulty: q.difficulty,
    options: q.options,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    marks: q.marks,
    active: q.active,
    builtIn: Boolean(q.seedKey),
  };
}

export async function listQuestions(filters: { category?: string; active?: boolean; q?: string }) {
  const query: Record<string, unknown> = {};
  if (filters.category) query.category = filters.category;
  if (filters.active !== undefined) query.active = filters.active;
  const questions = await Question.find(query).sort({ category: 1, topic: 1, createdAt: 1 }).limit(2000);
  const needle = filters.q?.trim().toLowerCase();
  return questions.filter((q) => !needle || `${q.text} ${q.topic}`.toLowerCase().includes(needle)).map(serializeQuestion);
}

export async function createQuestion(faculty: UserDoc, body: unknown) {
  const question = await Question.create({ ...parseQuestion(body), updatedBy: faculty._id });
  return serializeQuestion(question);
}

/**
 * Editing a question affects future attempts only: attempts copy their
 * questions when they start, so results already recorded never change.
 */
export async function updateQuestion(faculty: UserDoc, questionId: string, body: unknown) {
  const question = await Question.findById(questionId);
  if (!question) throw notFound('Question not found');
  question.set({ ...parseQuestion(body), updatedBy: faculty._id });
  await question.save();
  return serializeQuestion(question);
}

export async function setQuestionActive(faculty: UserDoc, questionId: string, active: boolean) {
  const question = await Question.findByIdAndUpdate(questionId, { active, updatedBy: faculty._id }, { new: true });
  if (!question) throw notFound('Question not found');
  return serializeQuestion(question);
}

/**
 * Loads the built-in questions that are not in the database yet. Each has a
 * stable key, so this never duplicates a question and never overwrites one
 * that faculty have since edited or deactivated.
 */
export async function ensureQuestionBank() {
  const operations = Object.entries(QUESTION_BANK).flatMap(([category, questions]) =>
    questions.map(([topic, difficulty, text, options, correctIndex, explanation], i) => ({
      updateOne: {
        filter: { seedKey: `${category}:${i + 1}` },
        update: { $setOnInsert: { category, topic, difficulty, text, options, correctIndex, explanation, marks: marksFor(difficulty), active: true } },
        upsert: true,
      },
    })),
  );
  const result = await Question.bulkWrite(operations, { ordered: false });
  return result.upsertedCount;
}

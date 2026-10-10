import { localToday, skillKey, toInstant } from '../catalog.js';
import type { AppContext } from '../context.js';
import { EVALUATION_CRITERIA } from '../domain.js';
import { Activity, Assignment, Event, PerformanceEvaluation, StudentProfile, TestAttempt, type UserDoc } from '../models.js';
import { startAttempt, submitAttempt } from '../services/tests.js';
import { registerAccount } from '../services/accounts.js';
import { ensureQuestionBank } from '../services/questionBank.js';
import { createPromotionRequest } from '../services/promotion.js';

/** Starts a test for the student and answers the given share of it correctly. */
async function takeSampleTest(student: UserDoc, category: Parameters<typeof startAttempt>[1], share: number) {
  const running = await startAttempt(student, category);
  const attempt = await TestAttempt.findById(running.id);
  const answers = attempt!.questions.map((q, i) => ({
    questionId: String(q.questionId),
    selectedIndex: i < Math.round(attempt!.questions.length * share) ? q.correctIndex : (q.correctIndex + 1) % q.options.length,
  }));
  await submitAttempt(student, running.id, { answers });
}

export const DEMO_PASSWORD = 'Voluntrix@123';

/**
 * Development sample data. The past event that gives one student a
 * volunteering history is flagged isSampleData and titled "[DEV SAMPLE]" so
 * it can never be mistaken for real history. Refuses to run in production.
 */
export async function seedDevelopmentData(ctx: AppContext) {
  if (ctx.config.isProduction) throw new Error('Refusing to seed development data in production');
  const domain = ctx.config.facultyEmailDomains[0];
  if (!domain) throw new Error('Set FACULTY_EMAIL_DOMAINS before seeding');
  await ensureQuestionBank();
  const offset = ctx.config.utcOffsetMinutes;
  const day = (n: number) => localToday(offset, Date.now() + n * 86_400_000);
  const eventDay = day(7);

  const faculty = await registerAccount(ctx, {
    fullName: 'Dev Faculty',
    username: 'faculty',
    email: `faculty@${domain}`,
    phone: '9000000001',
    password: DEMO_PASSWORD,
    kind: 'faculty',
    facultyId: ctx.config.facultyIdAllowlist[0]?.toUpperCase() ?? 'FAC-1001',
  });

  // [username, name, skills, preferences, hours available on the event day]
  const students: [string, string, string[], string[], [string, string] | null][] = [
    ['student', 'Dev Student (sample history)', ['Communication', 'Registration Management', 'Leadership'], ['Registration Management'], ['08:00', '18:00']],
    ['student.new', 'Dev Student (no profile yet)', [], [], null],
    ['asha', 'Asha Rao (sample)', ['Technical Support', 'Programming', 'Networking'], ['Technical Support'], ['08:00', '14:00']],
    ['kiran', 'Kiran Shetty (sample)', ['Communication', 'Hospitality', 'Crowd Management'], ['Hospitality'], ['09:00', '18:00']],
    ['meera', 'Meera Nair (sample)', ['Technical Support', 'Photography'], ['Photography and Media', 'Technical Support'], ['08:00', '18:00']],
    ['rahul', 'Rahul Gowda (sample)', ['Communication', 'Registration Management'], ['Registration Management', 'Logistics'], ['08:00', '12:00']],
  ];

  const accounts = new Map<string, Awaited<ReturnType<typeof registerAccount>>>();
  for (const [i, [username, fullName, skills, preferences, hours]] of students.entries()) {
    const user = await registerAccount(ctx, {
      fullName,
      username,
      email: `${username}@example.com`,
      phone: `900000001${i}`,
      password: DEMO_PASSWORD,
      kind: 'student',
      usn: `1VX22CS00${i + 1}`,
    });
    accounts.set(username, user);
    if (!hours) continue;
    await StudentProfile.updateOne(
      { userId: user._id },
      {
        department: 'Computer Science & Engineering',
        semester: 4,
        skills,
        skillKeys: skills.map(skillKey),
        preferences,
        availability: [{ date: eventDay, startTime: hours[0], endTime: hours[1] }],
        maxHoursPerDay: 6,
        profileCompletedAt: new Date(),
      },
    );
  }

  const activity = (eventId: unknown, date: string, name: string, startTime: string, endTime: string, extra: Record<string, unknown>) => ({
    eventId,
    name,
    date,
    startTime,
    endTime,
    startAt: toInstant(date, startTime, offset),
    endAt: toInstant(date, endTime, offset),
    location: 'Main Block',
    requiredCount: 2,
    ...extra,
  });
  const skills = (...names: string[]) => ({ requiredSkills: names, requiredSkillKeys: names.map(skillKey) });

  // An upcoming event, ready for "Generate allocation". The Stage Crew
  // activity is deliberately impossible to staff, to show a shortage report.
  const upcoming = await Event.create({
    name: '[DEV SAMPLE] Freshers Day',
    description: 'Sample event created by the development seed.',
    startDate: eventDay,
    endDate: eventDay,
    venue: 'College Auditorium',
    status: 'published',
    createdBy: faculty._id,
    isSampleData: true,
  });
  await Activity.create([
    activity(upcoming._id, eventDay, 'Registration Desk', '09:00', '11:00', { ...skills('Registration Management'), activityType: 'Registration Management' }),
    activity(upcoming._id, eventDay, 'Technical Support', '09:00', '13:00', { ...skills('Technical Support'), activityType: 'Technical Support' }),
    activity(upcoming._id, eventDay, 'Guest Hospitality', '10:00', '12:00', { ...skills('Hospitality'), activityType: 'Hospitality', requiredCount: 1 }),
    activity(upcoming._id, eventDay, 'Stage Crew', '14:00', '17:00', { ...skills('Stage Management'), requiredCount: 3 }),
  ]);

  // A finished event giving one student a recorded history.
  const withHistory = accounts.get('student')!;
  const pastDay = day(-30);
  const past = await Event.create({
    name: '[DEV SAMPLE] Tech Fest',
    startDate: pastDay,
    endDate: pastDay,
    venue: 'College Auditorium',
    status: 'completed',
    createdBy: faculty._id,
    isSampleData: true,
  });
  const [desk, crowd, stage, mentors] = await Activity.create([
    activity(past._id, pastDay, 'Registration desk', '09:00', '11:00', {}),
    activity(past._id, pastDay, 'Crowd coordination', '11:00', '13:00', {}),
    activity(past._id, pastDay, 'Stage support', '14:00', '15:00', {}),
    activity(past._id, pastDay, 'Mentor liaison', '15:00', '17:00', {}),
  ]);
  const history = async (activityId: unknown, attendance: 'attended' | 'absent', rating?: number, feedback = '') => {
    const assignment = await Assignment.create({ eventId: past._id, activityId, studentId: withHistory._id, status: 'confirmed', source: 'manual', createdBy: faculty._id, attendance });
    if (!rating) return;
    await PerformanceEvaluation.create({
      assignmentId: assignment._id,
      studentId: withHistory._id,
      eventId: past._id,
      activityId,
      reviewerId: faculty._id,
      criteria: Object.fromEntries(EVALUATION_CRITERIA.map((c) => [c, rating])),
      overall: rating,
      feedback,
    });
  };
  await history(desk._id, 'attended', 5, 'Sample feedback: dependable and proactive.');
  await history(crowd._id, 'attended', 3, 'Sample feedback: arrived late but worked well.');
  await history(stage._id, 'absent');
  // Attended but deliberately left without an evaluation, to show the "missing" state.
  await history(mentors._id, 'attended');

  // Sample mock-test results, taken through the real test service so they are
  // marked exactly like a student's own attempt. [username, category, share answered correctly]
  const sampleTests: [string, 'Registration Management' | 'Technical Support' | 'Hospitality' | 'Photography and Media', number][] = [
    ['student', 'Registration Management', 0.75],
    ['rahul', 'Registration Management', 0.9],
    ['asha', 'Technical Support', 0.85],
    ['meera', 'Photography and Media', 0.6],
    ['kiran', 'Hospitality', 0.5],
  ];
  for (const [username, category, share] of sampleTests) await takeSampleTest(accounts.get(username)!, category, share);

  await createPromotionRequest(ctx, withHistory, { statement: 'Sample request created by the development seed.' });

  return {
    password: DEMO_PASSWORD,
    accounts: [
      { role: 'faculty', username: 'faculty', note: 'manages events, allocation and promotions' },
      { role: 'student', username: 'student', note: 'sample history, complete profile, open promotion request' },
      { role: 'student', username: 'student.new', note: 'profile not completed (goes to profile setup)' },
      { role: 'student', username: 'asha / kiran / meera / rahul', note: 'complete profiles, available for the sample event' },
    ],
  };
}

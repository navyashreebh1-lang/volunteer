import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  api,
  errorMessage,
  type AwaitingEvaluation,
  type BankQuestion,
  type Evaluation,
  type EventDetail,
  type EventSummary,
  type PerformanceSummary,
  type TestSettings,
} from '../../api';
import { useAuth } from '../../auth';
import { Alert, Empty, Spinner, formatDate, useLoad } from '../../components';
import { Modal, PageHeader, StatTile, formatDay, useFeedback, useMeta } from '../../ui';
import { LeaderboardPanel } from '../Leaderboard';
import { AuditModal, CriteriaBreakdown, EvaluationModal } from './evaluation';

// ------------------------------------------------------------------ overview

function Overview() {
  const meta = useMeta();
  const [filters, setFilters] = useState({ category: '', q: '', from: '', to: '' });
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { data, error, loading } = useLoad(() => api<PerformanceSummary>(`/faculty/performance${query ? `?${query}` : ''}`), [query]);
  const set = (key: keyof typeof filters, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const [openStudent, setOpenStudent] = useState<string | null>(null);
  const max = Math.max(1, ...(data?.byCategory.map((c) => c.averagePercent ?? 0) ?? []));

  return (
    <div className="stack-lg">
      <div className="filters">
        <select aria-label="Activity" value={filters.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">All activities</option>
          {meta?.activityTypes.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input aria-label="Search student" placeholder="Student name or USN" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        <label className="check">From <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="check">To <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} /></label>
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <dl className="stat-grid">
            <StatTile label="Students tested" value={`${data.participation.studentsTested} / ${data.participation.students}`} note="Have a completed mock test" />
            <StatTile label="Tests completed" value={data.participation.attempts} />
            <StatTile label="Awaiting your evaluation" value={data.participation.awaitingEvaluation} tone={data.participation.awaitingEvaluation ? 'warn' : undefined} />
            <StatTile label="Evaluations completed" value={data.participation.completedEvaluations} />
          </dl>

          <section className="card">
            <h2>Average mock-test score by activity</h2>
            <p className="muted">Average of each student’s qualifying attempt. Categories nobody has taken show no bar.</p>
            <ul className="bars">
              {data.byCategory.map((c) => (
                <li key={c.category} title={c.averagePercent === null ? `${c.category}: no results` : `${c.category}: ${c.averagePercent}% average, ${c.participants} students, ${c.passRate}% passed`}>
                  <span className="bar-label">
                    {c.category}
                    <small>{c.participants ? `${c.participants} student${c.participants === 1 ? '' : 's'} · ${c.passRate}% passed` : 'No results yet'}</small>
                  </span>
                  <span className="bar-track">{c.averagePercent !== null && <span className="bar-fill" style={{ width: `${(c.averagePercent / max) * 100}%` }} />}</span>
                  <span className="bar-value">{c.averagePercent === null ? '—' : `${c.averagePercent}%`}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Students</h2>
            <p className="muted">
              “May be ready” marks students who have attended an activity and average at least 4/5 in their evaluations. It is only a pointer: promotion is still decided by you under{' '}
              <Link to="/faculty/promotions">Promotions</Link>.
            </p>
            {data.students.length === 0 ? (
              <Empty title="No students match" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Student</th><th>Mock tests</th><th>Past performance</th><th className="num">Attended</th><th>Organizer promotion</th></tr>
                  </thead>
                  <tbody>
                    {data.students.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{s.fullName}</strong>
                          <div className="muted">{s.usn}{s.department ? ` · ${s.department}` : ''}</div>
                        </td>
                        <td>
                          {s.results.length === 0 ? (
                            <span className="muted">None taken</span>
                          ) : (
                            <>
                              <button className="link-button" onClick={() => setOpenStudent(openStudent === s.id ? null : s.id)}>
                                {s.testsTaken} taken {openStudent === s.id ? '▴' : '▾'}
                              </button>
                              {openStudent === s.id && (
                                <ul className="plain-list">
                                  {s.results.map((r) => <li key={r.category}>{r.category}: <strong>{r.percent}%</strong> {r.passed ? '(passed)' : '(not passed)'}</li>)}
                                </ul>
                              )}
                            </>
                          )}
                        </td>
                        <td>
                          {s.history.label}
                          {s.history.count > 0 && s.history.provisional && <span className="tag">provisional</span>}
                        </td>
                        <td className="num">{s.attendedCount}</td>
                        <td>
                          {s.promotion.openRequest ? (
                            <span className="badge badge-pending">Request open</span>
                          ) : s.promotion.mayBeReady ? (
                            <span className="badge badge-approved">May be ready</span>
                          ) : (
                            <span className="muted">{s.promotion.notes[0]}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Recent test results</h2>
            {data.recentResults.length === 0 ? (
              <p className="muted">No tests have been completed yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Student</th><th>Activity</th><th>Attempt</th><th>Date</th><th className="num">Score</th><th>Result</th></tr></thead>
                  <tbody>
                    {data.recentResults.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{r.student.fullName}</strong><div className="muted">{r.student.usn}</div></td>
                        <td>{r.category}</td>
                        <td>{r.attemptNumber}</td>
                        <td>{formatDate(r.submittedAt)}</td>
                        <td className="num">{r.percent}%</td>
                        <td>{r.passed ? 'Passed' : 'Not passed'}{r.autoSubmitted && ' (time ran out)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------- evaluations

function Evaluations() {
  const [filters, setFilters] = useState({ eventId: '', activityId: '', q: '', from: '', to: '' });
  const events = useLoad(() => api<{ events: EventSummary[] }>('/manage/events'), []);
  const eventDetail = useLoad(() => (filters.eventId ? api<{ event: EventDetail }>(`/manage/events/${filters.eventId}`) : Promise.resolve(null)), [filters.eventId]);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const suffix = query ? `?${query}` : '';
  const awaiting = useLoad(() => api<{ awaiting: AwaitingEvaluation[] }>(`/manage/evaluations/awaiting${suffix}`), [query]);
  const done = useLoad(() => api<{ evaluations: Evaluation[] }>(`/manage/evaluations${suffix}`), [query]);
  const [evaluating, setEvaluating] = useState<AwaitingEvaluation | null>(null);
  const [correcting, setCorrecting] = useState<Evaluation | null>(null);
  const [auditId, setAuditId] = useState<string | null>(null);
  const set = (key: keyof typeof filters, value: string) => setFilters((f) => ({ ...f, [key]: value, ...(key === 'eventId' ? { activityId: '' } : {}) }));
  const reload = () => {
    void awaiting.reload();
    void done.reload();
  };

  return (
    <div className="stack-lg">
      <div className="filters">
        <select aria-label="Event" value={filters.eventId} onChange={(e) => set('eventId', e.target.value)}>
          <option value="">All events</option>
          {events.data?.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select aria-label="Activity" value={filters.activityId} disabled={!filters.eventId} onChange={(e) => set('activityId', e.target.value)}>
          <option value="">{filters.eventId ? 'All activities' : 'Choose an event first'}</option>
          {eventDetail.data?.event.activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input aria-label="Search student" placeholder="Student name or USN" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        <label className="check">From <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="check">To <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} /></label>
      </div>

      <section className="card">
        <h2>Awaiting your evaluation</h2>
        <p className="muted">Volunteers confirmed on activities that have finished, whom you have not rated yet. Volunteers marked absent are not listed.</p>
        {awaiting.loading && !awaiting.data && <Spinner />}
        {awaiting.error && <Alert kind="error">{awaiting.error}</Alert>}
        {awaiting.data && awaiting.data.awaiting.length === 0 && <Empty title="Nothing waiting">Volunteers appear here after their activity has ended.</Empty>}
        <ul className="candidate-list">
          {awaiting.data?.awaiting.map((a) => (
            <li key={a.assignmentId}>
              <div>
                <strong>{a.student.fullName}</strong> <span className="muted">· {a.student.usn}</span>
                <div className="muted">
                  {a.activity.name} · {a.event.name} · {formatDay(a.activity.date)} · {a.attendance === 'attended' ? 'Attended' : 'Attendance not recorded'}
                </div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setEvaluating(a)}>Evaluate</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Completed evaluations</h2>
        {done.loading && !done.data && <Spinner />}
        {done.error && <Alert kind="error">{done.error}</Alert>}
        {done.data && done.data.evaluations.length === 0 && <Empty title="No evaluations yet" />}
        <ul className="activity-list">
          {done.data?.evaluations.map((e) => (
            <li className="activity-card" key={e.id}>
              <div className="activity-head">
                <div>
                  <strong>{e.student?.fullName}</strong> <span className="muted">· {e.student?.usn}</span>
                </div>
                <span className="score">{e.overall} / 5</span>
              </div>
              <p className="muted">
                {e.activity?.name} · {e.event.name} · by {e.reviewer.name} on {formatDate(e.submittedAt)}
                {e.status === 'corrected' && <span className="tag">corrected</span>}
              </p>
              <details>
                <summary>Ratings and feedback</summary>
                <CriteriaBreakdown criteria={e.criteria} />
                {e.feedback && <p className="quote">{e.feedback}</p>}
              </details>
              <div className="row-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => setCorrecting(e)}>Correct rating</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setAuditId(e.id)}>History</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {evaluating && <EvaluationModal assignmentId={evaluating.assignmentId} title={`Evaluate ${evaluating.student.fullName} — ${evaluating.activity.name}`} onSaved={reload} onClose={() => setEvaluating(null)} />}
      {correcting && <EvaluationModal assignmentId={correcting.assignmentId} existing={correcting} title={`Correct evaluation — ${correcting.student?.fullName}`} onSaved={reload} onClose={() => setCorrecting(null)} />}
      {auditId && <AuditModal evaluationId={auditId} onClose={() => setAuditId(null)} />}
    </div>
  );
}

export function PerformancePage() {
  const { me } = useAuth();
  const faculty = me?.user.role === 'faculty';
  const tabs = [...(faculty ? (['Overview'] as const) : []), 'Rankings', 'Evaluations'] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>(tabs[0]);

  return (
    <div className="page page-wide">
      <PageHeader title="Performance" subtitle="Mock-test results, rankings and post-event evaluations." />
      <div className="tabs" role="tablist" aria-label="Performance sections">
        {tabs.map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} className={`tab${tab === name ? ' tab-active' : ''}`} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      {tab === 'Overview' && <Overview />}
      {tab === 'Rankings' && <LeaderboardPanel manager />}
      {tab === 'Evaluations' && <Evaluations />}
    </div>
  );
}

// ---------------------------------------------------------- question bank

const blankQuestion = (category: string): Omit<BankQuestion, 'id' | 'builtIn'> => ({ category, text: '', topic: '', difficulty: 'medium', options: ['', '', '', ''], correctIndex: 0, explanation: '', marks: 2, active: true });

function QuestionForm({ question, category, onSaved, onClose }: { question?: BankQuestion; category: string; onSaved: () => void; onClose: () => void }) {
  const meta = useMeta();
  const { notify } = useFeedback();
  const [form, setForm] = useState(question ? { ...question } : blankQuestion(category));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (form.text.trim().length < 10) found.text = 'Write the full question (at least 10 characters)';
    if (form.topic.trim().length < 2) found.topic = 'Enter a topic';
    const options = form.options.map((o) => o.trim());
    if (options.some((o) => !o)) found.options = 'Fill in every option, or remove the empty ones';
    else if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) found.options = 'Two options are the same';
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    setFormError(null);
    try {
      const { category: cat, text, topic, difficulty, correctIndex, explanation, marks, active } = form;
      const body = { category: cat, text, topic, difficulty, options, correctIndex, explanation, marks: Number(marks), active };
      await api(question ? `/faculty/questions/${question.id}` : '/faculty/questions', { method: question ? 'PUT' : 'POST', body });
      notify('success', question ? 'Question updated. Tests already started are not affected.' : 'Question added.');
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={question ? 'Edit question' : 'Add question'} onClose={onClose} wide>
      <form className="stack-form" onSubmit={submit} noValidate>
        <div className="field-row field-row-3">
          <div className="field">
            <label htmlFor="q-category">Activity category</label>
            <select id="q-category" value={form.category} onChange={(e) => set('category', e.target.value)}>
              {meta?.activityTypes.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className={`field${errors.topic ? ' field-invalid' : ''}`}>
            <label htmlFor="q-topic">Topic / skill tag</label>
            <input id="q-topic" value={form.topic} onChange={(e) => set('topic', e.target.value)} />
            {errors.topic && <p className="field-error">{errors.topic}</p>}
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="q-difficulty">Difficulty</label>
              <select id="q-difficulty" value={form.difficulty} onChange={(e) => set('difficulty', e.target.value as BankQuestion['difficulty'])}>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div className={`field${errors.marks ? ' field-invalid' : ''}`}>
              <label htmlFor="q-marks">Marks</label>
              <input id="q-marks" type="number" min={1} max={10} value={form.marks} onChange={(e) => set('marks', Number(e.target.value))} />
            </div>
          </div>
        </div>
        <div className={`field${errors.text ? ' field-invalid' : ''}`}>
          <label htmlFor="q-text">Question</label>
          <textarea id="q-text" rows={3} maxLength={1000} value={form.text} onChange={(e) => set('text', e.target.value)} />
          {errors.text && <p className="field-error">{errors.text}</p>}
        </div>
        <fieldset className={`field${errors.options || errors.correctIndex ? ' field-invalid' : ''}`}>
          <legend>Answer options — select the correct one</legend>
          {form.options.map((option, i) => (
            <div className="option-edit" key={i}>
              <input type="radio" name="correct" aria-label={`Option ${i + 1} is correct`} checked={form.correctIndex === i} onChange={() => set('correctIndex', i)} />
              <input aria-label={`Option ${i + 1}`} value={option} maxLength={300} onChange={(e) => set('options', form.options.map((o, j) => (j === i ? e.target.value : o)))} />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={form.options.length <= 2}
                onClick={() => {
                  setForm((f) => ({ ...f, options: f.options.filter((_, j) => j !== i), correctIndex: f.correctIndex === i ? 0 : f.correctIndex > i ? f.correctIndex - 1 : f.correctIndex }));
                }}
              >
                Remove
              </button>
            </div>
          ))}
          {(errors.options || errors.correctIndex) && <p className="field-error">{errors.options || errors.correctIndex}</p>}
          <div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={form.options.length >= 6} onClick={() => set('options', [...form.options, ''])}>Add option</button>
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="q-explanation">Explanation (shown in the answer review)</label>
          <textarea id="q-explanation" rows={2} maxLength={1000} value={form.explanation} onChange={(e) => set('explanation', e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active (can appear in tests)
        </label>
        {formError && <Alert kind="error">{formError}</Alert>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : question ? 'Save changes' : 'Add question'}</button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsForm({ settings, onSaved, onClose }: { settings: TestSettings; onSaved: () => void; onClose: () => void }) {
  const { notify } = useFeedback();
  const [form, setForm] = useState(settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const number = (key: 'durationMinutes' | 'questionCount' | 'passingPercent' | 'maxAttempts', label: string, hint: string, min: number, max: number) => (
    <div className={`field${errors[key] ? ' field-invalid' : ''}`}>
      <label htmlFor={`s-${key}`}>{label}</label>
      <input id={`s-${key}`} type="number" min={min} max={max} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))} />
      <p className={errors[key] ? 'field-error' : 'field-hint'}>{errors[key] ?? hint}</p>
    </div>
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/faculty/test-settings', { method: 'PUT', body: form });
      notify('success', `${settings.category} test settings saved. They apply to tests started from now on.`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${settings.category} — test settings`} onClose={onClose}>
      <form className="stack-form" onSubmit={save} noValidate>
        <div className="field-row">
          {number('durationMinutes', 'Duration (minutes)', '1 to 180', 1, 180)}
          {number('questionCount', 'Questions per test', 'Chosen at random from the active questions', 1, 100)}
        </div>
        <div className="field-row">
          {number('passingPercent', 'Pass mark (%)', '0 means no pass mark', 0, 100)}
          {number('maxAttempts', 'Attempts allowed', 'Per student', 1, 20)}
        </div>
        <div className="field">
          <label htmlFor="s-qualifying">Which attempt counts</label>
          <select id="s-qualifying" value={form.qualifyingAttempt} onChange={(e) => setForm((f) => ({ ...f, qualifyingAttempt: e.target.value as TestSettings['qualifyingAttempt'] }))}>
            <option value="best">The best attempt</option>
            <option value="latest">The latest attempt (a retake replaces the earlier score)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-answers">Show correct answers in the review</label>
          <select id="s-answers" value={form.showAnswers} onChange={(e) => setForm((f) => ({ ...f, showAnswers: e.target.value as TestSettings['showAnswers'] }))}>
            <option value="after_final_attempt">Only after the last attempt</option>
            <option value="always">After every attempt</option>
            <option value="never">Never</option>
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> Test is open to students
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function QuestionsPage() {
  const meta = useMeta();
  const { notify } = useFeedback();
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const chosen = category || meta?.activityTypes[0] || '';
  const query = new URLSearchParams(Object.entries({ category: chosen, active: status, q }).filter(([, v]) => v)).toString();
  const questions = useLoad(() => (chosen ? api<{ questions: BankQuestion[] }>(`/faculty/questions?${query}`) : Promise.resolve(null)), [query, chosen]);
  const settings = useLoad(() => api<{ settings: TestSettings[] }>('/faculty/test-settings'), []);
  const [editing, setEditing] = useState<BankQuestion | 'new' | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const current = settings.data?.settings.find((s) => s.category === chosen);
  const list = questions.data?.questions ?? [];
  const activeCount = list.filter((x) => x.active).length;

  const toggle = async (question: BankQuestion) => {
    try {
      await api(`/faculty/questions/${question.id}/active`, { body: { active: !question.active } });
      notify('success', question.active ? 'Question deactivated. It will not appear in new tests.' : 'Question activated.');
      await questions.reload();
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };

  return (
    <div className="page page-wide">
      <PageHeader title="Question bank" subtitle="The questions and settings behind each activity’s mock test. Correct answers are visible only here.">
        <button className="btn btn-primary" onClick={() => setEditing('new')}>Add question</button>
      </PageHeader>
      <div className="filters">
        <select aria-label="Activity category" value={chosen} onChange={(e) => setCategory(e.target.value)}>
          {meta?.activityTypes.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Active and inactive</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </select>
        <input aria-label="Search questions" placeholder="Search question text or topic" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {current && (
        <section className="card">
          <div className="card-head">
            <h2>{chosen} test</h2>
            <button className="btn btn-secondary" onClick={() => setEditingSettings(true)}>Edit settings</button>
          </div>
          <p>
            {current.active ? 'Open to students' : <strong className="issue-text">Closed to students</strong>} · {current.questionCount} questions · {current.durationMinutes} minutes · pass mark{' '}
            {current.passingPercent}% · {current.maxAttempts} attempt{current.maxAttempts === 1 ? '' : 's'} · {current.qualifyingAttempt} attempt counts
          </p>
          {!status && !q && activeCount < current.questionCount && (
            <Alert kind="warn">
              Only {activeCount} active question{activeCount === 1 ? '' : 's'} for a {current.questionCount}-question test. Tests will use the {activeCount} available.
            </Alert>
          )}
        </section>
      )}

      {questions.loading && !questions.data && <Spinner />}
      {questions.error && <Alert kind="error">{questions.error}</Alert>}
      {questions.data && list.length === 0 && <Empty title="No questions found" />}
      <ul className="activity-list">
        {list.map((question) => (
          <li className={`activity-card${question.active ? '' : ' card-inactive'}`} key={question.id}>
            <div className="activity-head">
              <strong>{question.text}</strong>
              <span className={`badge ${question.active ? 'badge-approved' : ''}`}>{question.active ? 'Active' : 'Inactive'}</span>
            </div>
            <p className="muted">
              {question.topic} · {question.difficulty} · {question.marks} mark{question.marks === 1 ? '' : 's'}{question.builtIn && ' · built-in'}
            </p>
            <ol className="bank-options">
              {question.options.map((option, i) => (
                <li key={i} className={i === question.correctIndex ? 'opt-correct' : undefined}>
                  {option}
                  {i === question.correctIndex && <span className="tag tag-ok">correct</span>}
                </li>
              ))}
            </ol>
            {question.explanation && <p className="muted">Explanation: {question.explanation}</p>}
            <div className="row-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(question)}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => toggle(question)}>{question.active ? 'Deactivate' : 'Activate'}</button>
            </div>
          </li>
        ))}
      </ul>

      {editing && <QuestionForm question={editing === 'new' ? undefined : editing} category={chosen} onSaved={questions.reload} onClose={() => setEditing(null)} />}
      {editingSettings && current && <SettingsForm settings={current} onSaved={settings.reload} onClose={() => setEditingSettings(false)} />}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, errorMessage, type AttemptResult, type AttemptSummary, type Evaluation, type MyRank, type RunningAttempt, type TestCard } from '../../api';
import { Alert, Empty, Spinner, formatDate, useLoad } from '../../components';
import { PageHeader, StatTile, formatDay, useFeedback } from '../../ui';
import { LeaderboardPanel } from '../Leaderboard';
import { CriteriaBreakdown } from '../manage/evaluation';

const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

// ----------------------------------------------------------- test selection

export function TestsPage() {
  const navigate = useNavigate();
  const { notify, confirm } = useFeedback();
  const { data, error, loading } = useLoad(() => api<{ tests: TestCard[]; ranks: MyRank[] }>('/student/tests'), []);
  const history = useLoad(() => api<{ attempts: AttemptSummary[] }>('/student/attempts'), []);
  const [starting, setStarting] = useState<string | null>(null);

  const begin = async (test: TestCard) => {
    const answer = await confirm({
      title: `Start the ${test.category} test?`,
      message: `${test.questionCount} questions in ${test.durationMinutes} minutes. The timer starts now and keeps running even if you close the page. This will use attempt ${test.attemptsUsed + 1} of ${test.maxAttempts}.`,
      confirmLabel: 'Start test',
    });
    if (!answer.ok) return;
    setStarting(test.category);
    try {
      const res = await api<{ attempt: RunningAttempt }>('/student/tests/start', { body: { category: test.category } });
      navigate(`/student/tests/${res.attempt.id}`);
    } catch (err) {
      notify('error', errorMessage(err));
      setStarting(null);
    }
  };

  const mine = (data?.tests ?? []).filter((x) => x.preferred);
  const others = (data?.tests ?? []).filter((x) => !x.preferred);
  const rankOf = (category: string) => data?.ranks.find((r) => r.category === category);

  const card = (test: TestCard) => {
    const rank = rankOf(test.category);
    return (
      <li className="activity-card" key={test.category}>
        <div className="activity-head">
          <strong>{test.category}</strong>
          {test.qualifying ? (
            <span className={`badge ${test.qualifying.passed ? 'badge-approved' : 'badge-needs_review'}`}>
              {test.qualifying.percent}% · {test.qualifying.passed ? 'Passed' : 'Not passed'}
            </span>
          ) : test.inProgressAttemptId ? (
            <span className="badge badge-pending">In progress</span>
          ) : (
            <span className="badge">Not taken</span>
          )}
        </div>
        <p className="muted">
          {test.questionCount} questions · {test.durationMinutes} min · pass mark {test.passingPercent}% · attempts {test.attemptsUsed} of {test.maxAttempts} used
          {test.maxAttempts > 1 && ` · ${test.qualifyingAttempt === 'best' ? 'best' : 'latest'} attempt counts`}
        </p>
        {rank?.rank && (
          <p>
            Leaderboard position: <strong>{rank.rank}</strong> of {rank.total} · <Link to={`/student/leaderboard?category=${encodeURIComponent(test.category)}`}>view ranking</Link>
          </p>
        )}
        {test.blockedReason && <p className="issue-text">{test.blockedReason}</p>}
        <div className="row-actions">
          {test.inProgressAttemptId && <Link className="btn btn-primary btn-sm" to={`/student/tests/${test.inProgressAttemptId}`}>Resume test</Link>}
          {test.canStart && (
            <button className="btn btn-primary btn-sm" disabled={starting !== null} onClick={() => begin(test)}>
              {starting === test.category ? 'Starting…' : test.attemptsUsed ? 'Retake test' : 'Start test'}
            </button>
          )}
          {test.latest && <Link className="btn btn-secondary btn-sm" to={`/student/tests/${test.latest.id}`}>View latest result</Link>}
          {test.allowed && !test.canStart && !test.inProgressAttemptId && test.attemptsLeft === 0 && <span className="muted">No attempts left</span>}
        </div>
      </li>
    );
  };

  return (
    <div className="page">
      <PageHeader title="Mock tests" subtitle="Short tests for the activities you prefer. Your result is one of the things organizers see when ranking volunteers." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <section className="card">
            <h2>Your preferred activities</h2>
            {mine.length === 0 ? (
              <Empty title="No preferred activities yet">
                Choose the activity types you would like to volunteer for in <Link to="/student/profile">your profile</Link> to unlock their tests.
              </Empty>
            ) : (
              <ul className="activity-list">{mine.map(card)}</ul>
            )}
          </section>
          {others.length > 0 && (
            <section className="card card-muted">
              <h2>Other activities</h2>
              <p className="muted">Add any of these to your preferences in <Link to="/student/profile">your profile</Link> to take its test.</p>
              <ul className="plain-list">{others.map((o) => <li key={o.category}>{o.category}</li>)}</ul>
            </section>
          )}
          <section className="card">
            <h2>Test history</h2>
            {history.data?.attempts.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Activity</th><th>Attempt</th><th>Date</th><th className="num">Score</th><th>Result</th><th /></tr></thead>
                  <tbody>
                    {history.data.attempts.map((a) => (
                      <tr key={a.id}>
                        <td>{a.category}</td>
                        <td>{a.attemptNumber}</td>
                        <td>{formatDate(a.submittedAt ?? a.startedAt)}</td>
                        <td className="num">{a.result ? `${a.result.percent}%` : '—'}</td>
                        <td>{a.status === 'in_progress' ? 'In progress' : a.result?.passed ? 'Passed' : 'Not passed'}{a.autoSubmitted && ' (time ran out)'}</td>
                        <td><Link to={`/student/tests/${a.id}`}>{a.status === 'in_progress' ? 'Resume' : 'Review'}</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">You have not taken any tests yet.</p>
            )}
          </section>
          <p className="muted">
            These tests are a practice aid, not a proctored exam. Answers are marked on the server and the timer cannot be changed from your device, but nothing stops someone looking things up.
          </p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- test taking

type SaveState = 'saved' | 'saving' | 'failed';

function TestRunner({ attempt, onFinished }: { attempt: RunningAttempt; onFinished: (result: AttemptResult) => void }) {
  const { notify, confirm } = useFeedback();
  const [questions, setQuestions] = useState(attempt.questions);
  const [index, setIndex] = useState(0);
  // The countdown is only a display. The deadline is enforced by the server.
  const endsAt = useRef(Date.now() + attempt.remainingSeconds * 1000);
  const [remaining, setRemaining] = useState(attempt.remainingSeconds);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [submitting, setSubmitting] = useState(false);
  const submitted = useRef(false);
  const latest = useRef(questions);
  latest.current = questions;

  const submit = useCallback(
    async (automatic: boolean) => {
      if (submitted.current) return;
      submitted.current = true;
      setSubmitting(true);
      const answers = latest.current.map((q) => ({ questionId: q.questionId, selectedIndex: q.selectedIndex, markedForReview: q.markedForReview }));
      try {
        const res = await api<{ result: AttemptResult }>(`/student/attempts/${attempt.id}/submit`, { body: { answers } });
        notify('success', automatic ? 'Time is up. Your test was submitted automatically.' : 'Test submitted.');
        onFinished(res.result);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Already closed (for example the time ran out first): show the stored result.
          const closed = await api<{ result?: AttemptResult }>(`/student/attempts/${attempt.id}`).catch(() => null);
          if (closed?.result) {
            notify('success', 'Your test had already been closed. Showing the recorded result.');
            return onFinished(closed.result);
          }
        }
        submitted.current = false;
        setSubmitting(false);
        notify('error', `Your test could not be submitted: ${errorMessage(err)}. Your saved answers are safe; try again.`);
      }
    },
    [attempt.id, notify, onFinished],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((endsAt.current - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(timer);
        void submit(true);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [submit]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!submitted.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Each change is saved straight away, so an interruption loses nothing.
  const update = async (questionId: string, patch: { selectedIndex?: number | null; markedForReview?: boolean }) => {
    const next = latest.current.map((q) => (q.questionId === questionId ? { ...q, ...patch } : q));
    setQuestions(next);
    const changed = next.find((q) => q.questionId === questionId)!;
    setSaveState('saving');
    try {
      await api(`/student/attempts/${attempt.id}/answers`, {
        method: 'PUT',
        body: { answers: [{ questionId, selectedIndex: changed.selectedIndex, markedForReview: changed.markedForReview }] },
      });
      setSaveState('saved');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return void submit(true);
      setSaveState('failed');
    }
  };

  const answered = questions.filter((q) => q.selectedIndex !== null).length;
  const marked = questions.filter((q) => q.markedForReview).length;
  const current = questions[index];

  const askSubmit = async () => {
    const unanswered = questions.length - answered;
    const answer = await confirm({
      title: 'Submit your test?',
      message: `${answered} of ${questions.length} answered${unanswered ? `, ${unanswered} unanswered` : ''}${marked ? `, ${marked} marked for review` : ''}. You cannot change your answers after submitting.`,
      confirmLabel: 'Submit test',
    });
    if (answer.ok) void submit(false);
  };

  return (
    <div className="page page-wide test-page">
      <header className="test-bar">
        <div>
          <h1>{attempt.category} mock test</h1>
          <p className="muted">
            Attempt {attempt.attemptNumber} · pass mark {attempt.passingPercent}% · choose one answer per question. Answers save automatically.
          </p>
        </div>
        <div className={`timer${remaining <= 60 ? ' timer-low' : ''}`} role="timer" aria-live={remaining <= 60 ? 'polite' : 'off'}>
          <span>Time left</span>
          <strong>{clock(remaining)}</strong>
        </div>
      </header>

      <div className="progress" role="progressbar" aria-valuenow={answered} aria-valuemin={0} aria-valuemax={questions.length} aria-label="Questions answered">
        <span style={{ width: `${(answered / questions.length) * 100}%` }} />
      </div>
      <p className="muted test-status">
        {answered} of {questions.length} answered · {marked} marked for review ·{' '}
        <span className={saveState === 'failed' ? 'issue-text' : undefined}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'failed' ? 'Last change not saved — check your connection' : 'All answers saved'}
        </span>
      </p>

      <div className="test-layout">
        <section className="card question-card" aria-live="polite">
          <div className="card-head">
            <h2>
              Question {index + 1} <span className="muted">of {questions.length}</span>
            </h2>
            <span className="muted">
              {current.topic} · {current.marks} mark{current.marks === 1 ? '' : 's'}
            </span>
          </div>
          <p className="question-text">{current.text}</p>
          <div className="options" role="radiogroup" aria-label={`Question ${index + 1}`}>
            {current.options.map((option, i) => (
              <label key={i} className={`option${current.selectedIndex === i ? ' option-on' : ''}`}>
                <input type="radio" name={`q-${current.questionId}`} checked={current.selectedIndex === i} disabled={submitting} onChange={() => update(current.questionId, { selectedIndex: i })} />
                <span>{option}</span>
              </label>
            ))}
          </div>
          <div className="question-actions">
            <label className="check">
              <input type="checkbox" checked={current.markedForReview} disabled={submitting} onChange={(e) => update(current.questionId, { markedForReview: e.target.checked })} /> Mark for review
            </label>
            <button className="btn btn-ghost btn-sm" disabled={submitting || current.selectedIndex === null} onClick={() => update(current.questionId, { selectedIndex: null })}>
              Clear answer
            </button>
            <span className="spacer" />
            <button className="btn btn-secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</button>
            <button className="btn btn-secondary" disabled={index === questions.length - 1} onClick={() => setIndex(index + 1)}>Next</button>
          </div>
        </section>

        <aside className="card question-nav">
          <h3>Questions</h3>
          <div className="question-grid">
            {questions.map((q, i) => (
              <button
                key={q.questionId}
                className={`qnum${q.selectedIndex !== null ? ' qnum-answered' : ''}${q.markedForReview ? ' qnum-marked' : ''}${i === index ? ' qnum-current' : ''}`}
                aria-label={`Question ${i + 1}: ${q.selectedIndex !== null ? 'answered' : 'not answered'}${q.markedForReview ? ', marked for review' : ''}`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <ul className="legend">
            <li><span className="qnum qnum-answered qnum-key" /> Answered</li>
            <li><span className="qnum qnum-key" /> Not answered</li>
            <li><span className="qnum qnum-marked qnum-key" /> Marked</li>
          </ul>
          <button className="btn btn-primary btn-block" disabled={submitting} onClick={askSubmit}>
            {submitting ? 'Submitting…' : 'Submit test'}
          </button>
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ results

function ResultView({ result }: { result: AttemptResult }) {
  const r = result.result!;
  const minutes = result.durationSeconds === null ? null : clock(result.durationSeconds);
  return (
    <div className="page">
      <Link to="/student/tests" className="back-link">← All mock tests</Link>
      <PageHeader title={`${result.category} — result`} subtitle={`Attempt ${result.attemptNumber} · completed ${formatDate(result.submittedAt)}${minutes ? ` in ${minutes}` : ''}`} />
      {result.autoSubmitted && <Alert kind="warn">The time ran out, so this attempt was closed automatically with the answers saved up to then.</Alert>}
      <Alert kind={r.passed ? 'success' : 'warn'}>
        <strong>{r.passed ? 'Passed' : 'Not passed'}</strong> — you scored {r.percent}% (pass mark {result.passingPercent}%).
        {result.attemptsLeft > 0 ? ` You have ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.` : ' You have no attempts left for this test.'}
      </Alert>
      <dl className="stat-grid">
        <StatTile label="Score" value={`${r.percent}%`} note={`${r.marksObtained} of ${r.totalMarks} marks`} />
        <StatTile label="Correct" value={r.correct} />
        <StatTile label="Incorrect" value={r.incorrect} />
        <StatTile label="Unanswered" value={r.unanswered} />
      </dl>

      <section className="card">
        <h2>Performance by topic</h2>
        <ul className="bars">
          {result.topics.map((topic) => (
            <li key={topic.topic} title={`${topic.topic}: ${topic.marksObtained} of ${topic.totalMarks} marks`}>
              <span className="bar-label">{topic.topic}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${topic.percent}%` }} /></span>
              <span className="bar-value">{topic.marksObtained}/{topic.totalMarks}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Suggestions</h2>
        <ul className="plain-list">{result.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
      </section>

      <section className="card">
        <h2>Answer review</h2>
        {!result.answersRevealed && (
          <Alert kind="info">Correct answers and explanations are shown once you have no attempts left, so a retake stays a fair test.</Alert>
        )}
        <ol className="review-questions">
          {result.review.map((q, i) => (
            <li key={i} className={q.selectedIndex === null ? 'review-skipped' : q.correct ? 'review-right' : 'review-wrong'}>
              <div className="card-head">
                <strong>{q.text}</strong>
                <span className={`badge ${q.selectedIndex === null ? '' : q.correct ? 'badge-approved' : 'badge-rejected'}`}>{q.selectedIndex === null ? 'Not answered' : q.correct ? 'Correct' : 'Incorrect'}</span>
              </div>
              <ul className="review-options">
                {q.options.map((option, j) => (
                  <li key={j} className={`${q.correctIndex === j ? 'opt-correct' : ''}${q.selectedIndex === j ? ' opt-chosen' : ''}`}>
                    {option}
                    {q.selectedIndex === j && <span className="tag">your answer</span>}
                    {q.correctIndex === j && <span className="tag tag-ok">correct answer</span>}
                  </li>
                ))}
              </ul>
              {q.explanation && <p className="quote">{q.explanation}</p>}
            </li>
          ))}
        </ol>
      </section>
      <div className="row-actions">
        <Link className="btn btn-primary" to="/student/tests">Back to mock tests</Link>
        <Link className="btn btn-secondary" to={`/student/leaderboard?category=${encodeURIComponent(result.category)}`}>See the ranking</Link>
      </div>
    </div>
  );
}

/** One route for an attempt: the test itself while it is running, its result afterwards. */
export function AttemptPage() {
  const { id } = useParams();
  const { data, error, loading } = useLoad(() => api<{ running?: RunningAttempt; result?: AttemptResult }>(`/student/attempts/${id}`), [id]);
  const [finished, setFinished] = useState<AttemptResult | null>(null);
  useEffect(() => setFinished(null), [id]);

  if (finished) return <ResultView result={finished} />;
  if (loading && !data) return <div className="page"><Spinner label="Loading test…" /></div>;
  if (error && !data) return <div className="page"><Alert kind="error">{error}</Alert><Link to="/student/tests">Back to mock tests</Link></div>;
  if (data?.running) return <TestRunner key={data.running.id} attempt={data.running} onFinished={setFinished} />;
  if (data?.result) return <ResultView result={data.result} />;
  return null;
}

// ------------------------------------------------------ leaderboard, feedback

export function StudentLeaderboardPage() {
  const category = new URLSearchParams(window.location.search).get('category') ?? undefined;
  return (
    <div className="page page-wide">
      <PageHeader title="Leaderboard" subtitle="How volunteers rank for each activity, among those who have taken its mock test." />
      <LeaderboardPanel manager={false} initialCategory={category} />
    </div>
  );
}

export function FeedbackPage() {
  const { data, error, loading } = useLoad(() => api<{ evaluations: Evaluation[]; average: number | null; count: number }>('/student/evaluations'), []);
  return (
    <div className="page">
      <PageHeader title="My feedback" subtitle="Evaluations from organizers after the activities you volunteered at." />
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <dl className="stat-grid">
            <StatTile label="Evaluations" value={data.count} />
            <StatTile label="Average rating" value={data.average === null ? '—' : `${data.average} / 5`} note={data.count ? undefined : 'No history yet'} />
          </dl>
          {data.evaluations.length === 0 && <Empty title="No feedback yet">After you volunteer at an activity, the organizer’s evaluation appears here.</Empty>}
          {data.evaluations.map((e) => (
            <section className="card" key={e.id}>
              <div className="card-head">
                <h2>{e.activity?.name ?? 'Activity'} <span className="muted">· {e.event.name}</span></h2>
                <span className="score">{e.overall} / 5</span>
              </div>
              <p className="muted">
                {e.activity && `${formatDay(e.activity.date)} · `}Evaluated by {e.reviewer.name} ({e.reviewer.role}) on {formatDate(e.submittedAt)}
                {e.status === 'corrected' && ` · corrected ${formatDate(e.updatedAt)}`}
              </p>
              <CriteriaBreakdown criteria={e.criteria} />
              {e.feedback && <p className="quote">{e.feedback}</p>}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

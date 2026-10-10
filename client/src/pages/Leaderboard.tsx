import { useEffect, useState } from 'react';
import { api, errorMessage, type EventDetail, type EventSummary, type Leaderboard } from '../api';
import { Alert, Empty, Spinner, useLoad } from '../components';
import { Chips, useMeta } from '../ui';

const REFRESH_MS = 10_000;

/**
 * The ranking for one activity category. It is recomputed on the server at
 * every request and re-fetched every few seconds while the page is open, so
 * a new submission or rating shows up without reloading.
 *
 * Organizers can also rank against a specific activity, which checks every
 * candidate against that activity's mandatory requirements.
 */
export function LeaderboardPanel({ manager, initialCategory }: { manager: boolean; initialCategory?: string }) {
  const meta = useMeta();
  const [category, setCategory] = useState(initialCategory ?? '');
  const [eventId, setEventId] = useState('');
  const [activityId, setActivityId] = useState('');
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [eligible, setEligible] = useState('');
  const [data, setData] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const events = useLoad(() => (manager ? api<{ events: EventSummary[] }>('/manage/events') : Promise.resolve(null)), [manager]);
  const eventDetail = useLoad(() => (eventId ? api<{ event: EventDetail }>(`/manage/events/${eventId}`) : Promise.resolve(null)), [eventId]);
  const activities = eventDetail.data?.event.activities.filter((a) => a.activityType) ?? [];

  useEffect(() => {
    if (!category && meta) setCategory(initialCategory ?? meta.activityTypes[0]);
  }, [meta, category, initialCategory]);

  const params = new URLSearchParams();
  if (activityId) params.set('activityId', activityId);
  else if (category) params.set('category', category);
  if (minScore) params.set('minScore', minScore);
  if (maxScore) params.set('maxScore', maxScore);
  if (eligible) params.set('eligible', eligible);
  const query = params.toString();

  useEffect(() => {
    if (!category && !activityId) return;
    let live = true;
    const load = async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      try {
        const board = await api<Leaderboard>(`/leaderboard?${query}`);
        if (live) {
          setData(board);
          setError(null);
        }
      } catch (err) {
        if (live) setError(errorMessage(err));
      } finally {
        if (live) setLoading(false);
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [query, category, activityId]);

  return (
    <div className="stack-lg">
      <div className="filters">
        <select aria-label="Activity category" value={category} disabled={Boolean(activityId)} onChange={(e) => setCategory(e.target.value)}>
          {meta?.activityTypes.map((t) => <option key={t}>{t}</option>)}
        </select>
        {manager && (
          <>
            <select aria-label="Event" value={eventId} onChange={(e) => { setEventId(e.target.value); setActivityId(''); }}>
              <option value="">Any event (category ranking)</option>
              {events.data?.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <select aria-label="Activity" value={activityId} disabled={!eventId} onChange={(e) => setActivityId(e.target.value)}>
              <option value="">{eventId ? (activities.length ? 'Choose an activity' : 'No activities with a type') : 'Choose an event first'}</option>
              {activities.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.activityType})</option>)}
            </select>
            <input aria-label="Minimum score" type="number" min={0} max={100} placeholder="Min score" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
            <input aria-label="Maximum score" type="number" min={0} max={100} placeholder="Max score" value={maxScore} onChange={(e) => setMaxScore(e.target.value)} />
            <select aria-label="Eligibility" value={eligible} onChange={(e) => setEligible(e.target.value)}>
              <option value="">Any eligibility</option>
              <option value="true">Eligible only</option>
              <option value="false">Not eligible only</option>
            </select>
          </>
        )}
      </div>

      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <section className="card">
          <div className="card-head">
            <h2>{data.activity ? `${data.activity.name} — ${data.activity.eventName}` : data.category}</h2>
            <span className="muted live-note">
              <span className="live-dot" aria-hidden="true" /> Updates every {REFRESH_MS / 1000} s · {data.total} ranked
            </span>
          </div>
          <p className="muted">
            Overall score = mock test {data.weights.test}% + skill match {data.weights.skills}% + past performance {data.weights.history}%. Volunteers with no past evaluations get a
            neutral {data.historyPolicy.neutralBaseline}/100 for past performance, marked “provisional”, so they are not ranked down for being new.
          </p>
          <p>
            <span className="muted">Skills counted for the skill match: </span>
            <Chips items={data.relevantSkills} empty="None" />
          </p>
          {!manager && data.myRank && <Alert kind="info">Your position: <strong>{data.myRank}</strong> of {data.total}.</Alert>}

          {data.entries.length === 0 ? (
            <Empty title={data.total ? 'Nobody matches these filters' : 'No results yet'}>
              {data.total ? undefined : 'Students appear here once they complete this category’s mock test.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Student</th>
                    <th className="num">Mock test</th>
                    <th className="num">Skill match</th>
                    <th>Past performance</th>
                    <th className="num">Overall</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={`${e.rank}-${e.displayName}`} className={e.isMe ? 'row-me' : undefined}>
                      <td><span className={`rank${e.rank <= 3 ? ' rank-top' : ''}`}>{e.rank}</span></td>
                      <td>
                        <strong>{e.displayName}</strong>
                        {e.isMe && <span className="tag">you</span>}
                        {manager && <div className="muted">{e.usn}{e.department ? ` · ${e.department}` : ''}</div>}
                      </td>
                      <td className="num">{e.testPercent}%</td>
                      <td className="num">{e.skillMatch}%</td>
                      <td>
                        {e.history.label}
                        {e.history.provisional && <span className="tag">provisional</span>}
                        <div className="muted">{e.history.score}/100</div>
                      </td>
                      <td className="num"><span className="score">{e.overall}</span></td>
                      <td>
                        <span className={`badge ${e.eligible ? 'badge-approved' : 'badge-needs_review'}`}>{e.eligibility}</span>
                        {manager && e.reasons && e.reasons.length > 0 && <ul className="reasons">{e.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {manager && (
            <p className="muted">
              This is a ranking, not an assignment. A high score never overrides the mandatory requirements; assignments are made and confirmed on the event page.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

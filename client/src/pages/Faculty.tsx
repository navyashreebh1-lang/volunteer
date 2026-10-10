import { useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, type Decision, type PromotionDetail, type PromotionListItem, type PromotionStatus } from '../api';
import { Alert, Avatar, Empty, Spinner, StatusBadge, formatDate, useLoad } from '../components';

const FILTERS: { value: PromotionStatus | 'all'; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

const ATTENDANCE_LABELS = { attended: 'Attended', absent: 'Absent', not_recorded: 'Not recorded' };
const AUDIT_LABELS: Record<string, string> = {
  organizer_promotion: 'Promoted to organizer',
  organizer_revoked: 'Organizer role removed',
};
const DECISION_BUTTONS: { decision: Decision; label: string; className: string }[] = [
  { decision: 'approve', label: 'Approve promotion', className: 'btn btn-primary' },
  { decision: 'needs_review', label: 'Request further review', className: 'btn btn-secondary' },
  { decision: 'reject', label: 'Reject', className: 'btn btn-danger' },
];

export function FacultyPage() {
  const [filter, setFilter] = useState<PromotionStatus | 'all'>('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useLoad(
    () => api<{ requests: PromotionListItem[] }>(`/faculty/promotion-requests${filter === 'all' ? '' : `?status=${filter}`}`),
    [filter],
  );

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1>Organizer promotions</h1>
          <p className="muted">Review each student’s record and decide. Nothing is promoted automatically.</p>
        </div>
        <Nominate onCreated={list.reload} />
      </header>

      <div className="split">
        <section className="card split-list" aria-label="Promotion requests">
          <div className="tabs tabs-wrap" role="tablist" aria-label="Request status">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                role="tab"
                aria-selected={filter === f.value}
                className={`tab${filter === f.value ? ' tab-active' : ''}`}
                onClick={() => {
                  setFilter(f.value);
                  setSelectedId(null);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {list.loading && <Spinner />}
          {list.error && <Alert kind="error">{list.error}</Alert>}
          {!list.loading && list.data?.requests.length === 0 && (
            <Empty title="No requests here">Requests appear when a student asks for a promotion or you nominate one.</Empty>
          )}
          <ul className="request-list">
            {list.data?.requests.map((r) => (
              <li key={r.id}>
                <button className={`request-row${selectedId === r.id ? ' request-row-active' : ''}`} onClick={() => setSelectedId(r.id)}>
                  <Avatar user={r.student} />
                  <span className="request-row-main">
                    <strong>{r.student.fullName}</strong>
                    <span className="muted">
                      {r.student.usn ?? 'No USN'} · {formatDate(r.createdAt)}
                    </span>
                  </span>
                  <StatusBadge status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="split-detail">
          {selectedId ? (
            <RequestDetail key={selectedId} id={selectedId} onDecided={list.reload} />
          ) : (
            <div className="card">
              <Empty title="Select a request">Choose a student from the list to see their profile, evidence and history.</Empty>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Nominate({ onCreated }: { onCreated: () => void }) {
  const [usn, setUsn] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!usn.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      await api('/promotion-requests', { body: { usn: usn.trim() } });
      setMessage({ kind: 'success', text: 'Request opened for review.' });
      setUsn('');
      onCreated();
    } catch (err) {
      const fieldError = err instanceof ApiError ? err.fields.usn : undefined;
      setMessage({ kind: 'error', text: fieldError ?? errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="nominate" onSubmit={submit}>
      <label htmlFor="nominate-usn">Nominate a student</label>
      <div className="nominate-row">
        <input id="nominate-usn" placeholder="Student USN" value={usn} onChange={(e) => setUsn(e.target.value)} />
        <button className="btn btn-secondary" disabled={busy || !usn.trim()}>
          {busy ? 'Opening…' : 'Open request'}
        </button>
      </div>
      {message && <p className={message.kind === 'error' ? 'field-error' : 'field-hint'}>{message.text}</p>}
    </form>
  );
}

function RequestDetail({ id, onDecided }: { id: string; onDecided: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api<{ request: PromotionDetail }>(`/faculty/promotion-requests/${id}`), [id]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);
  const [result, setResult] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  if (loading && !data) return <div className="card"><Spinner label="Loading request…" /></div>;
  if (error && !data) return <div className="card"><Alert kind="error">{error}</Alert></div>;
  if (!data) return null;

  const r = data.request;
  const { summary, records } = r.evidence;
  const approvalBlocked = !r.eligibility.eligible && r.policy.enforceOnApproval;

  const decide = async (decision: Decision) => {
    if (reason.trim().length < 5) {
      setResult({ kind: 'error', text: 'A review reason of at least 5 characters is required for every decision.' });
      return;
    }
    setBusy(decision);
    setResult(null);
    try {
      await api(`/faculty/promotion-requests/${id}/decision`, { body: { decision, reason: reason.trim() } });
      setResult({
        kind: 'success',
        text:
          decision === 'approve'
            ? `${r.student.fullName} is now an organizer and has been notified.`
            : decision === 'reject'
              ? 'Request rejected. The student has been notified.'
              : 'Marked as needing further review. The student has been notified.',
      });
      setReason('');
      await reload();
      onDecided();
    } catch (err) {
      setResult({ kind: 'error', text: errorMessage(err) });
      // The request may have been decided by someone else in the meantime.
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack-lg">
      <div className="card">
        <div className="review-person">
          <Avatar user={r.student} />
          <div>
            <h2>{r.student.fullName}</h2>
            <p className="muted">
              USN {r.student.usn ?? '—'} · @{r.student.username} · {r.student.email}
            </p>
            <p className="muted">
              Member since {formatDate(r.student.memberSince)} · current role: {r.student.role}
            </p>
          </div>
          <StatusBadge status={r.status} />
        </div>
        {r.statement && <p className="quote">“{r.statement}”</p>}
      </div>

      <div className="card">
        <h3>Attendance and feedback evidence</h3>
        {summary.containsTestData && (
          <Alert kind="warn">
            <strong>Development sample data.</strong> Records marked “sample” were created by the development seed and are not real volunteering history.
          </Alert>
        )}
        <dl className="stats">
          <div>
            <dt>Events on record</dt>
            <dd>{summary.recordedEvents}</dd>
          </div>
          <div>
            <dt>Attended</dt>
            <dd>
              {summary.attendedEvents}
              {summary.attendanceRate !== null && <small> ({Math.round(summary.attendanceRate * 100)}%)</small>}
            </dd>
          </div>
          <div>
            <dt>Average rating</dt>
            <dd>{summary.averageRating === null ? <span className="missing">No feedback</span> : `${summary.averageRating.toFixed(1)} / 5`}</dd>
          </div>
          <div>
            <dt>Feedback entries</dt>
            <dd>{summary.feedbackCount}</dd>
          </div>
        </dl>
        {summary.attendedEventsMissingFeedback > 0 && (
          <Alert kind="info">
            Feedback is missing for {summary.attendedEventsMissingFeedback} attended event{summary.attendedEventsMissingFeedback === 1 ? '' : 's'}. Missing feedback
            is not counted as positive or negative.
          </Alert>
        )}

        {records.length === 0 ? (
          <Empty title="No attendance or feedback on record">
            There is no volunteering evidence for this student yet. The absence of records is not a positive signal.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Date</th>
                  <th>Attendance</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody>
                {records.map((rec) => (
                  <tr key={rec.id}>
                    <td>
                      <strong>{rec.eventTitle}</strong>
                      {rec.isTestData && <span className="tag">sample</span>}
                      <div className="muted">{rec.roleTitle}</div>
                    </td>
                    <td>{formatDate(rec.eventDate)}</td>
                    <td>
                      <span className={`attendance attendance-${rec.status}`}>{ATTENDANCE_LABELS[rec.status]}</span>
                    </td>
                    <td>
                      {rec.feedback ? (
                        <>
                          <strong>{rec.feedback.rating} / 5</strong>
                          {rec.feedback.comments && <div className="muted">{rec.feedback.comments}</div>}
                        </>
                      ) : (
                        <span className="missing">{rec.status === 'attended' ? 'Missing — not recorded' : 'None recorded'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Only meaningful while a decision is still open; afterwards the role has changed. */}
      <div className="card" hidden={r.allowedDecisions.length === 0}>
        <h3>Promotion policy check</h3>
        <p className="muted">These checks only show whether the institution’s minimum requirements are met. The decision is yours.</p>
        <ul className="checks">
          {r.eligibility.checks.map((c) => (
            <li key={c.id} className={c.passed ? 'check check-pass' : 'check check-fail'}>
              <span className="check-icon" aria-hidden="true">{c.passed ? '✓' : '✕'}</span>
              <span>
                {c.label}
                <span className="muted"> — {c.detail}</span>
              </span>
              <span className="sr-only">{c.passed ? 'Met' : 'Not met'}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Decision</h3>
        {result && <Alert kind={result.kind}>{result.text}</Alert>}
        {r.allowedDecisions.length === 0 ? (
          <p className="muted">
            This request was {r.status} on {formatDate(r.reviewedAt)} and is closed.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="review-reason">Review reason (required)</label>
              <textarea
                id="review-reason"
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded in the audit history and shared with the student"
              />
            </div>
            {approvalBlocked && r.allowedDecisions.includes('approve') && (
              <Alert kind="warn">Approval is unavailable because the policy minimums above are not met. You can still reject or request further review.</Alert>
            )}
            <div className="decision-row">
              {DECISION_BUTTONS.filter((b) => r.allowedDecisions.includes(b.decision)).map((b) => (
                <button key={b.decision} className={b.className} disabled={busy !== null || (b.decision === 'approve' && approvalBlocked)} onClick={() => decide(b.decision)}>
                  {busy === b.decision ? 'Saving…' : b.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Review and audit history</h3>
        {r.reviewHistory.length === 0 && r.auditHistory.length === 0 && <Empty title="No decisions recorded yet" />}
        <ol className="timeline">
          {r.reviewHistory.map((h, i) => (
            <li key={`review-${i}`}>
              <StatusBadge status={h.status} />
              <div>
                <strong>{h.reviewedBy}</strong> <span className="muted">· {formatDate(h.at)}</span>
                <p>{h.reason}</p>
              </div>
            </li>
          ))}
        </ol>
        {r.auditHistory.length > 0 && (
          <>
            <h4>Role changes on this account</h4>
            <ol className="timeline">
              {r.auditHistory.map((a) => (
                <li key={a.id}>
                  <span className="badge">
                    {a.previousRole ?? '—'} → {a.newRole}
                  </span>
                  <div>
                    <strong>{AUDIT_LABELS[a.action] ?? a.action}</strong>{' '}
                    <span className="muted">
                      · by {a.actor} ({a.actorRole}) · {formatDate(a.at)}
                    </span>
                    <p>{a.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

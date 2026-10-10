import { useState } from 'react';
import { ApiError, api, errorMessage, type CriterionKey, type Evaluation } from '../../api';
import { Alert, Spinner, formatDate, useLoad } from '../../components';
import { Modal, useFeedback } from '../../ui';

export const CRITERIA: { key: CriterionKey; label: string; hint: string }[] = [
  { key: 'taskCompletion', label: 'Task completion', hint: 'Did the assigned work fully and well' },
  { key: 'punctuality', label: 'Punctuality and attendance', hint: 'Arrived on time and stayed for the duty' },
  { key: 'communication', label: 'Communication', hint: 'Clear and courteous with guests and the team' },
  { key: 'teamwork', label: 'Teamwork', hint: 'Worked well with other volunteers' },
  { key: 'responsibility', label: 'Responsibility', hint: 'Could be relied on without supervision' },
  { key: 'problemSolving', label: 'Problem-solving', hint: 'Handled the unexpected sensibly' },
];

const SCALE = ['Poor', 'Below expectations', 'Met expectations', 'Good', 'Excellent'];

/**
 * Submits a new evaluation, or — when `existing` is given — corrects one.
 * A correction needs a reason and is recorded in the audit trail. The
 * overall rating shown here is a preview; the server calculates the real one.
 */
export function EvaluationModal({
  assignmentId,
  title,
  existing,
  onSaved,
  onClose,
}: {
  assignmentId: string;
  title: string;
  existing?: Evaluation;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { notify } = useFeedback();
  const [criteria, setCriteria] = useState<Partial<Record<CriterionKey, number>>>(existing?.criteria ?? {});
  const [feedback, setFeedback] = useState(existing?.feedback ?? '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rated = CRITERIA.filter((c) => criteria[c.key]);
  const preview = rated.length === CRITERIA.length ? Math.round((rated.reduce((sum, c) => sum + criteria[c.key]!, 0) / rated.length) * 100) / 100 : null;

  const save = async () => {
    const found: Record<string, string> = {};
    for (const c of CRITERIA) if (!criteria[c.key]) found[`criteria.${c.key}`] = 'Choose a rating';
    if (existing && reason.trim().length < 5) found.reason = 'Explain why the rating is being corrected';
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    setFormError(null);
    try {
      if (existing) await api(`/manage/evaluations/${existing.id}`, { method: 'PUT', body: { criteria, feedback, reason } });
      else await api(`/manage/assignments/${assignmentId}/evaluation`, { body: { criteria, feedback } });
      notify('success', existing ? 'Evaluation corrected. The change is recorded in its history.' : 'Evaluation submitted. The volunteer has been notified.');
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
    <Modal title={title} onClose={onClose} wide>
      <p className="muted">Rate each area from 1 (poor) to 5 (excellent). The volunteer can read this evaluation.</p>
      <div className="rating-grid">
        {CRITERIA.map((c) => (
          <fieldset key={c.key} className={`rating-row${errors[`criteria.${c.key}`] ? ' field-invalid' : ''}`}>
            <legend>
              {c.label}
              <small>{c.hint}</small>
            </legend>
            <div className="rating-options" role="radiogroup" aria-label={c.label}>
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className={`rating-pill${criteria[c.key] === n ? ' rating-pill-on' : ''}`} title={SCALE[n - 1]}>
                  <input
                    type="radio"
                    name={c.key}
                    checked={criteria[c.key] === n}
                    onChange={() => {
                      setCriteria((prev) => ({ ...prev, [c.key]: n }));
                      setErrors((e) => ({ ...e, [`criteria.${c.key}`]: '' }));
                    }}
                  />
                  {n}
                </label>
              ))}
            </div>
            {errors[`criteria.${c.key}`] && <p className="field-error">{errors[`criteria.${c.key}`]}</p>}
          </fieldset>
        ))}
      </div>
      <p>
        <strong>Overall rating: </strong>
        {preview === null ? <span className="muted">rate every area to see it</span> : `${preview} / 5`}
      </p>
      <div className="field">
        <label htmlFor="ev-feedback">Written feedback (optional)</label>
        <textarea id="ev-feedback" rows={3} maxLength={2000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </div>
      {existing && (
        <div className={`field${errors.reason ? ' field-invalid' : ''}`}>
          <label htmlFor="ev-reason">Reason for the correction (required)</label>
          <input id="ev-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          {errors.reason && <p className="field-error">{errors.reason}</p>}
        </div>
      )}
      {formError && <Alert kind="error">{formError}</Alert>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : existing ? 'Save correction' : 'Submit evaluation'}</button>
      </div>
    </Modal>
  );
}

interface AuditEntry {
  action: 'created' | 'corrected';
  actor: string;
  reason: string;
  before: { overall: number; feedback: string } | null;
  after: { overall: number; feedback: string };
  at: string;
}

export function AuditModal({ evaluationId, onClose }: { evaluationId: string; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => api<{ audit: AuditEntry[] }>(`/manage/evaluations/${evaluationId}/audit`), [evaluationId]);
  return (
    <Modal title="Rating history" onClose={onClose}>
      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      <ol className="timeline">
        {data?.audit.map((entry, i) => (
          <li key={i}>
            <span className="badge">{entry.action === 'created' ? 'Submitted' : 'Corrected'}</span>
            <div>
              <strong>{entry.actor}</strong> <span className="muted">· {formatDate(entry.at)}</span>
              <p>
                {entry.before ? `Overall ${entry.before.overall} → ${entry.after.overall}` : `Overall ${entry.after.overall}`}
                {entry.reason && ` · Reason: ${entry.reason}`}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

export function CriteriaBreakdown({ criteria }: { criteria: Record<CriterionKey, number> }) {
  return (
    <ul className="criteria-list">
      {CRITERIA.map((c) => (
        <li key={c.key}>
          <span>{c.label}</span>
          <span className="rating-dots" aria-label={`${criteria[c.key]} out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= criteria[c.key] ? 'dot dot-on' : 'dot'} />)}
          </span>
          <strong>{criteria[c.key]}</strong>
        </li>
      ))}
    </ul>
  );
}

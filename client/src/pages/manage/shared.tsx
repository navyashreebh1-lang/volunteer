import { useState } from 'react';
import { ApiError, api, errorMessage, type Candidates, type ManagedAssignment } from '../../api';
import { Alert, Empty, Spinner, StatusBadge, useLoad } from '../../components';
import { Chips, Modal, formatDay, useFeedback } from '../../ui';
import { EvaluationModal } from './evaluation';

/**
 * Lists who can take an activity. Eligible volunteers pass every mandatory
 * rule and are ranked by score; everyone else is shown with the reasons.
 */
export function CandidatePicker({
  activityId,
  activityName,
  actionLabel,
  onPick,
  onClose,
}: {
  activityId: string;
  activityName: string;
  actionLabel: string;
  onPick: (studentId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { data, error, loading } = useLoad(() => api<Candidates>(`/manage/activities/${activityId}/candidates`), [activityId]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const pick = async (id: string) => {
    setBusyId(id);
    setFailure(null);
    try {
      await onPick(id);
      onClose();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title={`Volunteers for ${activityName}`} onClose={onClose} wide>
      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {failure && <Alert kind="error">{failure}</Alert>}
      {data && (
        <>
          <h3>Eligible ({data.eligible.length})</h3>
          {data.eligible.length === 0 ? (
            <Empty title="No eligible volunteers">Nobody currently passes every requirement for this activity, so the position stays vacant.</Empty>
          ) : (
            <ul className="candidate-list">
              {data.eligible.map((c) => (
                <li key={c.id}>
                  <div>
                    <strong>{c.fullName}</strong> <span className="muted">· {c.usn}{c.department ? ` · ${c.department}` : ''}</span>
                    <div className="muted">{c.explanation.join(' · ')}</div>
                  </div>
                  <span className="score" title="Suitability score out of 100">{c.score}</span>
                  <button className="btn btn-primary btn-sm" disabled={busyId !== null} onClick={() => pick(c.id)}>
                    {busyId === c.id ? 'Saving…' : actionLabel}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>Not eligible ({data.ineligible.length})</summary>
            <ul className="candidate-list">
              {data.ineligible.map((c) => (
                <li key={c.id}>
                  <div>
                    <strong>{c.fullName}</strong> <span className="muted">· {c.usn}</span>
                    <div className="issue-text">{c.reasons.join(' · ')}</div>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Modal>
  );
}

function OutcomeModal({ assignment, onSaved, onClose }: { assignment: ManagedAssignment; onSaved: () => void; onClose: () => void }) {
  const { notify } = useFeedback();
  const [attendance, setAttendance] = useState<'attended' | 'absent'>(assignment.attendance ?? 'attended');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/manage/assignments/${assignment.id}/outcome`, { body: { attendance } });
      notify('success', 'Attendance recorded.');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Attendance — ${assignment.student.fullName}`} onClose={onClose}>
      <p className="muted">
        {assignment.activity.name}, {formatDay(assignment.activity.date)}. This becomes part of the student’s volunteering record. Rate their performance separately with “Evaluate”.
      </p>
      <div className="field">
        <label htmlFor="outcome-attendance">Attendance</label>
        <select id="outcome-attendance" value={attendance} onChange={(e) => setAttendance(e.target.value as 'attended' | 'absent')}>
          <option value="attended">Attended</option>
          <option value="absent">Absent</option>
        </select>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

/** Assignments with the actions an organizer can take on each. */
export function AssignmentTable({ assignments, onChanged, showEvent }: { assignments: ManagedAssignment[]; onChanged: () => void; showEvent?: boolean }) {
  const { notify, confirm } = useFeedback();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<ManagedAssignment | null>(null);
  const [recording, setRecording] = useState<ManagedAssignment | null>(null);
  const [evaluating, setEvaluating] = useState<ManagedAssignment | null>(null);

  const act = async (a: ManagedAssignment, action: 'confirm' | 'reject' | 'cancel', body: unknown, success: string) => {
    setBusyId(a.id);
    try {
      await api(`/manage/assignments/${a.id}/${action}`, { method: 'POST', body });
      notify('success', success);
    } catch (err) {
      // A refused confirmation comes back with volunteers who could take the seat instead.
      const alternatives = err instanceof ApiError ? (err.details as { alternatives?: { fullName: string }[] } | undefined)?.alternatives : undefined;
      notify('error', alternatives?.length ? `${errorMessage(err)}. Eligible alternatives: ${alternatives.map((x) => x.fullName).join(', ')}.` : errorMessage(err));
    } finally {
      setBusyId(null);
      onChanged();
    }
  };

  const reject = async (a: ManagedAssignment) => {
    const answer = await confirm({ title: 'Reject this assignment?', message: `${a.student.fullName} will not be assigned to "${a.activity.name}" and will be notified.`, confirmLabel: 'Reject', danger: true, reasonLabel: 'Reason (optional)' });
    if (answer.ok) await act(a, 'reject', { reason: answer.reason }, 'Assignment rejected.');
  };
  const cancel = async (a: ManagedAssignment) => {
    const answer = await confirm({ title: 'Cancel this confirmed assignment?', message: `${a.student.fullName} will be removed from "${a.activity.name}" and notified. The position becomes vacant.`, confirmLabel: 'Cancel assignment', danger: true, reasonLabel: 'Reason (optional)' });
    if (answer.ok) await act(a, 'cancel', { reason: answer.reason }, 'Assignment cancelled.');
  };

  if (!assignments.length) return <Empty title="No assignments to show" />;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Volunteer</th>
              <th>Activity</th>
              <th>Status</th>
              <th>Why</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => {
              const live = a.status === 'pending' || a.status === 'confirmed';
              return (
                <tr key={a.id} className={a.issues.length ? 'row-issue' : undefined}>
                  <td>
                    <strong>{a.student.fullName}</strong>
                    <div className="muted">{a.student.usn}</div>
                  </td>
                  <td>
                    <strong>{a.activity.name}</strong>
                    <div className="muted">
                      {showEvent && `${a.event.name} · `}
                      {formatDay(a.activity.date)} · {a.activity.startTime}–{a.activity.endTime}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={a.status} />
                    {a.issues.length > 0 && (
                      <div className="issue">
                        <span className="badge badge-conflict">Conflict</span>
                        <ul>{a.issues.map((i) => <li key={i}>{i}</li>)}</ul>
                      </div>
                    )}
                    {a.statusReason && !live && <div className="muted">{a.statusReason}</div>}
                    {a.ended && a.status === 'confirmed' && (
                      <div className="muted">
                        {a.attendance ? (a.attendance === 'attended' ? 'Attended' : 'Absent') : 'Attendance not recorded'}
                        {a.rating !== null && ` · rated ${a.rating}/5`}
                      </div>
                    )}
                  </td>
                  <td>
                    {a.score !== null && <span className="score" title="Suitability score out of 100">{a.score}</span>}
                    <div className="muted">{a.explanation.join(' · ') || '—'}</div>
                  </td>
                  <td>
                    <div className="row-actions">
                      {a.status === 'pending' && !a.ended && (
                        <button className="btn btn-primary btn-sm" disabled={busyId === a.id} onClick={() => act(a, 'confirm', undefined, `${a.student.fullName} confirmed for ${a.activity.name}.`)}>
                          Confirm
                        </button>
                      )}
                      {a.status === 'pending' && <button className="btn btn-danger btn-sm" disabled={busyId === a.id} onClick={() => reject(a)}>Reject</button>}
                      {live && !a.ended && <button className="btn btn-secondary btn-sm" disabled={busyId === a.id} onClick={() => setReplacing(a)}>Replace</button>}
                      {a.status === 'confirmed' && !a.ended && <button className="btn btn-ghost btn-sm" disabled={busyId === a.id} onClick={() => cancel(a)}>Cancel</button>}
                      {a.status === 'confirmed' && a.ended && <button className="btn btn-secondary btn-sm" onClick={() => setRecording(a)}>{a.attendance ? 'Edit attendance' : 'Record attendance'}</button>}
                      {a.status === 'confirmed' && a.ended && a.attendance !== 'absent' && a.rating === null && <button className="btn btn-primary btn-sm" onClick={() => setEvaluating(a)}>Evaluate</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {replacing && (
        <CandidatePicker
          activityId={replacing.activity.id}
          activityName={replacing.activity.name}
          actionLabel={`Replace ${replacing.student.fullName.split(' ')[0]}`}
          onClose={() => setReplacing(null)}
          onPick={async (studentId) => {
            await api(`/manage/assignments/${replacing.id}/replace`, { body: { studentId } });
            notify('success', 'Volunteer replaced. The new assignment is pending confirmation.');
            onChanged();
          }}
        />
      )}
      {recording && <OutcomeModal assignment={recording} onSaved={onChanged} onClose={() => setRecording(null)} />}
      {evaluating && (
        <EvaluationModal assignmentId={evaluating.id} title={`Evaluate ${evaluating.student.fullName} — ${evaluating.activity.name}`} onSaved={onChanged} onClose={() => setEvaluating(null)} />
      )}
    </>
  );
}

export function SkillList({ label, items }: { label: string; items: string[] }) {
  return (
    <span>
      <span className="muted">{label}: </span>
      <Chips items={items} empty="None" />
    </span>
  );
}

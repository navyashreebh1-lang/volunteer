import { useCallback, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { api, errorMessage, type Notice, type PromotionStatus } from './api';

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  if (size === 'lg') return <img className="logo-full" src="/logo-full.png" alt="Voluntrix — People, Purpose, Progress" />;
  return (
    <span className="logo" aria-label="Voluntrix">
      <img className="logo-mark" src="/logo-mark.png" alt="" />
      <span aria-hidden="true">
        Volun<span className="logo-accent">trix</span>
      </span>
    </span>
  );
}

export const TAGLINE = 'The right people. The right event. The right time.';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function Field({ label, error, hint, id, ...input }: FieldProps) {
  const fieldId = id ?? `f-${input.name}`;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={fieldId}>{label}</label>
      <input id={fieldId} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${fieldId}-msg` : undefined} {...input} />
      {(error || hint) && (
        <p id={`${fieldId}-msg`} className={error ? 'field-error' : 'field-hint'}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'info' | 'warn'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  needs_review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  active: 'Active',
  suspended: 'Suspended',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  draft: 'Draft',
  published: 'Published',
  completed: 'Completed',
  open: 'Open',
  closed: 'Closed',
};

export function StatusBadge({ status }: { status: PromotionStatus | string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Avatar({ user }: { user: { id: string; fullName: string; hasPhoto: boolean } }) {
  const [broken, setBroken] = useState(false);
  if (user.hasPhoto && !broken) {
    return <img className="avatar" src={`/api/users/${user.id}/photo`} alt="" onError={() => setBroken(true)} />;
  }
  const initials = user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span className="avatar avatar-initials" aria-hidden="true">
      {initials}
    </span>
  );
}

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** Loads data for a view and exposes loading / error / reload state. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await load());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

export function Notifications() {
  const { data, error, loading, reload } = useLoad(() => api<{ notifications: Notice[] }>('/notifications'), []);

  const markRead = async (id: string) => {
    await api(`/notifications/${id}/read`, { method: 'POST' }).catch(() => undefined);
    await reload();
  };

  return (
    <section className="card">
      <h2>Notifications</h2>
      {loading && !data && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.notifications.length === 0 && <Empty title="No notifications yet">Updates about your account appear here.</Empty>}
      <ul className="notice-list">
        {data?.notifications.map((n) => (
          <li key={n.id} className={n.readAt ? 'notice' : 'notice notice-unread'}>
            <div>
              <strong>{n.title}</strong>
              <p>{n.message}</p>
              <time>{formatDate(n.createdAt)}</time>
            </div>
            {!n.readAt && (
              <button className="btn btn-ghost btn-sm" onClick={() => markRead(n.id)}>
                Mark read
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

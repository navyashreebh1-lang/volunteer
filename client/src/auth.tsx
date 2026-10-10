import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, type Me, type Role } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (username: string, password: string, role: Role) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch (err) {
      // 401 simply means "not signed in" (or the session ended, e.g. after a promotion).
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else throw err;
    }
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      refresh,
      login: async (username, password, role) => {
        // The role is only a requested mode; the server decides whether it is allowed.
        await api('/auth/login', { body: { username, password, role } });
        await refresh();
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setMe(null);
      },
    }),
    [me, loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export const homeFor = (role: Role) => `/${role}`;

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken } from '../api/client';
import type { AuthUser } from '../types';

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    api.get('/api/auth/me')
      .then((response) => {
        if (!active) return;
        setUser(response.data.user);
        setCsrfToken(response.data.csrfToken);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthState>(() => ({
    user,
    ready,
    async login(email: string, password: string) {
      const response = await api.post('/api/auth/login', { email, password });
      setUser(response.data.user);
      setCsrfToken(response.data.csrfToken);
    },
    async logout() {
      await api.post('/api/auth/logout');
      setUser(null);
      setCsrfToken('');
    },
  }), [ready, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is missing.');
  return value;
}

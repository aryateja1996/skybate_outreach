import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
  withCredentials: true,
});

let csrfToken = '';

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toLowerCase();
  if (csrfToken && !['get', 'head', 'options'].includes(method)) {
    config.headers['X-CSRF-Token'] = csrfToken;
  }
  return config;
});

export function errorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'The request failed.';
  const data = error.response?.data as {
    error?: { message?: string; details?: { failures?: string[] } };
  } | undefined;
  const failures = data?.error?.details?.failures;
  if (failures?.length) return failures.join(' ');
  return data?.error?.message ?? 'The request failed.';
}

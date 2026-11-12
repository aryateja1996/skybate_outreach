const SECRET_KEY = /password|authorization|api[_-]?key|secret|token|cookie|smtp|sesuser|username|(^|_)pass$/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(entry);
    }
    return output;
  }
  return value;
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', message, ...(sanitize(meta) as object) }));
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'error', message, ...(sanitize(meta) as object) }));
}

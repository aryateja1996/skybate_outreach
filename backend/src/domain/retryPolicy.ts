import type { FailureClass } from '../types';

export type SendFailureClass = Exclude<FailureClass, 'none'>;

export function classifySendError(error: unknown): SendFailureClass {
  const candidate = error as { code?: string; responseCode?: number };
  const code = candidate?.code ?? '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNRESET') return 'ambiguous';
  if (code === 'EAUTH') return 'permanent';
  if (code === 'ECONNECTION' || code === 'EDNS' || code === 'ENOTFOUND') return 'transient';
  const response = candidate?.responseCode;
  if (typeof response === 'number' && response >= 400 && response < 500) return 'transient';
  if (typeof response === 'number' && response >= 500) return 'permanent';
  // Unknown errors after an SMTP attempt are not retried. A retry could duplicate the email.
  return 'ambiguous';
}

export function decideRetry(input: {
  attempt: number;
  maxAttempts: number;
  classification: SendFailureClass;
  baseDelaySeconds: number;
}): { action: 'retry'; delaySeconds: number } | { action: 'fail' } {
  if (input.classification !== 'transient') return { action: 'fail' };
  if (input.attempt >= input.maxAttempts) return { action: 'fail' };
  if (input.baseDelaySeconds <= 0) return { action: 'retry', delaySeconds: 0 };
  const delaySeconds = Math.min(900, input.baseDelaySeconds * 2 ** Math.max(0, input.attempt - 1));
  return { action: 'retry', delaySeconds };
}

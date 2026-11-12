import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export function randomId(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function generateUnsubscribeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashUnsubscribeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

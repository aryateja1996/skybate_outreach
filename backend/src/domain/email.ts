const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 320) return false;
  return EMAIL_PATTERN.test(normalized);
}

export function sanitizeHeader(value: string, maxLength = 200): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

export function sanitizeSenderName(value: string): string {
  const cleaned = value.replace(/[\r\n"\\]/g, '').trim().slice(0, 120);
  return cleaned || 'Skybate Technologies';
}

export function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

export function maskEmail(email: string): string {
  const [local, domain] = normalizeEmail(email).split('@');
  if (!local || !domain) return 'hidden address';
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

import { ALLOWED_PLACEHOLDERS } from './defaultTemplate';

const BANNED_PATTERNS: Array<[RegExp, string]> = [
  [/\bwe have (successfully )?(placed|delivered|hired|onboarded)\b/i, 'fabricated_claim'],
  [/\b\d+\+?\s*(clients|customers|placements|engineers|consultants|resources)\b/i, 'fabricated_claim'],
  [/\bfortune\s*\d+/i, 'fabricated_claim'],
  [/\bour (valued )?(clients|customers) include\b/i, 'fabricated_claim'],
  [/\bteam of\s+\d+/i, 'fabricated_claim'],
  [/\b\d+\s+years of experience\b/i, 'fabricated_claim'],
  [/\btrusted by\b/i, 'fabricated_claim'],
];

const ALLOWED = new Set<string>(ALLOWED_PLACEHOLDERS);

export function validateAiDraft(subject: string, body: string, senderEmail: string): string | null {
  const cleanSubject = subject.trim();
  const cleanBody = body.trim();
  if (cleanSubject.length < 8 || cleanSubject.length > 200) return 'subject_length';
  if (cleanBody.length < 80 || cleanBody.length > 8000) return 'body_length';
  const combined = `${cleanSubject}\n${cleanBody}`;
  for (const [pattern, code] of BANNED_PATTERNS) {
    if (pattern.test(combined)) return code;
  }
  const urls = combined.match(/https?:\/\/[^\s)]+/gi) ?? [];
  for (const url of urls) {
    if (!/^https?:\/\/skybate\.in(?:\/|$)/i.test(url)) return 'unexpected_url';
  }
  const emails = combined.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  for (const email of emails) {
    if (email.toLowerCase() !== senderEmail.toLowerCase()) return 'unexpected_email';
  }
  const placeholders = [...combined.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((match) => match[1].toLowerCase());
  if (placeholders.some((placeholder) => !ALLOWED.has(placeholder))) return 'unknown_placeholder';
  if (!cleanBody.includes('{{company_name}}') && !/your organization/i.test(cleanBody)) {
    return 'missing_company_placeholder';
  }
  if (!/\bSkybate\b/.test(cleanBody)) return 'missing_sender_identity';
  const greeting = cleanBody.match(/^\s*(?:Hi|Hello|Dear)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
  if (greeting && !cleanBody.includes('{{contact_name}}')) {
    const name = greeting[1];
    if (name !== 'Sreekar' && name !== 'Sreekar Kondaveeti') return 'invented_recipient';
  }
  return null;
}

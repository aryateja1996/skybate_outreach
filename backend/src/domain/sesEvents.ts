import { createHash } from 'crypto';
import { normalizeMessageId } from './email';
import type { EmailEventType, RecipientStatus, SuppressionReason } from '../types';

export interface ParsedSesEvent {
  eventType: EmailEventType;
  messageId: string;
  occurredAt: string | null;
  bounceType?: string;
  delayType?: string;
  complaintFeedbackType?: string;
  recipients: string[];
  diagnostic?: string;
}

const EVENT_TYPES = new Set<EmailEventType>([
  'send',
  'delivery',
  'bounce',
  'complaint',
  'reject',
  'rendering_failure',
  'delivery_delay',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function eventTypeFrom(value: unknown): EmailEventType | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const normalized = compact
    .replace('renderingfailure', 'rendering_failure')
    .replace('deliverydelay', 'delivery_delay');
  return EVENT_TYPES.has(normalized as EmailEventType) ? (normalized as EmailEventType) : null;
}

function emailsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = asRecord(entry);
      const address = record?.emailAddress ?? record?.email;
      return typeof address === 'string' ? address : '';
    })
    .filter(Boolean);
}

export function parseSesMessage(message: unknown): ParsedSesEvent | null {
  const record = asRecord(message);
  if (!record) return null;
  const eventType = eventTypeFrom(record.eventType ?? record.notificationType);
  const mail = asRecord(record.mail);
  const messageId = typeof mail?.messageId === 'string' ? mail.messageId : '';
  if (!eventType || !messageId) return null;

  const bounce = asRecord(record.bounce);
  const complaint = asRecord(record.complaint);
  const delivery = asRecord(record.delivery);
  const deliveryDelay = asRecord(record.deliveryDelay);
  const recipients = [
    ...emailsFrom(bounce?.bouncedRecipients),
    ...emailsFrom(complaint?.complainedRecipients),
    ...emailsFrom(delivery?.recipients),
    ...emailsFrom(deliveryDelay?.delayedRecipients),
    ...emailsFrom(mail?.destination),
  ];
  const uniqueRecipients = [...new Set(recipients.map((email) => email.trim()).filter(Boolean))];
  const diagnosticCode = diagnosticFrom(bounce?.bouncedRecipients) ?? diagnosticFrom(deliveryDelay?.delayedRecipients);

  const occurred =
    (typeof bounce?.timestamp === 'string' && bounce.timestamp) ||
    (typeof complaint?.timestamp === 'string' && complaint.timestamp) ||
    (typeof delivery?.timestamp === 'string' && delivery.timestamp) ||
    (typeof deliveryDelay?.timestamp === 'string' && deliveryDelay.timestamp) ||
    (typeof mail?.timestamp === 'string' && mail.timestamp) ||
    null;

  return {
    eventType,
    messageId,
    occurredAt: occurred,
    bounceType: typeof bounce?.bounceType === 'string' ? bounce.bounceType : undefined,
    delayType: typeof deliveryDelay?.delayType === 'string' ? deliveryDelay.delayType : undefined,
    complaintFeedbackType:
      typeof complaint?.complaintFeedbackType === 'string' ? complaint.complaintFeedbackType : undefined,
    recipients: uniqueRecipients,
    diagnostic: diagnosticCode,
  };
}

function diagnosticFrom(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = asRecord(value[0]);
  return typeof first?.diagnosticCode === 'string' ? first.diagnosticCode.slice(0, 500) : undefined;
}

export function eventIdempotencyKey(event: ParsedSesEvent): string {
  const parts = [
    event.eventType,
    normalizeMessageId(event.messageId),
    (event.bounceType ?? '').toLowerCase(),
    (event.delayType ?? '').toLowerCase(),
    event.recipients.map((recipient) => recipient.toLowerCase()).sort().join(','),
    event.occurredAt ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

const RANK: Record<RecipientStatus, number> = {
  pending: 0,
  sending: 1,
  retry_wait: 1,
  simulated: 2,
  accepted: 3,
  failed: 4,
  delivered: 5,
  bounced: 6,
  complained: 7,
  suppressed: 7,
  cancelled: 8,
};

export function nextStatusForEvent(current: RecipientStatus, event: ParsedSesEvent): RecipientStatus | null {
  if (current === 'cancelled' || current === 'simulated') return null;
  let next: RecipientStatus | null = null;
  switch (event.eventType) {
    case 'send':
      next = 'accepted';
      break;
    case 'delivery':
      next = 'delivered';
      break;
    case 'bounce':
      next = event.bounceType === 'Permanent' ? 'bounced' : null;
      break;
    case 'complaint':
      next = 'complained';
      break;
    case 'reject':
    case 'rendering_failure':
      next = 'failed';
      break;
    case 'delivery_delay':
      return null;
    default:
      next = null;
  }
  if (!next || next === current) return null;
  const override = next === 'bounced' || next === 'complained';
  if (RANK[next] < RANK[current] && !override) return null;
  return next;
}

export function suppressionForEvent(event: ParsedSesEvent): SuppressionReason | null {
  if (event.eventType === 'complaint') return 'complaint';
  if (event.eventType === 'bounce' && event.bounceType === 'Permanent') return 'hard_bounce';
  return null;
}

export function reducedEventPayload(event: ParsedSesEvent): Record<string, unknown> {
  return {
    eventType: event.eventType,
    messageId: event.messageId,
    bounceType: event.bounceType ?? null,
    delayType: event.delayType ?? null,
    complaintFeedbackType: event.complaintFeedbackType ?? null,
    recipients: event.recipients,
    diagnostic: event.diagnostic ?? null,
  };
}

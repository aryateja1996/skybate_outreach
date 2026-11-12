import { isValidEmail, normalizeEmail, normalizeMessageId } from '../domain/email';
import {
  eventIdempotencyKey,
  nextStatusForEvent,
  parseSesMessage,
  reducedEventPayload,
  suppressionForEvent,
} from '../domain/sesEvents';
import { AppError } from '../errors';
import type { Store } from '../store';

export async function applySesEvent(store: Store, message: unknown): Promise<{ duplicate: boolean; applied: boolean }> {
  const event = parseSesMessage(message);
  if (!event) throw new AppError(400, 'SES event payload was not recognized.', 'INVALID_SES_EVENT');
  const eventKey = eventIdempotencyKey(event);
  return store.withTransaction(async (tx) => {
    const recipient = await tx.findRecipientByMessageId(normalizeMessageId(event.messageId));
    const inserted = await tx.insertEmailEvent({
      campaignRecipientId: recipient?.id ?? null,
      providerMessageId: event.messageId,
      eventType: event.eventType,
      eventKey,
      payload: reducedEventPayload(event),
      occurredAt: event.occurredAt ? new Date(event.occurredAt) : null,
    });
    if (!inserted.inserted) return { duplicate: true, applied: false };

    if (recipient) {
      const next = nextStatusForEvent(recipient.status, event);
      if (next) await tx.updateRecipientFromEvent(recipient.id, next);
    }

    const reason = suppressionForEvent(event);
    if (reason) {
      for (const email of event.recipients) {
        const normalized = normalizeEmail(email);
        if (!isValidEmail(normalized)) continue;
        await tx.upsertSuppression({
          emailNormalized: normalized,
          reason,
          source: 'ses_event',
          notes: event.diagnostic ?? null,
          createdBy: null,
        });
        await tx.markContactsSuppressed(normalized);
      }
    }
    return { duplicate: false, applied: true };
  });
}

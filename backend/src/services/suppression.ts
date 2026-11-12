import { isValidEmail, normalizeEmail } from '../domain/email';
import { maskEmail } from '../domain/email';
import { hashUnsubscribeToken } from '../domain/tokens';
import { AppError } from '../errors';
import type { Store } from '../store';
import type { SuppressionReason } from '../types';
import type { Actor } from './contacts';

export async function addSuppression(input: {
  store: Store;
  actor: Actor;
  email: string;
  reason: SuppressionReason;
  notes?: string | null;
}) {
  const emailNormalized = normalizeEmail(input.email);
  if (!isValidEmail(emailNormalized)) throw new AppError(400, 'Enter a valid email address.', 'VALIDATION_ERROR');
  return input.store.withTransaction(async (tx) => {
    const row = await tx.upsertSuppression({
      emailNormalized,
      reason: input.reason,
      source: 'manual',
      notes: input.notes ?? null,
      createdBy: input.actor.userId,
    });
    await tx.markContactsSuppressed(emailNormalized);
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'suppression_added',
      entityType: 'suppression',
      entityId: row.id,
      metadata: { reason: input.reason },
      ipAddress: input.actor.ipAddress,
    });
    return row;
  });
}

export async function liftSuppression(input: { store: Store; actor: Actor; id: number; confirmEmail: string }) {
  const rows = await input.store.listSuppressions({ page: 1, pageSize: 100, search: normalizeEmail(input.confirmEmail) });
  const target = rows.rows.find((row) => row.id === input.id);
  if (!target || !target.active) throw new AppError(404, 'Active suppression record not found.', 'NOT_FOUND');
  if (target.emailNormalized !== normalizeEmail(input.confirmEmail)) {
    throw new AppError(400, 'Type the suppressed email address to confirm.', 'CONFIRMATION_MISMATCH');
  }
  return input.store.withTransaction(async (tx) => {
    const lifted = await tx.liftSuppression(target.id);
    if (!lifted) throw new AppError(404, 'Active suppression record not found.', 'NOT_FOUND');
    await tx.restoreContactEligibility(lifted.emailNormalized);
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'suppression_lifted',
      entityType: 'suppression',
      entityId: lifted.id,
      metadata: { reason: lifted.reason },
      ipAddress: input.actor.ipAddress,
    });
    return lifted;
  });
}

export async function unsubscribeAddress(store: Store, token: string, ipAddress: string | null) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw new AppError(404, 'This unsubscribe link is invalid.', 'INVALID_UNSUBSCRIBE');
  }
  const tokenHash = hashUnsubscribeToken(token);
  const record = await store.findUnsubscribeToken(tokenHash);
  if (!record) throw new AppError(404, 'This unsubscribe link is invalid.', 'INVALID_UNSUBSCRIBE');
  await store.withTransaction(async (tx) => {
    await tx.upsertSuppression({
      emailNormalized: record.emailNormalized,
      reason: 'unsubscribe',
      source: 'unsubscribe_link',
      notes: null,
      createdBy: null,
    });
    await tx.markContactsSuppressed(record.emailNormalized);
    if (!record.usedAt) {
      await tx.addAudit({
        actorUserId: null,
        action: 'unsubscribe',
        entityType: 'contact',
        entityId: record.contactId,
        metadata: { reason: 'unsubscribe' },
        ipAddress,
      });
    }
    await tx.markUnsubscribeTokenUsed(tokenHash);
  });
  return { emailMasked: maskEmail(record.emailNormalized) };
}

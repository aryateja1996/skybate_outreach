import type { AppConfig } from '../config';
import { isValidEmail, normalizeMessageId, sanitizeHeader, sanitizeSenderName } from '../domain/email';
import { textToHtml } from '../domain/html';
import { buildOutreachFooter } from '../domain/personalize';
import { classifySendError, decideRetry } from '../domain/retryPolicy';
import { generateUnsubscribeToken, hashUnsubscribeToken, randomId } from '../domain/tokens';
import { logError, logInfo } from '../logger';
import type { Store } from '../store';
import type { Campaign, Recipient } from '../types';
import type { MailTransport } from './mailer';

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  return 'Email transport failed.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function recoverOnStartup(store: Store): Promise<number[]> {
  const ids = await store.recoverInterruptedCampaigns();
  for (const id of ids) {
    await store.addAudit({
      actorUserId: null,
      action: 'campaign_paused_on_restart',
      entityType: 'campaign',
      entityId: id,
      metadata: {
        reason: 'Application restart paused an in-progress campaign. Sending was not resumed automatically.',
      },
      ipAddress: null,
    });
  }
  if (ids.length) logInfo('Paused campaigns that were sending when the process stopped.', { campaigns: ids.length });
  return ids;
}

async function sendOne(input: {
  store: Store;
  config: AppConfig;
  mailer: MailTransport;
  campaign: Campaign;
  recipient: Recipient;
}): Promise<'tripped' | 'continue'> {
  const latest = await input.store.findCampaign(input.campaign.id);
  if (!latest || latest.status === 'cancelled') {
    await input.store.releaseRecipientToStatus(input.recipient.id, 'cancelled');
    return 'continue';
  }
  if (latest.status === 'paused') {
    await input.store.releaseRecipientToStatus(input.recipient.id, input.recipient.nextAttemptAt ? 'retry_wait' : 'pending');
    return 'continue';
  }
  if (!latest.dryRun && input.config.mode !== 'live') {
    await input.store.releaseRecipientToStatus(input.recipient.id, 'pending');
    await input.store.updateCampaign(latest.id, {
      status: 'paused',
      pausedAt: new Date(),
      sendingLockToken: null,
      sendingLockAcquiredAt: null,
    });
    await input.store.addAudit({
      actorUserId: null,
      action: 'campaign_paused',
      entityType: 'campaign',
      entityId: latest.id,
      metadata: { reason: 'Live sending is no longer enabled. The campaign was paused instead of sending.' },
      ipAddress: null,
    });
    return 'tripped';
  }

  const contact = await input.store.findContactById(input.recipient.contactId);
  const suppression = contact ? await input.store.findActiveSuppression(contact.emailNormalized) : null;
  if (!contact || suppression || contact.eligibilityStatus === 'suppressed') {
    await input.store.completeRecipient(input.recipient.id, {
      status: 'suppressed',
      lastError: 'Suppressed before send.',
      failureClass: 'none',
      incrementAttempt: false,
    });
    return 'continue';
  }
  if (contact.eligibilityStatus !== 'eligible' || !isValidEmail(contact.email)) {
    await input.store.completeRecipient(input.recipient.id, {
      status: 'failed',
      lastError: 'Contact is not eligible.',
      failureClass: 'permanent',
      incrementAttempt: false,
    });
    return 'continue';
  }
  const mode = latest.dryRun ? 'dry_run' : 'live';
  const [blocked] = await input.store.contactsBlockedForOutreach([contact.id], mode, latest.id);
  if (blocked && !(blocked.reason === 'accepted' && !latest.dryRun && contact.isContacted)) {
    const message = blocked.reason === 'simulated'
      ? 'This contact was already simulated in a dry-run campaign.'
      : blocked.reason === 'ambiguous'
        ? 'This contact has an unresolved send and was not retried.'
        : blocked.reason === 'open'
          ? 'This contact is already queued in another campaign.'
          : 'Another campaign already received SMTP acceptance for this contact.';
    await input.store.completeRecipient(input.recipient.id, {
      status: 'cancelled',
      lastError: message,
      failureClass: 'none',
      incrementAttempt: false,
    });
    return 'continue';
  }
  const acceptedElsewhere = await input.store.contactAcceptedByOtherCampaign({
    contactId: contact.id,
    recipientId: input.recipient.id,
    queuedAt: input.recipient.createdAt,
  });
  if (!latest.dryRun && acceptedElsewhere) {
    await input.store.completeRecipient(input.recipient.id, {
      status: 'cancelled',
      lastError: 'Another campaign already received SMTP acceptance for this contact.',
      failureClass: 'none',
      incrementAttempt: false,
    });
    return 'continue';
  }

  const token = generateUnsubscribeToken();
  const unsubscribeUrl = `${input.config.publicApiUrl.replace(/\/$/, '')}/unsubscribe/${token}`;
  const text = `${input.recipient.personalizedBody}${buildOutreachFooter({
    unsubscribeUrl,
    senderEmail: latest.senderEmail,
  })}`;
  await input.store.createUnsubscribeToken({ contactId: contact.id, tokenHash: hashUnsubscribeToken(token) });

  if (latest.dryRun) {
    await input.store.completeRecipient(input.recipient.id, {
      status: 'simulated',
      providerMessageId: `dry-run-${input.recipient.id}`,
      providerMessageIdNormalized: `dry-run-${input.recipient.id}`,
      personalizedBody: text,
      sentAt: new Date(),
      failureClass: 'none',
      lastError: null,
      incrementAttempt: true,
    });
    await input.store.resetCircuitFailures(latest.id);
    return 'continue';
  }

  try {
    const info = await input.mailer.send({
      fromName: sanitizeSenderName(latest.senderName),
      fromEmail: latest.senderEmail,
      to: contact.emailNormalized,
      subject: sanitizeHeader(input.recipient.personalizedSubject),
      text,
      html: textToHtml(text),
      unsubscribeUrl,
    });
    const normalized = normalizeMessageId(info.messageId);
    const sentAt = new Date();
    const recorded = await input.store.withTransaction(async (tx) => {
      const completed = await tx.completeRecipient(input.recipient.id, {
        status: 'accepted',
        providerMessageId: info.messageId,
        providerMessageIdNormalized: normalized,
        personalizedBody: text,
        sentAt,
        failureClass: 'none',
        lastError: null,
        incrementAttempt: true,
      });
      if (completed) {
        await tx.recordAcceptedOutreach({ contactId: contact.id, campaignId: latest.id, sentAt });
      }
      return completed;
    });
    if (recorded) await input.store.resetCircuitFailures(latest.id);
    return 'continue';
  } catch (error) {
    const classification = classifySendError(error);
    const attempt = input.recipient.attemptCount + 1;
    const decision = decideRetry({
      attempt,
      maxAttempts: latest.maxAttempts,
      classification,
      baseDelaySeconds: input.config.retryBaseDelaySeconds,
    });
    const message = errorText(error);
    if (decision.action === 'retry') {
      await input.store.rescheduleRecipient(input.recipient.id, {
        lastError: message,
        nextAttemptAt: new Date(Date.now() + decision.delaySeconds * 1000),
        incrementAttempt: true,
      });
    } else {
      await input.store.completeRecipient(input.recipient.id, {
        status: 'failed',
        lastError: message,
        failureClass: classification,
        incrementAttempt: true,
        personalizedBody: text,
      });
    }
    const tripped = await input.store.recordCircuitFailure(latest.id, latest.circuitBreakerThreshold);
    if (tripped) {
      await input.store.addAudit({
        actorUserId: null,
        action: 'campaign_circuit_breaker',
        entityType: 'campaign',
        entityId: latest.id,
        metadata: { classification },
        ipAddress: null,
      });
      logError('Campaign circuit breaker paused sending.', { campaignId: latest.id });
      return 'tripped';
    }
    return 'continue';
  }
}

export async function runSendTick(input: { store: Store; config: AppConfig; mailer: MailTransport }): Promise<void> {
  const campaigns = await input.store.listSendableCampaigns();
  for (const campaign of campaigns) {
    const token = randomId(16);
    const locked = await input.store.claimCampaignLock(campaign.id, token, 120);
    if (!locked) continue;
    try {
      const current = await input.store.findCampaign(campaign.id);
      if (!current || current.status !== 'sending') continue;
      const allowance = Math.min(current.batchSize, Math.max(1, Math.floor(current.sendRatePerSecond)));
      const recipients = await input.store.claimRecipientBatch(current.id, allowance, token);
      const delayMs = current.sendRatePerSecond > 0 ? Math.ceil(1000 / current.sendRatePerSecond) : 1000;
      for (let index = 0; index < recipients.length; index += 1) {
        const outcome = await sendOne({
          store: input.store,
          config: input.config,
          mailer: input.mailer,
          campaign: current,
          recipient: recipients[index],
        });
        if (outcome === 'tripped') break;
        if (index < recipients.length - 1) await sleep(delayMs);
      }
      await input.store.markCampaignCompletedIfDone(current.id);
    } finally {
      await input.store.releaseCampaignLock(campaign.id, token);
    }
  }
}

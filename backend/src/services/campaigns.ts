import type { AppConfig } from '../config';
import { canTransition } from '../domain/campaignState';
import { isValidEmail, sanitizeHeader, sanitizeSenderName } from '../domain/email';
import { footerPreview, personalize } from '../domain/personalize';
import { dayBounds } from '../domain/scheduler';
import { evaluateSendGuards } from '../domain/sendGuards';
import { AppError } from '../errors';
import type { Store } from '../store';
import type { Campaign, Contact, Recipient } from '../types';
import type { Actor } from './contacts';

const OPEN_OUTREACH_MESSAGE = 'This contact is already queued in another campaign.';
const SIMULATED_MESSAGE = 'This contact was already simulated in a dry-run campaign.';
const AMBIGUOUS_MESSAGE = 'This contact has an unresolved send and cannot be selected again.';

function blockError(reason: 'open' | 'simulated' | 'accepted' | 'ambiguous', email: string): AppError {
  if (reason === 'open') return new AppError(409, OPEN_OUTREACH_MESSAGE, 'CONTACT_ALREADY_QUEUED', { email });
  if (reason === 'simulated') return new AppError(409, SIMULATED_MESSAGE, 'ALREADY_SIMULATED', { email });
  if (reason === 'ambiguous') return new AppError(409, AMBIGUOUS_MESSAGE, 'AMBIGUOUS_SEND', { email });
  return new AppError(
    409,
    'Previously contacted addresses are excluded unless an administrator selects them for follow-up.',
    'PREVIOUSLY_CONTACTED',
    { email },
  );
}

async function requireCampaign(store: Store, id: number): Promise<Campaign> {
  const campaign = await store.findCampaign(id);
  if (!campaign) throw new AppError(404, 'Campaign not found.', 'NOT_FOUND');
  return campaign;
}

function assertAction(campaign: Campaign, action: Parameters<typeof canTransition>[1]): void {
  if (!canTransition(campaign.status, action)) {
    throw new AppError(409, `Cannot ${action} a campaign that is ${campaign.status}.`, 'INVALID_STATE');
  }
}

async function loadAllRecipients(store: Store, campaignId: number): Promise<Recipient[]> {
  const pageSize = 500;
  const first = await store.listRecipients(campaignId, { page: 1, pageSize });
  const rows = [...first.rows];
  const pages = Math.ceil(first.total / pageSize);
  for (let page = 2; page <= pages; page += 1) {
    const next = await store.listRecipients(campaignId, { page, pageSize });
    rows.push(...next.rows);
  }
  return rows;
}

async function eligibleSelection(store: Store, contacts: Contact[], followUpIds: Set<number>): Promise<Contact[]> {
  const suppressed = await store.findActiveSuppressions(contacts.map((contact) => contact.emailNormalized));
  const rejected: string[] = [];
  const accepted: Contact[] = [];
  for (const contact of contacts) {
    const blocked =
      contact.eligibilityStatus !== 'eligible' ||
      !isValidEmail(contact.email) ||
      suppressed.has(contact.emailNormalized);
    if (blocked) {
      rejected.push(contact.email);
      continue;
    }
    if (contact.isContacted && !followUpIds.has(contact.id)) {
      throw new AppError(
        409,
        'Previously contacted addresses are excluded unless an administrator selects them for follow-up.',
        'PREVIOUSLY_CONTACTED',
        { email: contact.email },
      );
    }
    accepted.push(contact);
  }
  if (rejected.length) {
    throw new AppError(400, 'Some contacts are not eligible for outreach.', 'INELIGIBLE_CONTACTS', {
      emails: rejected.slice(0, 20),
      rejectedCount: rejected.length,
    });
  }
  return accepted;
}

async function reserveContacts(
  store: Store,
  contacts: Contact[],
  followUpIds: Set<number>,
  mode: 'dry_run' | 'live',
): Promise<Contact[]> {
  const ids = contacts.map((contact) => contact.id);
  const locked = await store.lockContacts(ids);
  const lockedById = new Map(locked.map((contact) => [contact.id, contact]));
  const blocks = new Map((await store.contactsBlockedForOutreach(ids, mode)).map((block) => [block.contactId, block.reason]));
  const suppressed = await store.findActiveSuppressions(contacts.map((contact) => contact.emailNormalized));
  const reserved: Contact[] = [];
  for (const contact of contacts) {
    const fresh = lockedById.get(contact.id);
    if (!fresh) throw new AppError(400, 'One or more contacts were not found.', 'NOT_FOUND');
    const reason = blocks.get(fresh.id);
    if (reason && !(reason === 'accepted' && followUpIds.has(fresh.id))) throw blockError(reason, fresh.email);
    if (fresh.eligibilityStatus !== 'eligible' || !isValidEmail(fresh.email) || suppressed.has(fresh.emailNormalized)) {
      throw new AppError(400, 'Some contacts are not eligible for outreach.', 'INELIGIBLE_CONTACTS', { emails: [fresh.email] });
    }
    if (fresh.isContacted && !followUpIds.has(fresh.id)) {
      throw new AppError(409, 'This contact was already emailed by another campaign.', 'PREVIOUSLY_CONTACTED', { email: fresh.email });
    }
    reserved.push(fresh);
  }
  return reserved;
}

async function assertRecipientsStillEligible(store: Store, campaign: Campaign, mode: 'dry_run' | 'live'): Promise<void> {
  const recipients = await loadAllRecipients(store, campaign.id);
  if (recipients.length === 0) return;
  const contacts = await store.findContactsByIds(recipients.map((recipient) => recipient.contactId));
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const blocks = await store.contactsBlockedForOutreach(recipients.map((recipient) => recipient.contactId), mode, campaign.id);
  for (const block of blocks) {
    const contact = byId.get(block.contactId);
    if (block.reason === 'accepted' && contact?.isContacted) continue;
    throw blockError(block.reason, contact?.email ?? 'contact');
  }
}

function personalizePair(subject: string, body: string, contact: Contact) {
  return {
    contactId: contact.id,
    personalizedSubject: sanitizeHeader(personalize(subject, contact)),
    personalizedBody: personalize(body, contact),
  };
}

export async function createCampaign(input: {
  store: Store;
  config: AppConfig;
  actor: Actor;
  name: string;
  templateId: number | null;
  subject: string;
  body: string;
  senderName: string;
  recipientLimit: number;
  contactIds?: number[];
  selectEligible?: boolean;
  followUpContactIds?: number[];
}): Promise<Campaign> {
  if (input.recipientLimit < 1 || input.recipientLimit > input.config.maxRecipientsPerCampaign) {
    throw new AppError(
      400,
      `Recipient limit must be between 1 and ${input.config.maxRecipientsPerCampaign}.`,
      'RECIPIENT_LIMIT',
    );
  }
  if (input.config.maxSendRate <= 0 || input.config.maxBatchSize < 1) {
    throw new AppError(500, 'Sending limits are not configured.', 'SENDING_CONFIG');
  }
  if (input.selectEligible && (input.contactIds?.length ?? 0) > 0) {
    throw new AppError(400, 'Choose either selected contacts or eligible contacts, not both.', 'VALIDATION_ERROR');
  }
  const followUpIds = new Set(input.followUpContactIds ?? []);
  if (followUpIds.size > 0 && input.actor.role !== 'admin') {
    throw new AppError(403, 'Only an administrator can select a previously contacted address for follow-up.', 'FOLLOW_UP_ADMIN');
  }
  const subject = sanitizeHeader(input.subject);
  const body = input.body.trim();
  if (subject.length < 3 || body.length < 20) {
    throw new AppError(400, 'Subject and message are required.', 'VALIDATION_ERROR');
  }

  let contacts: Contact[] = [];
  if (!input.selectEligible) {
    const ids = [...new Set(input.contactIds ?? [])];
    if (ids.length === 0) throw new AppError(400, 'Select at least one contact.', 'VALIDATION_ERROR');
    if (ids.length > input.recipientLimit) {
      throw new AppError(400, 'Selected contacts exceed the recipient limit.', 'RECIPIENT_LIMIT');
    }
    const found = await input.store.findContactsByIds(ids);
    if (found.length !== ids.length) {
      throw new AppError(400, 'One or more contacts were not found.', 'NOT_FOUND');
    }
    contacts = await eligibleSelection(input.store, found, followUpIds);
    if (contacts.length === 0) throw new AppError(400, 'No eligible contacts are available.', 'NO_RECIPIENTS');
  }

  return input.store.withTransaction(async (tx) => {
    if (input.selectEligible) {
      contacts = await tx.selectSchedulerContacts(input.recipientLimit, input.config.mode);
    }
    if (contacts.length === 0) throw new AppError(400, 'No eligible contacts are available.', 'NO_RECIPIENTS');
    contacts = await reserveContacts(tx, contacts, followUpIds, input.config.mode);
    const campaign = await tx.createCampaign({
      name: input.name.trim(),
      templateId: input.templateId,
      subject,
      body,
      senderName: sanitizeSenderName(input.senderName),
      senderEmail: input.config.sesFromEmail,
      recipientLimit: input.recipientLimit,
      sendRatePerSecond: input.config.maxSendRate,
      batchSize: input.config.maxBatchSize,
      maxAttempts: input.config.maxSendAttempts,
      circuitBreakerThreshold: input.config.circuitBreakerThreshold,
      createdBy: input.actor.userId,
    });
    await tx.replaceRecipients(
      campaign.id,
      contacts.map((contact) => personalizePair(subject, body, contact)),
    );
    return tx.updateCampaign(campaign.id, { totalRecipients: contacts.length });
  });
}

export async function updateCampaignContent(input: {
  store: Store;
  id: number;
  patch: { name?: string; subject?: string; body?: string; senderName?: string };
}): Promise<Campaign> {
  const campaign = await requireCampaign(input.store, input.id);
  assertAction(campaign, 'edit');
  const subject = input.patch.subject === undefined ? undefined : sanitizeHeader(input.patch.subject);
  const body = input.patch.body?.trim();
  return input.store.updateCampaign(campaign.id, {
    name: input.patch.name?.trim(),
    subject,
    body,
    senderName: input.patch.senderName === undefined ? undefined : sanitizeSenderName(input.patch.senderName),
    status: 'draft',
    approvedAt: null,
    approvedBy: null,
  });
}

export async function generatePreviews(input: { store: Store; config: AppConfig; id: number }) {
  const campaign = await requireCampaign(input.store, input.id);
  assertAction(campaign, 'preview');
  await assertRecipientsStillEligible(input.store, campaign, input.config.mode);
  const current = await loadAllRecipients(input.store, campaign.id);
  const contacts = await input.store.findContactsByIds(current.map((recipient) => recipient.contactId));
  const suppressed = await input.store.findActiveSuppressions(contacts.map((contact) => contact.emailNormalized));
  const usable = contacts.filter(
    (contact) =>
      contact.eligibilityStatus === 'eligible' &&
      isValidEmail(contact.email) &&
      !suppressed.has(contact.emailNormalized),
  );
  if (usable.length === 0) throw new AppError(400, 'No eligible recipients remain for this campaign.', 'NO_RECIPIENTS');
  if (usable.length > campaign.recipientLimit) {
    throw new AppError(400, 'Recipient count exceeds the campaign limit.', 'RECIPIENT_LIMIT');
  }
  await input.store.withTransaction(async (tx) => {
    await tx.replaceRecipients(
      campaign.id,
      usable.map((contact) => personalizePair(campaign.subject, campaign.body, contact)),
    );
    await tx.updateCampaign(campaign.id, { status: 'previewed', totalRecipients: usable.length });
  });
  const samples = await input.store.listRecipients(campaign.id, { page: 1, pageSize: 8 });
  return {
    campaign: await requireCampaign(input.store, campaign.id),
    totalRecipients: usable.length,
    dropped: current.length - usable.length,
    samples: samples.rows,
    footer: footerPreview(input.config.publicApiUrl, input.config.sesFromEmail),
  };
}

export async function approveCampaign(input: {
  store: Store;
  config: AppConfig;
  actor: Actor;
  id: number;
  confirmRecipientCount: number;
}): Promise<Campaign> {
  const campaign = await requireCampaign(input.store, input.id);
  assertAction(campaign, 'approve');
  const issues = await input.store.recipientIssueCounts(campaign.id);
  if (issues.total < 1) throw new AppError(400, 'Generate previews before approval.', 'NO_RECIPIENTS');
  if (issues.suppressed > 0 || issues.ineligible > 0) {
    throw new AppError(409, 'Resolve suppressed or ineligible recipients before approval.', 'SUPPRESSION_BLOCKED', issues);
  }
  if (issues.total !== input.confirmRecipientCount) {
    throw new AppError(409, 'Recipient count confirmation does not match the campaign.', 'COUNT_MISMATCH', {
      total: issues.total,
    });
  }
  if (issues.total > campaign.recipientLimit) {
    throw new AppError(409, 'Recipient count exceeds the campaign limit.', 'RECIPIENT_LIMIT');
  }
  await assertRecipientsStillEligible(input.store, campaign, input.config.mode);
  const updated = await input.store.withTransaction(async (tx) => {
    await assertRecipientsStillEligible(tx, campaign, input.config.mode);
    const next = await tx.updateCampaign(campaign.id, {
      status: 'approved',
      approvedAt: new Date(),
      approvedBy: input.actor.userId,
    });
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'campaign_approved',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: { recipients: issues.total },
      ipAddress: input.actor.ipAddress,
    });
    return next;
  });
  return updated;
}

export async function startCampaign(input: {
  store: Store;
  config: AppConfig;
  actor: Actor;
  id: number;
  confirmRecipientCount: number;
}): Promise<{ campaign: Campaign; mode: 'dry_run' | 'live' }> {
  const campaign = await requireCampaign(input.store, input.id);
  assertAction(campaign, 'start');
  if (!campaign.approvedAt) throw new AppError(409, 'Campaign approval is required before sending.', 'APPROVAL_REQUIRED');
  const issues = await input.store.recipientIssueCounts(campaign.id);
  if (issues.total !== input.confirmRecipientCount) {
    throw new AppError(409, 'Recipient count confirmation does not match the campaign.', 'COUNT_MISMATCH', {
      total: issues.total,
    });
  }
  if (input.config.mode === 'live') {
    const scheduler = await input.store.getSchedulerSettings();
    if (scheduler.status === 'enabled') {
      const bounds = dayBounds(new Date(), scheduler.timezone);
      const accepted = await input.store.countSmtpAcceptedBetween(bounds.start, bounds.end);
      const remaining = scheduler.dailyLimit - accepted;
      if (issues.total > remaining) {
        throw new AppError(409, 'This campaign exceeds the remaining daily outreach limit.', 'DAILY_QUOTA', {
          remaining,
          dailyLimit: scheduler.dailyLimit,
        });
      }
    }
  }
  const guards = evaluateSendGuards({
    mode: input.config.mode,
    campaignStatus: campaign.status,
    hasApproval: Boolean(campaign.approvedAt),
    recipientCount: issues.total,
    recipientLimit: campaign.recipientLimit,
    suppressedInCampaign: issues.suppressed,
    ineligibleInCampaign: issues.ineligible,
    sendRatePerSecond: campaign.sendRatePerSecond,
    configuredMaxSendRate: input.config.maxSendRate,
    batchSize: campaign.batchSize,
    configuredMaxBatchSize: input.config.maxBatchSize,
    sesHost: input.config.sesHost,
    sesPort: input.config.sesPort,
    sesUser: input.config.sesUser,
    sesPassword: input.config.sesPassword,
    sesFromEmail: input.config.sesFromEmail,
    sesFromName: input.config.sesFromName,
    senderEmail: campaign.senderEmail,
    accountApproved: input.config.sesAccountApproved,
    liveConfirmationPresent: input.config.liveConfirmationPresent,
    sendingEnabled: input.config.sendingEnabled,
    dryRunFlag: input.config.dryRunFlag,
  });
  if (!guards.ok) {
    throw new AppError(409, 'Sending checks failed.', 'SEND_GUARDS_FAILED', { failures: guards.failures });
  }
  await assertRecipientsStillEligible(input.store, campaign, input.config.mode);
  const updated = await input.store.withTransaction(async (tx) => {
    await assertRecipientsStillEligible(tx, campaign, input.config.mode);
    await tx.resetCircuitFailures(campaign.id);
    const next = await tx.updateCampaign(campaign.id, {
      status: 'sending',
      dryRun: input.config.mode === 'dry_run',
      startedAt: campaign.startedAt ?? new Date(),
      pausedAt: null,
      sendingLockToken: null,
      sendingLockAcquiredAt: null,
    });
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'campaign_started',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: { mode: input.config.mode, recipients: issues.total },
      ipAddress: input.actor.ipAddress,
    });
    return next;
  });
  return { campaign: updated, mode: input.config.mode };
}

export async function pauseCampaign(input: { store: Store; actor: Actor; id: number }): Promise<Campaign> {
  const campaign = await requireCampaign(input.store, input.id);
  assertAction(campaign, 'pause');
  return input.store.withTransaction(async (tx) => {
    const next = await tx.updateCampaign(campaign.id, {
      status: 'paused',
      pausedAt: new Date(),
      sendingLockToken: null,
      sendingLockAcquiredAt: null,
    });
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'campaign_paused',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: null,
      ipAddress: input.actor.ipAddress,
    });
    return next;
  });
}

export async function cancelCampaign(input: { store: Store; actor: Actor; id: number }): Promise<Campaign> {
  const campaign = await requireCampaign(input.store, input.id);
  assertAction(campaign, 'cancel');
  return input.store.withTransaction(async (tx) => {
    const cancelled = await tx.cancelOpenRecipients(campaign.id);
    const next = await tx.updateCampaign(campaign.id, {
      status: 'cancelled',
      cancelledAt: new Date(),
      sendingLockToken: null,
      sendingLockAcquiredAt: null,
    });
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'campaign_cancelled',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: { cancelledRecipients: cancelled },
      ipAddress: input.actor.ipAddress,
    });
    return next;
  });
}

export async function campaignReport(store: Store, id: number) {
  const campaign = await requireCampaign(store, id);
  const recipients = await loadAllRecipients(store, id);
  const events = await store.listEventsForCampaign(id, { page: 1, pageSize: 100 });
  const count = (status: Recipient['status']) => recipients.filter((recipient) => recipient.status === status).length;
  return {
    campaign,
    counts: {
      recipients: recipients.length,
      attempts: recipients.reduce((sum, recipient) => sum + recipient.attemptCount, 0),
      pending: count('pending') + count('retry_wait') + count('sending'),
      simulated: count('simulated'),
      accepted: recipients.filter((recipient) =>
        ['accepted', 'delivered', 'bounced', 'complained'].includes(recipient.status),
      ).length,
      delivered: count('delivered'),
      bounced: count('bounced'),
      complained: count('complained'),
      failed: count('failed'),
      suppressed: count('suppressed'),
      cancelled: count('cancelled'),
      unsubscribes: recipients.filter((recipient) => recipient.eligibilityStatus === 'suppressed').length,
    },
    note: 'Accepted means the provider took the message. Confirmed delivery is counted only after a delivery event. Simulated results are not deliveries.',
    events,
  };
}

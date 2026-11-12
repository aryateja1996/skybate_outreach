import type { AppConfig } from '../config';
import { DEFAULT_BODY, DEFAULT_SUBJECT } from '../domain/defaultTemplate';
import {
  dayBounds,
  executionInstant,
  isScheduledMomentDue,
  nextRunAt,
  validateSchedulerConfig,
  zonedParts,
} from '../domain/scheduler';
import { AppError } from '../errors';
import type { Store } from '../store';
import type { SchedulerRun, SchedulerSettings, SchedulerTrigger } from '../types';
import { generateDraft, type AiClient } from './ai';
import { approveCampaign, cancelCampaign, createCampaign, generatePreviews, startCampaign } from './campaigns';
import type { Actor } from './contacts';
import type { MailTransport } from './mailer';
import { runSendTick } from './sending';

const COMPLETION_MESSAGE = 'All eligible contacts have been processed. Import more prospects and enable the scheduler to continue.';

export interface SchedulerDashboard {
  settings: SchedulerSettings;
  eligibleContacts: number;
  successfullyContacted: number;
  remainingEligible: number;
  todayBatchCount: number;
  todayRecipientCount: number;
  today: {
    simulated: number;
    accepted: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
  };
  nextRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  history: SchedulerRun[];
  completionMessage: string | null;
  dueNow: boolean;
}

export interface SchedulerRunResult {
  outcome: 'ran' | 'skipped' | 'completed' | 'duplicate' | 'quota';
  message: string;
  run: SchedulerRun | null;
}

function actorFrom(userId: number, ipAddress: string | null): Actor {
  return { userId, role: 'admin', ipAddress };
}

async function resolveContent(input: {
  store: Store;
  config: AppConfig;
  aiClient: AiClient | null;
  settings: SchedulerSettings;
  actorUserId: number;
}): Promise<{ subject: string; body: string; templateId: number | null }> {
  const templates = await input.store.listTemplates();
  const selected = input.settings.templateId
    ? templates.find((template) => template.id === input.settings.templateId) ?? null
    : templates.find((template) => template.isDefault) ?? templates[0] ?? null;
  if (input.settings.templateId && !selected) {
    throw new AppError(400, 'The selected email template no longer exists.', 'TEMPLATE_NOT_FOUND');
  }
  let subject = selected?.subject ?? DEFAULT_SUBJECT;
  let body = selected?.body ?? DEFAULT_BODY;
  if (input.settings.aiPersonalization) {
    const draft = await generateDraft({
      store: input.store,
      client: input.aiClient,
      config: input.config,
      purpose: 'Vendor empanelment outreach for one daily batch. Keep the standard Skybate facts and placeholders.',
      style: 'professional',
      createdBy: input.actorUserId,
    });
    subject = draft.subject;
    body = draft.body;
  }
  if (subject.trim().length < 3 || body.trim().length < 20) {
    throw new AppError(400, 'The scheduler template does not contain a usable subject and message.', 'VALIDATION_ERROR');
  }
  return { subject, body, templateId: selected?.id ?? null };
}

async function nextBatchNumber(store: Store): Promise<number> {
  const runs = await store.listSchedulerRuns(1000);
  return runs.reduce((max, run) => Math.max(max, run.batchNumber), 0) + 1;
}

export async function getSchedulerDashboard(store: Store, now = new Date(), mode: 'dry_run' | 'live' = 'dry_run'): Promise<SchedulerDashboard> {
  const settings = await store.getSchedulerSettings();
  const pools = await store.countSchedulerPools(mode);
  const dateKey = zonedParts(now, settings.timezone).dateKey;
  const today = await store.schedulerDayCounts(dateKey);
  const existing = await store.findSchedulerRunByDate(dateKey);
  const dueNow = isScheduledMomentDue(now, settings, Boolean(existing));
  const next = dueNow
    ? executionInstant(now, settings)
    : settings.status === 'enabled'
      ? nextRunAt(now, settings, existing ? { afterDate: dateKey } : undefined)
      : settings.nextRunAt;
  return {
    settings,
    eligibleContacts: pools.eligible,
    successfullyContacted: pools.contacted,
    remainingEligible: pools.remaining,
    todayBatchCount: today.batches,
    todayRecipientCount: today.recipients,
    today: {
      simulated: today.simulated,
      accepted: today.accepted,
      delivered: today.delivered,
      bounced: today.bounced,
      complained: today.complained,
      failed: today.failed,
    },
    nextRunAt: next,
    lastSuccessAt: settings.lastSuccessAt,
    lastError: settings.lastError,
    history: await store.listSchedulerRuns(30),
    completionMessage: settings.status === 'completed' ? COMPLETION_MESSAGE : null,
    dueNow,
  };
}

export async function saveSchedulerConfig(input: {
  store: Store;
  config: AppConfig;
  actor: Actor;
  patch: {
    dailyLimit: number;
    executionTime: string;
    workingDays: number[];
    timezone: string;
    templateId: number | null;
    aiPersonalization: boolean;
    startDate: string | null;
  };
  now?: Date;
}): Promise<SchedulerSettings> {
  const problem = validateSchedulerConfig({ ...input.patch, maxDailyLimit: input.config.maxRecipientsPerCampaign });
  if (problem) throw new AppError(400, problem, 'VALIDATION_ERROR');
  if (input.patch.templateId) {
    const template = await input.store.findTemplate(input.patch.templateId);
    if (!template) throw new AppError(400, 'Choose a template that exists.', 'TEMPLATE_NOT_FOUND');
  }
  const now = input.now ?? new Date();
  const current = await input.store.getSchedulerSettings();
  const next = {
    ...current,
    ...input.patch,
    workingDays: [...new Set(input.patch.workingDays)].sort((left, right) => left - right),
    updatedBy: input.actor.userId,
    nextRunAt: current.status === 'enabled'
      ? nextRunAt(now, { ...current, ...input.patch }, undefined)
      : current.nextRunAt,
  };
  const saved = await input.store.saveSchedulerSettings(next);
  await input.store.addAudit({
    actorUserId: input.actor.userId,
    action: 'scheduler_updated',
    entityType: 'scheduler',
    entityId: 1,
    metadata: { dailyLimit: saved.dailyLimit, executionTime: saved.executionTime, timezone: saved.timezone },
    ipAddress: input.actor.ipAddress,
  });
  return saved;
}

async function changeStatus(input: {
  store: Store;
  actor: Actor;
  status: SchedulerSettings['status'];
  action: string;
  mode?: 'dry_run' | 'live';
  now?: Date;
}): Promise<SchedulerSettings> {
  const now = input.now ?? new Date();
  const current = await input.store.getSchedulerSettings();
  if (input.status === 'enabled') {
    const pools = await input.store.countSchedulerPools(input.mode ?? 'dry_run');
    if (pools.remaining < 1) {
      const completed = await input.store.saveSchedulerSettings({
        ...current,
        status: 'completed',
        nextRunAt: null,
        lastError: null,
        updatedBy: input.actor.userId,
      });
      return completed;
    }
  }
  const saved = await input.store.saveSchedulerSettings({
    ...current,
    status: input.status,
    updatedBy: input.actor.userId,
    lastError: input.status === 'disabled' ? current.lastError : null,
    nextRunAt: input.status === 'enabled' ? nextRunAt(now, current) : null,
  });
  await input.store.addAudit({
    actorUserId: input.actor.userId,
    action: input.action,
    entityType: 'scheduler',
    entityId: 1,
    metadata: { status: saved.status },
    ipAddress: input.actor.ipAddress,
  });
  return saved;
}

export function enableScheduler(input: { store: Store; actor: Actor; now?: Date; mode?: 'dry_run' | 'live' }): Promise<SchedulerSettings> {
  return changeStatus({ ...input, status: 'enabled', action: 'scheduler_enabled' });
}

export function pauseScheduler(input: { store: Store; actor: Actor; now?: Date }): Promise<SchedulerSettings> {
  return changeStatus({ ...input, status: 'paused', action: 'scheduler_paused' });
}

export function resumeScheduler(input: { store: Store; actor: Actor; now?: Date; mode?: 'dry_run' | 'live' }): Promise<SchedulerSettings> {
  return changeStatus({ ...input, status: 'enabled', action: 'scheduler_resumed' });
}

export async function stopScheduler(input: { store: Store; actor: Actor }): Promise<SchedulerSettings> {
  const running = await input.store.listRunningSchedulerRuns();
  for (const run of running) {
    if (run.campaignId) {
      const campaign = await input.store.findCampaign(run.campaignId);
      if (campaign && ['draft', 'previewed', 'approved', 'sending', 'paused'].includes(campaign.status)) {
        await cancelCampaign({ store: input.store, actor: input.actor, id: campaign.id });
      }
    }
    await input.store.updateSchedulerRun(run.id, {
      status: 'cancelled',
      finishedAt: new Date(),
      errorMessage: 'Stopped by an administrator.',
    });
  }
  return changeStatus({ ...input, status: 'disabled', action: 'scheduler_stopped' });
}

async function finalizeRun(store: Store, run: SchedulerRun, now: Date, mode: 'dry_run' | 'live'): Promise<SchedulerRun> {
  if (!run.campaignId) return run;
  const campaign = await store.findCampaign(run.campaignId);
  if (!campaign || campaign.status === 'sending') return run;
  const settings = await store.getSchedulerSettings();
  if (campaign.status === 'completed') {
    const pools = await store.countSchedulerPools(mode);
    const finished = await store.updateSchedulerRun(run.id, { status: 'completed', finishedAt: now, errorMessage: null });
    await store.saveSchedulerSettings({
      ...settings,
      status: pools.remaining < 1 ? 'completed' : settings.status,
      lastSuccessAt: now,
      lastError: null,
      nextRunAt: pools.remaining < 1 ? null : nextRunAt(now, settings, { afterDate: run.scheduledDate }),
    });
    return finished;
  }
  const message = campaign.status === 'paused'
    ? 'The daily batch paused before every recipient was finished. It was not started again automatically.'
    : `The daily batch ended as ${campaign.status}.`;
  const finished = await store.updateSchedulerRun(run.id, { status: 'failed', finishedAt: now, errorMessage: message });
  await store.saveSchedulerSettings({ ...settings, lastError: message });
  return finished;
}

export async function recoverScheduler(store: Store, now = new Date(), mode: 'dry_run' | 'live' = 'dry_run'): Promise<void> {
  const running = await store.listRunningSchedulerRuns();
  const settings = await store.getSchedulerSettings();
  for (const run of running) {
    const campaign = run.campaignId ? await store.findCampaign(run.campaignId) : null;
    if (campaign?.status === 'sending') continue;
    if (campaign?.status === 'completed') {
      await finalizeRun(store, run, now, mode);
      continue;
    }
    const message = 'The server restarted during this batch. Unresolved and ambiguous sends were not retried, and this date was not run again.';
    await store.updateSchedulerRun(run.id, { status: 'failed', finishedAt: now, errorMessage: message });
    await store.saveSchedulerSettings({ ...settings, lastError: message });
  }
}

async function drainDryRun(input: {
  store: Store;
  config: AppConfig;
  mailer: MailTransport;
  campaignId: number;
  limit: number;
}): Promise<void> {
  for (let step = 0; step < input.limit + 2; step += 1) {
    const campaign = await input.store.findCampaign(input.campaignId);
    if (!campaign || campaign.status !== 'sending') return;
    await runSendTick({ store: input.store, config: input.config, mailer: input.mailer });
  }
}

export async function executeSchedulerRun(input: {
  store: Store;
  config: AppConfig;
  mailer: MailTransport;
  aiClient: AiClient | null;
  actor: Actor | null;
  trigger: SchedulerTrigger;
  now?: Date;
  drain?: boolean;
}): Promise<SchedulerRunResult> {
  const now = input.now ?? new Date();
  const initial = await input.store.getSchedulerSettings();
  const actorUserId = input.actor?.userId ?? initial.updatedBy;
  if (!actorUserId) {
    throw new AppError(409, 'An administrator must enable the scheduler before it can run.', 'SCHEDULER_OWNER');
  }
  const actor = input.actor ?? actorFrom(actorUserId, null);
  let content: { subject: string; body: string; templateId: number | null };
  try {
    content = await resolveContent({
      store: input.store,
      config: input.config,
      aiClient: input.aiClient,
      settings: initial,
      actorUserId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The scheduler template could not be prepared.';
    await input.store.saveSchedulerSettings({ ...initial, lastError: message });
    throw error;
  }

  const prepared = await input.store.withTransaction(async (tx) => {
    const settings = await tx.lockSchedulerSettings();
    if (input.trigger === 'schedule' && settings.status !== 'enabled') {
      return { kind: 'skipped' as const, message: 'The scheduler is not enabled.' };
    }
    if (input.trigger === 'manual' && settings.status !== 'enabled' && settings.status !== 'paused') {
      throw new AppError(409, 'Enable or pause the scheduler before running a dry-run batch.', 'SCHEDULER_INACTIVE');
    }
    const dateKey = zonedParts(now, settings.timezone).dateKey;
    const existing = await tx.findSchedulerRunByDate(dateKey);
    if (input.trigger === 'schedule' && !isScheduledMomentDue(now, settings, Boolean(existing))) {
      return { kind: 'skipped' as const, message: 'This is outside the scheduled working window.' };
    }
    if (existing) {
      if (input.trigger === 'manual') {
        throw new AppError(409, 'This date already has a scheduler batch.', 'SCHEDULER_ALREADY_RAN');
      }
      return { kind: 'duplicate' as const, message: 'This working date already has a scheduler batch.' };
    }
    const pools = await tx.countSchedulerPools(input.config.mode);
    if (pools.remaining < 1) {
      await tx.saveSchedulerSettings({ ...settings, status: 'completed', nextRunAt: null, lastError: null });
      return { kind: 'completed' as const, message: COMPLETION_MESSAGE };
    }
    let limit = settings.dailyLimit;
    if (input.config.mode === 'live' && input.trigger === 'schedule') {
      const bounds = dayBounds(now, settings.timezone);
      const accepted = await tx.countSmtpAcceptedBetween(bounds.start, bounds.end);
      limit = settings.dailyLimit - accepted;
      if (limit < 1) {
        const run = await tx.insertSchedulerRun({
          scheduledDate: dateKey,
          batchNumber: await nextBatchNumber(tx),
          trigger: input.trigger,
          startedAt: now,
        });
        const failed = await tx.updateSchedulerRun(run.id, {
          status: 'failed',
          selectedCount: 0,
          finishedAt: now,
          errorMessage: 'The daily SMTP quota was already used by other campaigns.',
        });
        await tx.saveSchedulerSettings({
          ...settings,
          lastRunAt: now,
          lastError: failed.errorMessage,
          nextRunAt: nextRunAt(now, settings, { afterDate: dateKey }),
        });
        return { kind: 'quota' as const, message: failed.errorMessage ?? 'Daily quota is exhausted.', run: failed };
      }
    }
    const contacts = await tx.selectSchedulerContacts(limit, input.config.mode);
    if (contacts.length === 0) {
      await tx.saveSchedulerSettings({ ...settings, status: 'completed', nextRunAt: null, lastError: null });
      return { kind: 'completed' as const, message: COMPLETION_MESSAGE };
    }
    const run = await tx.insertSchedulerRun({
      scheduledDate: dateKey,
      batchNumber: await nextBatchNumber(tx),
      trigger: input.trigger,
      startedAt: now,
    });
    const campaign = await createCampaign({
      store: tx,
      config: input.config,
      actor,
      name: `Daily outreach ${dateKey} batch ${run.batchNumber}`,
      templateId: content.templateId,
      subject: content.subject,
      body: content.body,
      senderName: input.config.sesFromName,
      recipientLimit: contacts.length,
      contactIds: contacts.map((contact) => contact.id),
    });
    await generatePreviews({ store: tx, config: input.config, id: campaign.id });
    await approveCampaign({ store: tx, config: input.config, actor, id: campaign.id, confirmRecipientCount: contacts.length });
    const started = await startCampaign({
      store: tx,
      config: input.config,
      actor,
      id: campaign.id,
      confirmRecipientCount: contacts.length,
    });
    if (input.trigger === 'manual' || input.config.mode !== 'live') {
      await tx.updateCampaign(started.campaign.id, { dryRun: true });
    }
    const updated = await tx.updateSchedulerRun(run.id, { campaignId: started.campaign.id, selectedCount: contacts.length });
    await tx.saveSchedulerSettings({
      ...settings,
      lastRunAt: now,
      lastError: null,
      updatedBy: actor.userId,
      nextRunAt: nextRunAt(now, settings, { afterDate: dateKey }),
    });
    await tx.addAudit({
      actorUserId: actor.userId,
      action: 'scheduler_run_started',
      entityType: 'scheduler_run',
      entityId: updated.id,
      metadata: { campaignId: started.campaign.id, recipients: contacts.length, date: dateKey, dryRun: input.config.mode !== 'live' || input.trigger === 'manual' },
      ipAddress: actor.ipAddress,
    });
    return { kind: 'ran' as const, message: 'Daily batch started.', run: updated, campaignId: started.campaign.id, selected: contacts.length };
  });

  if (prepared.kind !== 'ran') {
    return { outcome: prepared.kind, message: prepared.message, run: 'run' in prepared ? prepared.run ?? null : null };
  }
  const shouldDrain = input.drain !== false && (input.trigger === 'manual' || input.config.mode !== 'live');
  if (shouldDrain) {
    await drainDryRun({
      store: input.store,
      config: input.config,
      mailer: input.mailer,
      campaignId: prepared.campaignId,
      limit: prepared.selected,
    });
    const latest = await input.store.findSchedulerRunByDate(zonedParts(now, initial.timezone).dateKey);
    if (latest) await finalizeRun(input.store, latest, now, input.config.mode);
  }
  const run = await input.store.findSchedulerRunByDate(zonedParts(now, (await input.store.getSchedulerSettings()).timezone).dateKey);
  return { outcome: 'ran', message: prepared.message, run };
}

export async function schedulerTick(input: {
  store: Store;
  config: AppConfig;
  mailer: MailTransport;
  aiClient: AiClient | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const running = await input.store.listRunningSchedulerRuns();
  for (const run of running) await finalizeRun(input.store, run, now, input.config.mode);
  const settings = await input.store.getSchedulerSettings();
  if (settings.status !== 'enabled' || !settings.updatedBy) return;
  const dateKey = zonedParts(now, settings.timezone).dateKey;
  const existing = await input.store.findSchedulerRunByDate(dateKey);
  if (!isScheduledMomentDue(now, settings, Boolean(existing))) return;
  await executeSchedulerRun({ ...input, actor: null, trigger: 'schedule', now, drain: input.config.mode !== 'live' });
}

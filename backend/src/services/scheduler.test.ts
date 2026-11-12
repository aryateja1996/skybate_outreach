import { describe, expect, it } from 'vitest';
import {
  executionInstant,
  isScheduledMomentDue,
  nextRunAt,
  recipientBlocksScheduler,
  validateSchedulerConfig,
  zonedDateTimeToUtc,
  zonedParts,
} from '../domain/scheduler';
import { hashPassword } from './bootstrap';
import { approveCampaign, createCampaign, generatePreviews, startCampaign } from './campaigns';
import { recoverOnStartup, runSendTick } from './sending';
import {
  enableScheduler,
  executeSchedulerRun,
  pauseScheduler,
  recoverScheduler,
  resumeScheduler,
  saveSchedulerConfig,
  schedulerTick,
  stopScheduler,
} from './scheduler';
import { buildTestApp, liveEnv, login } from '../test/helpers';
import type { Store } from '../store';
import type { NewContact } from '../store/types';
import type { AppConfig } from '../config';

const SAMPLE_SUBJECT = 'Vendor empanelment request for testing';
const SAMPLE_BODY = 'Hello {{contact_name}}, we would like to partner with {{company_name}} on technology hiring.';

const MONDAY_TEN_IST = new Date('2026-11-02T04:30:00.000Z');
const MONDAY_BEFORE_TEN = new Date('2026-11-02T04:29:00.000Z');
const MONDAY_AFTERNOON = new Date('2026-11-02T09:30:00.000Z');
const SATURDAY_TEN_IST = new Date('2026-11-07T04:30:00.000Z');
const TUESDAY_TEN_IST = new Date('2026-11-03T04:30:00.000Z');

function contacts(count: number, offset = 0): NewContact[] {
  return Array.from({ length: count }, (_, index) => {
    const number = offset + index + 1;
    return {
      email: `prospect${number}@example.com`,
      emailNormalized: `prospect${number}@example.com`,
      contactName: `Prospect ${number}`,
      companyName: `Company ${number}`,
      designation: null,
      website: null,
      source: 'test',
      eligibilityStatus: 'eligible',
      missingInfo: false,
    };
  });
}

async function adminActor(store: Store) {
  const admin = await store.findUserByEmail('admin@example.com');
  if (!admin) throw new Error('missing admin');
  return { userId: admin.id, role: 'admin' as const, ipAddress: null };
}

async function interruptInFlightSend(input: {
  store: Store;
  config: AppConfig;
  contactId: number;
  name: string;
}) {
  const actor = await adminActor(input.store);
  const held = await createCampaign({
    store: input.store,
    config: input.config,
    actor,
    name: input.name,
    templateId: null,
    subject: SAMPLE_SUBJECT,
    body: SAMPLE_BODY,
    senderName: input.config.sesFromName,
    recipientLimit: 1,
    contactIds: [input.contactId],
  });
  await generatePreviews({ store: input.store, config: input.config, id: held.id });
  await approveCampaign({ store: input.store, config: input.config, actor, id: held.id, confirmRecipientCount: 1 });
  await startCampaign({
    store: input.store,
    config: input.config,
    actor,
    id: held.id,
    confirmRecipientCount: 1,
  });
  await input.store.claimRecipientBatch(held.id, 1, 'test');
  await recoverOnStartup(input.store);
  const campaign = await input.store.findCampaign(held.id);
  const recipients = await input.store.listRecipients(held.id, { page: 1, pageSize: 5 });
  return { campaign, recipient: recipients.rows[0] };
}

async function readyScheduler(store: Store, dailyLimit = 20) {
  const admin = await store.findUserByEmail('admin@example.com');
  if (!admin) throw new Error('missing admin');
  const actor = { userId: admin.id, role: 'admin' as const, ipAddress: null };
  const built = await buildTestApp();
  await saveSchedulerConfig({
    store,
    config: built.config,
    actor,
    patch: {
      dailyLimit,
      executionTime: '10:00',
      workingDays: [1, 2, 3, 4, 5],
      timezone: 'Asia/Kolkata',
      templateId: null,
      aiPersonalization: false,
      startDate: null,
    },
  });
  await enableScheduler({ store, actor });
  return { actor, config: built.config };
}

describe('scheduler calendar', () => {
  const settings = {
    status: 'enabled' as const,
    executionTime: '10:00',
    workingDays: [1, 2, 3, 4, 5],
    timezone: 'Asia/Kolkata',
    startDate: null,
  };

  it('treats 10:00 Asia/Kolkata as the Monday execution instant', () => {
    expect(zonedParts(MONDAY_TEN_IST, 'Asia/Kolkata')).toMatchObject({ dateKey: '2026-11-02', hour: 10, minute: 0, weekday: 1 });
    expect(executionInstant(MONDAY_TEN_IST, settings).toISOString()).toBe('2026-11-02T04:30:00.000Z');
    expect(isScheduledMomentDue(MONDAY_BEFORE_TEN, settings, false)).toBe(false);
    expect(isScheduledMomentDue(MONDAY_TEN_IST, settings, false)).toBe(true);
    expect(isScheduledMomentDue(SATURDAY_TEN_IST, settings, false)).toBe(false);
    expect(isScheduledMomentDue(MONDAY_AFTERNOON, settings, false)).toBe(true);
    expect(isScheduledMomentDue(MONDAY_AFTERNOON, settings, true)).toBe(false);
  });

  it('advances to the next working morning at 10:00 Asia/Kolkata', () => {
    const fridayTenIst = new Date('2026-11-06T04:30:00.000Z');
    const sundayTenIst = new Date('2026-11-08T04:30:00.000Z');
    const tuesdayTenIst = '2026-11-03T04:30:00.000Z';
    const followingMonday = '2026-11-09T04:30:00.000Z';

    expect(nextRunAt(MONDAY_TEN_IST, settings)?.toISOString()).toBe(tuesdayTenIst);
    expect(nextRunAt(MONDAY_TEN_IST, settings, { afterDate: '2026-11-02' })?.toISOString()).toBe(tuesdayTenIst);
    expect(zonedParts(new Date(tuesdayTenIst), 'Asia/Kolkata')).toMatchObject({ dateKey: '2026-11-03', hour: 10, minute: 0, weekday: 2 });

    expect(nextRunAt(fridayTenIst, settings)?.toISOString()).toBe(followingMonday);
    expect(nextRunAt(fridayTenIst, settings, { afterDate: '2026-11-06' })?.toISOString()).toBe(followingMonday);
    expect(nextRunAt(SATURDAY_TEN_IST, settings)?.toISOString()).toBe(followingMonday);
    expect(nextRunAt(sundayTenIst, settings)?.toISOString()).toBe(followingMonday);
    expect(zonedParts(new Date(followingMonday), 'Asia/Kolkata')).toMatchObject({ dateKey: '2026-11-09', hour: 10, minute: 0, weekday: 1 });
  });

  it('keeps 10:00 Asia/Kolkata at 04:30 UTC through the year', () => {
    for (const [year, month, day] of [[2026, 1, 15], [2026, 6, 15], [2026, 11, 2], [2026, 11, 9]] as const) {
      const instant = zonedDateTimeToUtc(year, month, day, 10, 0, 'Asia/Kolkata');
      expect(instant.toISOString()).toBe(
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T04:30:00.000Z`,
      );
      expect(zonedParts(instant, 'Asia/Kolkata')).toMatchObject({ year, month, day, hour: 10, minute: 0 });
    }
  });

  it('blocks simulated recipients only while choosing another dry-run batch', () => {
    expect(recipientBlocksScheduler({
      status: 'simulated',
      failureClass: 'none',
      campaignDryRun: true,
      mode: 'dry_run',
    })).toBe(true);
    expect(recipientBlocksScheduler({
      status: 'simulated',
      failureClass: 'none',
      campaignDryRun: true,
      mode: 'live',
    })).toBe(false);
    expect(recipientBlocksScheduler({
      status: 'accepted',
      failureClass: 'none',
      campaignDryRun: false,
      mode: 'live',
    })).toBe(true);
    expect(recipientBlocksScheduler({
      status: 'failed',
      failureClass: 'ambiguous',
      campaignDryRun: false,
      mode: 'live',
    })).toBe(true);
    expect(recipientBlocksScheduler({
      status: 'failed',
      failureClass: 'ambiguous',
      campaignDryRun: true,
      mode: 'live',
    })).toBe(false);
  });

  it('rejects an invalid limit and time', () => {
    expect(validateSchedulerConfig({
      dailyLimit: 0,
      executionTime: '10:00',
      workingDays: [1],
      timezone: 'Asia/Kolkata',
      startDate: null,
      maxDailyLimit: 25,
    })).toMatch(/Daily limit/);
    expect(validateSchedulerConfig({
      dailyLimit: 20,
      executionTime: '25:00',
      workingDays: [1],
      timezone: 'Asia/Kolkata',
      startDate: null,
      maxDailyLimit: 25,
    })).toMatch(/HH:MM/);
  });
});

describe('scheduler execution', () => {
  it('selects exactly 20 eligible contacts in id order and leaves the rest for the next working day', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(25));
    const { actor } = await readyScheduler(built.store, 20);
    const first = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    expect(first.outcome).toBe('ran');
    expect(first.run?.selectedCount).toBe(20);
    expect((await built.store.getSchedulerSettings()).nextRunAt?.toISOString()).toBe(TUESDAY_TEN_IST.toISOString());
    expect(built.mailer.calls).toBe(0);
    const all = await built.store.listContacts({ page: 1, pageSize: 100 });
    expect(all.rows.every((contact) => contact.isContacted === false)).toBe(true);
    const second = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'schedule',
      now: TUESDAY_TEN_IST,
    });
    expect(second.run?.selectedCount).toBe(5);
    expect(await built.store.countSchedulerPools('dry_run')).toMatchObject({ remaining: 0 });
    expect((await built.store.getSchedulerSettings()).status).toBe('completed');
  });

  it('selects fewer than the limit when fewer eligible contacts remain and does not create an empty campaign', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(7));
    const { actor } = await readyScheduler(built.store, 20);
    const result = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    expect(result.run?.selectedCount).toBe(7);
    const again = await schedulerTick({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      now: TUESDAY_TEN_IST,
    });
    expect(again).toBeUndefined();
    expect((await built.store.listCampaigns({ page: 1, pageSize: 10 })).total).toBe(1);
  });

  it('excludes contacted, invalid, suppressed, and ambiguous contacts', async () => {
    const built = await buildTestApp();
    const inserted = await built.store.insertContacts(contacts(5));
    await built.store.updateContact(inserted[1].id, { eligibilityStatus: 'invalid_email', email: 'bad', emailNormalized: 'bad' });
    await built.store.upsertSuppression({
      emailNormalized: inserted[2].emailNormalized,
      reason: 'unsubscribe',
      source: 'test',
      notes: null,
      createdBy: null,
    });
    await built.store.recordAcceptedOutreach({ contactId: inserted[3].id, campaignId: 1, sentAt: MONDAY_TEN_IST });
    const admin = await built.store.findUserByEmail('admin@example.com');
    const held = await createCampaign({
      store: built.store,
      config: built.config,
      actor: { userId: admin!.id, role: 'admin', ipAddress: null },
      name: 'Ambiguous',
      templateId: null,
      subject: 'Vendor empanelment request for testing',
      body: 'Hello {{contact_name}}, we would like to partner with {{company_name}} on technology hiring.',
      senderName: 'Sales Team',
      recipientLimit: 1,
      contactIds: [inserted[4].id],
    });
    await built.store.claimRecipientBatch(held.id, 1, 'test');
    await recoverOnStartup(built.store);
    const { actor } = await readyScheduler(built.store, 20);
    const result = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    expect(result.run?.selectedCount).toBe(1);
    const recipients = await built.store.listRecipients(result.run!.campaignId!, { page: 1, pageSize: 10 });
    expect(recipients.rows.map((row) => row.contactId)).toEqual([inserted[0].id]);
  });

  it('runs one Monday batch after a missed morning and does not add weekend catch-up batches', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(3));
    await readyScheduler(built.store, 20);
    await schedulerTick({ store: built.store, config: built.config, mailer: built.mailer, aiClient: null, now: SATURDAY_TEN_IST });
    await schedulerTick({ store: built.store, config: built.config, mailer: built.mailer, aiClient: null, now: MONDAY_AFTERNOON });
    await schedulerTick({ store: built.store, config: built.config, mailer: built.mailer, aiClient: null, now: MONDAY_AFTERNOON });
    const campaigns = await built.store.listCampaigns({ page: 1, pageSize: 10 });
    expect(campaigns.total).toBe(1);
    expect(await built.store.findSchedulerRunByDate('2026-11-02')).toBeTruthy();
    expect(await built.store.findSchedulerRunByDate('2026-11-07')).toBeNull();
  });

  it('does not start a second batch for the same date or while one is still running', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(4));
    const { actor } = await readyScheduler(built.store, 20);
    const first = executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
      drain: false,
    });
    const second = executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
      drain: false,
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await built.store.listCampaigns({ page: 1, pageSize: 10 })).total).toBe(1);
  });

  it('marks a restarted batch failed and does not run that date again', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(2));
    const { actor } = await readyScheduler(built.store, 20);
    await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
      drain: false,
    });
    await recoverOnStartup(built.store);
    await recoverScheduler(built.store, MONDAY_AFTERNOON);
    const run = await built.store.findSchedulerRunByDate('2026-11-02');
    expect(run?.status).toBe('failed');
    await expect(executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_AFTERNOON,
    })).rejects.toMatchObject({ code: 'SCHEDULER_ALREADY_RAN' });
  });

  it('pauses, resumes, and stops without sending mail', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(2));
    const { actor } = await readyScheduler(built.store, 20);
    await pauseScheduler({ store: built.store, actor });
    await schedulerTick({ store: built.store, config: built.config, mailer: built.mailer, aiClient: null, now: MONDAY_TEN_IST });
    expect((await built.store.listCampaigns({ page: 1, pageSize: 10 })).total).toBe(0);
    await resumeScheduler({ store: built.store, actor });
    await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
      drain: false,
    });
    await stopScheduler({ store: built.store, actor });
    expect((await built.store.getSchedulerSettings()).status).toBe('disabled');
    expect(built.mailer.calls).toBe(0);
    const recipients = await built.store.listRecipients(
      (await built.store.findSchedulerRunByDate('2026-11-02'))!.campaignId!,
      { page: 1, pageSize: 10 },
    );
    expect(recipients.rows.every((row) => row.status === 'cancelled' || row.status === 'simulated')).toBe(true);
  });

  it('picks newly imported contacts on the next working day after completion', async () => {
    const built = await buildTestApp();
    await built.store.insertContacts(contacts(1));
    const { actor } = await readyScheduler(built.store, 20);
    await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    expect((await built.store.getSchedulerSettings()).status).toBe('completed');
    await built.store.insertContacts(contacts(1, 1));
    const enabled = await enableScheduler({ store: built.store, actor });
    expect(enabled.status).toBe('enabled');
    const next = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'schedule',
      now: TUESDAY_TEN_IST,
    });
    expect(next.run?.selectedCount).toBe(1);
    expect(built.mailer.calls).toBe(0);
  });

  it('counts live SMTP acceptances against the shared daily limit', async () => {
    const built = await buildTestApp(liveEnv);
    const inserted = await built.store.insertContacts(contacts(4));
    const admin = await built.store.findUserByEmail('admin@example.com');
    const actor = { userId: admin!.id, role: 'admin' as const, ipAddress: null };
    await saveSchedulerConfig({
      store: built.store,
      config: built.config,
      actor,
      patch: {
        dailyLimit: 2,
        executionTime: '00:00',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
        timezone: 'Asia/Kolkata',
        templateId: null,
        aiPersonalization: false,
        startDate: null,
      },
    });
    await enableScheduler({ store: built.store, actor });
    const campaign = await createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Manual live',
      templateId: null,
      subject: 'Vendor empanelment request for testing',
      body: 'Hello {{contact_name}}, we would like to partner with {{company_name}} on technology hiring.',
      senderName: built.config.sesFromName,
      recipientLimit: 2,
      contactIds: [inserted[0].id, inserted[1].id],
    });
    await generatePreviews({ store: built.store, config: built.config, id: campaign.id });
    await approveCampaign({ store: built.store, config: built.config, actor, id: campaign.id, confirmRecipientCount: 2 });
    await startCampaign({ store: built.store, config: built.config, actor, id: campaign.id, confirmRecipientCount: 2 });
    for (let step = 0; step < 4; step += 1) await runSendTick({ store: built.store, config: built.config, mailer: built.mailer });
    expect(built.mailer.calls).toBe(2);
    const overflow = await createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Over the limit',
      templateId: null,
      subject: 'Vendor empanelment request for testing',
      body: 'Hello {{contact_name}}, we would like to partner with {{company_name}} on technology hiring.',
      senderName: built.config.sesFromName,
      recipientLimit: 1,
      contactIds: [inserted[2].id],
    });
    await generatePreviews({ store: built.store, config: built.config, id: overflow.id });
    await approveCampaign({ store: built.store, config: built.config, actor, id: overflow.id, confirmRecipientCount: 1 });
    await expect(startCampaign({
      store: built.store,
      config: built.config,
      actor,
      id: overflow.id,
      confirmRecipientCount: 1,
    })).rejects.toMatchObject({ code: 'DAILY_QUOTA' });
    const scheduled = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'schedule',
      now: new Date(),
      drain: false,
    });
    expect(scheduled.outcome).toBe('quota');
    expect(built.mailer.calls).toBe(2);
  });

  it('keeps a previously simulated contact eligible for live sending', async () => {
    const dry = await buildTestApp();
    const inserted = await dry.store.insertContacts(contacts(1));
    const simulatedId = inserted[0].id;
    const { actor } = await readyScheduler(dry.store, 1);
    const monday = await executeSchedulerRun({
      store: dry.store,
      config: dry.config,
      mailer: dry.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    const recipients = await dry.store.listRecipients(monday.run!.campaignId!, { page: 1, pageSize: 5 });
    expect(recipients.rows.map((row) => row.contactId)).toEqual([simulatedId]);
    expect(recipients.rows[0]?.status).toBe('simulated');
    const simulated = await dry.store.findContactById(simulatedId);
    expect(simulated?.isContacted).toBe(false);
    expect(simulated?.contactCount).toBe(0);
    const liveEligible = await dry.store.selectSchedulerContacts(10, 'live');
    expect(liveEligible.map((contact) => contact.id)).toEqual([simulatedId]);
    expect(dry.mailer.calls).toBe(0);
  });

  it('excludes a previously simulated contact from the next dry-run batch', async () => {
    const dry = await buildTestApp();
    const inserted = await dry.store.insertContacts(contacts(2));
    const simulatedId = inserted[0].id;
    const untouchedId = inserted[1].id;
    const { actor } = await readyScheduler(dry.store, 1);
    const monday = await executeSchedulerRun({
      store: dry.store,
      config: dry.config,
      mailer: dry.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    const mondayRecipients = await dry.store.listRecipients(monday.run!.campaignId!, { page: 1, pageSize: 5 });
    expect(mondayRecipients.rows.map((row) => row.contactId)).toEqual([simulatedId]);
    expect(mondayRecipients.rows[0]?.status).toBe('simulated');
    const dryEligible = await dry.store.selectSchedulerContacts(10, 'dry_run');
    expect(dryEligible.map((contact) => contact.id)).toEqual([untouchedId]);
    const tuesday = await executeSchedulerRun({
      store: dry.store,
      config: dry.config,
      mailer: dry.mailer,
      aiClient: null,
      actor,
      trigger: 'schedule',
      now: TUESDAY_TEN_IST,
    });
    const tuesdayRecipients = await dry.store.listRecipients(tuesday.run!.campaignId!, { page: 1, pageSize: 5 });
    expect(tuesdayRecipients.rows.map((row) => row.contactId)).toEqual([untouchedId]);
    expect(dry.mailer.calls).toBe(0);
  });

  it('excludes a contact after actual SMTP acceptance', async () => {
    const live = await buildTestApp(liveEnv);
    const inserted = await live.store.insertContacts(contacts(2));
    const acceptedId = inserted[0].id;
    const untouchedId = inserted[1].id;
    const actor = await adminActor(live.store);
    const campaign = await createCampaign({
      store: live.store,
      config: live.config,
      actor,
      name: 'Accepted live send',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: live.config.sesFromName,
      recipientLimit: 1,
      contactIds: [acceptedId],
    });
    await generatePreviews({ store: live.store, config: live.config, id: campaign.id });
    await approveCampaign({ store: live.store, config: live.config, actor, id: campaign.id, confirmRecipientCount: 1 });
    await startCampaign({ store: live.store, config: live.config, actor, id: campaign.id, confirmRecipientCount: 1 });
    await runSendTick({ store: live.store, config: live.config, mailer: live.mailer });
    const accepted = await live.store.findContactById(acceptedId);
    expect(accepted?.isContacted).toBe(true);
    expect(accepted?.contactCount).toBe(1);
    const recipients = await live.store.listRecipients(campaign.id, { page: 1, pageSize: 5 });
    expect(recipients.rows[0]?.status).toBe('accepted');
    const liveEligible = await live.store.selectSchedulerContacts(10, 'live');
    expect(liveEligible.map((contact) => contact.id)).toEqual([untouchedId]);
    expect(live.mailer.calls).toBe(1);
  });

  it('excludes a contact with an ambiguous actual send attempt', async () => {
    const live = await buildTestApp(liveEnv);
    const inserted = await live.store.insertContacts(contacts(2));
    const ambiguousId = inserted[0].id;
    const untouchedId = inserted[1].id;
    const interrupted = await interruptInFlightSend({
      store: live.store,
      config: live.config,
      contactId: ambiguousId,
      name: 'Ambiguous live attempt',
    });
    expect(interrupted.campaign?.dryRun).toBe(false);
    expect(interrupted.recipient?.status).toBe('failed');
    expect(interrupted.recipient?.failureClass).toBe('ambiguous');
    const liveEligible = await live.store.selectSchedulerContacts(10, 'live');
    expect(liveEligible.map((contact) => contact.id)).toEqual([untouchedId]);
    expect((await live.store.findContactById(ambiguousId))?.isContacted).toBe(false);
    expect(live.mailer.calls).toBe(0);
  });

  it('keeps a contact eligible for live sending after an ambiguous dry-run result', async () => {
    const dry = await buildTestApp();
    const inserted = await dry.store.insertContacts(contacts(1));
    const ambiguousId = inserted[0].id;
    const interrupted = await interruptInFlightSend({
      store: dry.store,
      config: dry.config,
      contactId: ambiguousId,
      name: 'Ambiguous dry-run attempt',
    });
    expect(interrupted.campaign?.dryRun).toBe(true);
    expect(interrupted.recipient?.status).toBe('failed');
    expect(interrupted.recipient?.failureClass).toBe('ambiguous');
    const liveEligible = await dry.store.selectSchedulerContacts(10, 'live');
    expect(liveEligible.map((contact) => contact.id)).toEqual([ambiguousId]);
    const dryEligible = await dry.store.selectSchedulerContacts(10, 'dry_run');
    expect(dryEligible.map((contact) => contact.id)).toEqual([]);
    expect((await dry.store.findContactById(ambiguousId))?.isContacted).toBe(false);
    expect(dry.mailer.calls).toBe(0);
  });

  it('selects the next dry-run contacts after an earlier batch was simulated', async () => {
    const built = await buildTestApp();
    const inserted = await built.store.insertContacts(contacts(20));
    const firstIds = inserted.slice(0, 10).map((contact) => contact.id);
    const secondIds = inserted.slice(10).map((contact) => contact.id);
    const actor = await adminActor(built.store);
    const first = await createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Campaign 1',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      recipientLimit: 10,
      selectEligible: true,
    });
    await generatePreviews({ store: built.store, config: built.config, id: first.id });
    await approveCampaign({ store: built.store, config: built.config, actor, id: first.id, confirmRecipientCount: 10 });
    await startCampaign({ store: built.store, config: built.config, actor, id: first.id, confirmRecipientCount: 10 });
    for (let step = 0; step < 12; step += 1) await runSendTick({ store: built.store, config: built.config, mailer: built.mailer });
    const simulated = await built.store.listRecipients(first.id, { page: 1, pageSize: 20 });
    expect(simulated.rows.map((row) => row.contactId)).toEqual(firstIds);
    expect(simulated.rows.every((row) => row.status === 'simulated')).toBe(true);
    for (const contactId of firstIds) {
      const contact = await built.store.findContactById(contactId);
      expect(contact?.isContacted).toBe(false);
      expect(contact?.contactCount).toBe(0);
    }
    const listed = await login(built.app);
    const hidden = await listed.agent.get('/api/contacts').query({ outreach: 'never', forCampaign: 'true', pageSize: 100 });
    expect(hidden.status).toBe(200);
    expect(hidden.body.rows.map((row: { id: number }) => row.id)).toEqual([...secondIds].reverse());

    const manual = await createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Campaign 2',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      recipientLimit: 10,
      selectEligible: true,
    });
    const manualRecipients = await built.store.listRecipients(manual.id, { page: 1, pageSize: 20 });
    expect(manualRecipients.rows.map((row) => row.contactId)).toEqual(secondIds);
    await expect(createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Repeat a simulated contact',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      recipientLimit: 1,
      contactIds: [firstIds[0]],
    })).rejects.toMatchObject({ code: 'ALREADY_SIMULATED' });
    expect(built.mailer.calls).toBe(0);
  });

  it('makes the scheduler skip contacts already simulated by a manual campaign', async () => {
    const built = await buildTestApp();
    const inserted = await built.store.insertContacts(contacts(20));
    const actor = await adminActor(built.store);
    const first = await createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Manual first batch',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      recipientLimit: 10,
      selectEligible: true,
    });
    await generatePreviews({ store: built.store, config: built.config, id: first.id });
    await approveCampaign({ store: built.store, config: built.config, actor, id: first.id, confirmRecipientCount: 10 });
    await startCampaign({ store: built.store, config: built.config, actor, id: first.id, confirmRecipientCount: 10 });
    for (let step = 0; step < 12; step += 1) await runSendTick({ store: built.store, config: built.config, mailer: built.mailer });
    await readyScheduler(built.store, 10);
    const scheduled = await executeSchedulerRun({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      actor,
      trigger: 'manual',
      now: MONDAY_TEN_IST,
    });
    const recipients = await built.store.listRecipients(scheduled.run!.campaignId!, { page: 1, pageSize: 20 });
    expect(recipients.rows.map((row) => row.contactId)).toEqual(inserted.slice(10).map((contact) => contact.id));
    expect(built.mailer.calls).toBe(0);
  });

  it('keeps a simulated contact eligible when the process is in live mode', async () => {
    const dry = await buildTestApp();
    const liveConfig = (await buildTestApp(liveEnv)).config;
    const inserted = await dry.store.insertContacts(contacts(1));
    const actor = await adminActor(dry.store);
    const first = await createCampaign({
      store: dry.store,
      config: dry.config,
      actor,
      name: 'Simulated once',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: dry.config.sesFromName,
      recipientLimit: 1,
      selectEligible: true,
    });
    await generatePreviews({ store: dry.store, config: dry.config, id: first.id });
    await approveCampaign({ store: dry.store, config: dry.config, actor, id: first.id, confirmRecipientCount: 1 });
    await startCampaign({ store: dry.store, config: dry.config, actor, id: first.id, confirmRecipientCount: 1 });
    await runSendTick({ store: dry.store, config: dry.config, mailer: dry.mailer });
    const live = await createCampaign({
      store: dry.store,
      config: liveConfig,
      actor,
      name: 'Live after simulation',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: liveConfig.sesFromName,
      recipientLimit: 1,
      selectEligible: true,
    });
    const recipients = await dry.store.listRecipients(live.id, { page: 1, pageSize: 5 });
    expect(recipients.rows.map((row) => row.contactId)).toEqual([inserted[0].id]);
    expect(dry.mailer.calls).toBe(0);
  });

  it('excludes an SMTP-accepted contact from the next campaign selection', async () => {
    const live = await buildTestApp(liveEnv);
    const inserted = await live.store.insertContacts(contacts(2));
    const actor = await adminActor(live.store);
    const accepted = await createCampaign({
      store: live.store,
      config: live.config,
      actor,
      name: 'Accepted once',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: live.config.sesFromName,
      recipientLimit: 1,
      contactIds: [inserted[0].id],
    });
    await generatePreviews({ store: live.store, config: live.config, id: accepted.id });
    await approveCampaign({ store: live.store, config: live.config, actor, id: accepted.id, confirmRecipientCount: 1 });
    await startCampaign({ store: live.store, config: live.config, actor, id: accepted.id, confirmRecipientCount: 1 });
    await runSendTick({ store: live.store, config: live.config, mailer: live.mailer });
    const next = await createCampaign({
      store: live.store,
      config: live.config,
      actor,
      name: 'Next live batch',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: live.config.sesFromName,
      recipientLimit: 5,
      selectEligible: true,
    });
    const recipients = await live.store.listRecipients(next.id, { page: 1, pageSize: 5 });
    expect(recipients.rows.map((row) => row.contactId)).toEqual([inserted[1].id]);
    expect((await live.store.findContactById(inserted[0].id))?.contactCount).toBe(1);
  });

  it('rejects approval of a historical campaign that repeats simulated contacts without deleting its recipients', async () => {
    const built = await buildTestApp();
    const inserted = await built.store.insertContacts(contacts(1));
    const actor = await adminActor(built.store);
    const first = await createCampaign({
      store: built.store,
      config: built.config,
      actor,
      name: 'Already simulated',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      recipientLimit: 1,
      selectEligible: true,
    });
    await generatePreviews({ store: built.store, config: built.config, id: first.id });
    await approveCampaign({ store: built.store, config: built.config, actor, id: first.id, confirmRecipientCount: 1 });
    await startCampaign({ store: built.store, config: built.config, actor, id: first.id, confirmRecipientCount: 1 });
    await runSendTick({ store: built.store, config: built.config, mailer: built.mailer });
    const shadow = await built.store.createCampaign({
      name: 'Historical duplicate',
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      senderEmail: built.config.sesFromEmail,
      recipientLimit: 1,
      sendRatePerSecond: 1,
      batchSize: 1,
      maxAttempts: 3,
      circuitBreakerThreshold: 5,
      createdBy: actor.userId,
    });
    await built.store.replaceRecipients(shadow.id, [{
      contactId: inserted[0].id,
      personalizedSubject: SAMPLE_SUBJECT,
      personalizedBody: SAMPLE_BODY,
    }]);
    await built.store.updateCampaign(shadow.id, { status: 'previewed', totalRecipients: 1 });
    await expect(approveCampaign({
      store: built.store,
      config: built.config,
      actor,
      id: shadow.id,
      confirmRecipientCount: 1,
    })).rejects.toMatchObject({ code: 'ALREADY_SIMULATED' });
    await expect(generatePreviews({ store: built.store, config: built.config, id: shadow.id })).rejects.toMatchObject({ code: 'ALREADY_SIMULATED' });
    await built.store.updateCampaign(shadow.id, { status: 'approved', approvedAt: new Date(), approvedBy: actor.userId });
    await expect(startCampaign({
      store: built.store,
      config: built.config,
      actor,
      id: shadow.id,
      confirmRecipientCount: 1,
    })).rejects.toMatchObject({ code: 'ALREADY_SIMULATED' });
    const preserved = await built.store.listRecipients(shadow.id, { page: 1, pageSize: 5 });
    expect(preserved.rows.map((row) => ({ contactId: row.contactId, status: row.status }))).toEqual([
      { contactId: inserted[0].id, status: 'pending' },
    ]);
    expect((await built.store.findCampaign(shadow.id))?.status).toBe('approved');
  });

  it('gives concurrent dry-run campaigns disjoint contacts', async () => {
    const built = await buildTestApp();
    const inserted = await built.store.insertContacts(contacts(20));
    const actor = await adminActor(built.store);
    const draft = {
      store: built.store,
      config: built.config,
      actor,
      templateId: null,
      subject: SAMPLE_SUBJECT,
      body: SAMPLE_BODY,
      senderName: built.config.sesFromName,
      recipientLimit: 10,
      selectEligible: true,
    };
    const [first, second] = await Promise.all([
      createCampaign({ ...draft, name: 'Concurrent A' }),
      createCampaign({ ...draft, name: 'Concurrent B' }),
    ]);
    const recipients = [
      ...(await built.store.listRecipients(first.id, { page: 1, pageSize: 20 })).rows,
      ...(await built.store.listRecipients(second.id, { page: 1, pageSize: 20 })).rows,
    ];
    const ids = recipients.map((row) => row.contactId);
    expect(new Set(ids).size).toBe(20);
    expect(ids.sort((left, right) => left - right)).toEqual(inserted.map((contact) => contact.id));
    expect(built.mailer.calls).toBe(0);
  });

  it('exposes the scheduler only to an administrator', async () => {
    const built = await buildTestApp();
    const { agent, csrf } = await login(built.app);
    const denied = await agent.get('/api/scheduler');
    expect(denied.status).toBe(200);
    expect(denied.body.settings.dailyLimit).toBe(20);
    expect(denied.body.settings.status).toBe('disabled');
    await built.store.createUser({
      email: 'operator@example.com',
      passwordHash: await hashPassword('operator-password-1', 4),
      displayName: 'Operator',
      role: 'operator',
    });
    const operator = await login(built.app, 'operator@example.com', 'operator-password-1');
    expect((await operator.agent.get('/api/scheduler')).status).toBe(403);
    const saved = await agent.put('/api/scheduler').set('x-csrf-token', csrf).send({
      dailyLimit: 20,
      executionTime: '10:00',
      workingDays: [1, 2, 3, 4, 5],
      timezone: 'Asia/Kolkata',
      templateId: null,
      aiPersonalization: false,
      startDate: null,
    });
    expect(saved.status).toBe(200);
  });
});

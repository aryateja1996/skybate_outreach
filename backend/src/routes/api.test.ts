import { readFileSync } from 'fs';
import { resolve } from 'path';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { DEFAULT_BODY, DEFAULT_SUBJECT } from '../domain/defaultTemplate';
import { AppError } from '../errors';
import { createApp } from '../app';
import { hashPassword } from '../services/bootstrap';
import { generateUnsubscribeToken, hashUnsubscribeToken } from '../domain/tokens';
import { recoverOnStartup, runSendTick } from '../services/sending';
import { verifySnsEnvelope } from '../services/sns';
import { MemoryStore } from '../store/memory';
import { buildTestApp, FakeMailer, liveEnv, login } from '../test/helpers';

async function workbook(rows: string[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Contacts');
  sheet.addRow(['Email', 'Contact name', 'Company', 'Designation', 'Website', 'Source']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function addContact(store: MemoryStore, email: string, contactName: string | null, companyName: string | null) {
  const [contact] = await store.insertContacts([{
    email,
    emailNormalized: email.toLowerCase(),
    contactName,
    companyName,
    designation: 'Talent Partner',
    website: null,
    source: 'test',
    eligibilityStatus: 'eligible',
    missingInfo: !contactName || !companyName,
  }]);
  return contact;
}

describe('API authorization and validation', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('shows the configured sender on the unsubscribe page', async () => {
    const built = await buildTestApp({ SES_FROM_EMAIL: 'sales@skybate.in' });
    const response = await request(built.app).get('/unsubscribe/not-a-valid-token');
    expect(response.status).toBe(200);
    expect(response.text).toContain('sales@skybate.in');
    expect(response.text).not.toContain('sreekar.k@skybate.in');
    expect(response.text).toContain('This unsubscribe link is invalid.');
  });

  it('requires the unsubscribe token in the path and suppresses only that address', async () => {
    const { app, store } = await buildTestApp({ PUBLIC_API_URL: 'https://outreach.example' });
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind');
    const token = generateUnsubscribeToken();
    await store.createUnsubscribeToken({ contactId: contact.id, tokenHash: hashUnsubscribeToken(token) });

    const missing = await request(app).get('/unsubscribe');
    expect(missing.status).toBe(404);
    const asQuery = await request(app).get('/unsubscribe').query({ token });
    expect(asQuery.status).toBe(404);

    const page = await request(app).get(`/unsubscribe/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Confirm that');
    expect(page.text).toContain(`/unsubscribe/${token}`);
    expect(await store.findActiveSuppression(contact.emailNormalized)).toBeNull();

    const submitted = await request(app).post(`/unsubscribe/${token}`);
    expect(submitted.status).toBe(200);
    expect(submitted.text).toContain('will not receive future outreach');
    expect((await store.findActiveSuppression(contact.emailNormalized))?.reason).toBe('unsubscribe');
    expect((await store.findContactById(contact.id))?.eligibilityStatus).toBe('suppressed');

    const again = await request(app).post(`/unsubscribe/${token}`).set('Accept', 'application/json');
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    const rows = await store.listSuppressions({ page: 1, pageSize: 20 });
    expect(rows.rows.filter((row) => row.emailNormalized === contact.emailNormalized)).toHaveLength(1);
    expect((await store.findContactById(contact.id))?.eligibilityStatus).toBe('suppressed');

    const unknown = 'this-token-is-long-enough-but-unknown';
    const invalid = await request(app).get(`/unsubscribe/${unknown}`);
    expect(invalid.status).toBe(200);
    expect(invalid.text).toContain('This unsubscribe link is invalid.');
    const invalidPost = await request(app).post(`/unsubscribe/${unknown}`);
    expect(invalidPost.status).toBe(404);
    expect(invalidPost.text).toContain('This unsubscribe link is invalid.');
    expect(await store.findActiveSuppression('nobody@example.com')).toBeNull();
  });

  it('reports health without credentials', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, mode: 'dry_run' });
    const hidden = await request(app).get('/.env');
    expect(hidden.status).toBe(404);
  });

  it('keeps API routes protected behind forwarded HTTPS headers', async () => {
    const tunneled = await buildTestApp({ NODE_ENV: 'development' });
    const campaigns = await request(tunneled.app)
      .get('/api/campaigns')
      .set('X-Forwarded-For', '203.0.113.10')
      .set('X-Forwarded-Proto', 'https');
    expect(campaigns.status).toBe(401);
    expect(JSON.stringify(campaigns.body)).not.toMatch(/smtp|password|sk-proj|BEGIN /i);
  });

  it('does not treat a tunnel proxy as an SNS signature', async () => {
    const tunneled = await buildTestApp({ NODE_ENV: 'development' });
    const realVerifier = createApp({
      store: tunneled.store,
      config: tunneled.config,
      mailer: tunneled.mailer,
      aiClient: null,
      snsVerifier: verifySnsEnvelope,
    });
    const response = await request(realVerifier)
      .post('/api/webhooks/ses')
      .set('Content-Type', 'text/plain')
      .set('X-Forwarded-For', '203.0.113.10')
      .set('X-Forwarded-Proto', 'https')
      .send(JSON.stringify({
        Type: 'Notification',
        TopicArn: tunneled.config.sesSnsTopicArn,
        Message: '{}',
      }));
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('SNS_UNVERIFIED');
    await expect(verifySnsEnvelope({
      Type: 'Notification',
      Signature: 'not-a-signature',
      SigningCertURL: 'https://example.com/cert.pem',
      TopicArn: tunneled.config.sesSnsTopicArn,
      Message: '{}',
    })).rejects.toMatchObject({ code: 'SNS_UNVERIFIED' });
  });

  it('requires authentication and a valid CSRF token', async () => {
    const anonymous = await request(app).get('/api/campaigns');
    expect(anonymous.status).toBe(401);
    const { agent, csrf, status } = await login(app);
    expect(status).toBe(200);
    const missing = await agent.post('/api/campaigns').send({ name: 'Test campaign' });
    expect(missing.status).toBe(403);
    const invalid = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({});
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a bad password and forbids operators from approving', async () => {
    const bad = await request(app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    const built = await buildTestApp();
    await built.store.createUser({
      email: 'operator@example.com',
      passwordHash: await hashPassword('operator-password-1', 4),
      displayName: 'Operator',
      role: 'operator',
    });
    const operatorApp = createApp({
      store: built.store,
      config: built.config,
      mailer: built.mailer,
      aiClient: null,
      snsVerifier: async () => {
        throw new AppError(401, 'SNS notification could not be verified.', 'SNS_UNVERIFIED');
      },
    });
    const operator = await login(operatorApp, 'operator@example.com', 'operator-password-1');
    expect(operator.status).toBe(200);
    const response = await operator.agent
      .post('/api/campaigns/1/approve')
      .set('X-CSRF-Token', operator.csrf)
      .send({ confirmRecipientCount: 1 });
    expect(response.status).toBe(403);
  });
});

describe('import, suppression, and dry-run sending', () => {
  let app: Express;
  let store: MemoryStore;
  let mailer: FakeMailer;
  let config: AppConfig;

  beforeEach(async () => {
    ({ app, store, mailer, config } = await buildTestApp());
  });

  it('previews duplicates, invalid emails, and missing names without sending', async () => {
    const { agent, csrf } = await login(app);
    const file = await workbook([
      ['mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics', 'Talent Partner', 'https://northwind.example', 'Sample'],
      ['mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics', 'Talent Partner', 'https://northwind.example', 'Sample'],
      ['not-an-email', '', 'Contoso Cloud', 'Manager', '', 'Sample'],
      ['', 'No Email', 'Fabrikam', 'Recruiter', '', 'Sample'],
      ['avery.chen@adventureworks.example', '', 'Adventure Works', 'Hiring Manager', '', 'Sample'],
    ]);
    const preview = await agent
      .post('/api/contacts/import/preview')
      .set('X-CSRF-Token', csrf)
      .attach('file', file, 'contacts.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.summary.duplicateInFile).toBe(1);
    expect(preview.body.summary.invalidEmail).toBe(1);
    expect(preview.body.summary.missingEmail).toBe(1);
    expect(preview.body.summary.missingName).toBeGreaterThan(0);
    expect(mailer.calls).toBe(0);

    const committed = await agent.post('/api/contacts/import/commit').set('X-CSRF-Token', csrf).send({ previewId: preview.body.previewId });
    expect(committed.status).toBe(200);
    const contacts = await agent.get('/api/contacts?pageSize=50');
    const emails = contacts.body.rows.map((row: { email: string }) => row.email);
    expect(emails.filter((email: string) => email === 'mira.patel@northwind.example')).toHaveLength(1);
    expect(contacts.body.rows.some((row: { eligibilityStatus: string }) => row.eligibilityStatus === 'invalid_email')).toBe(true);
    expect(emails).not.toContain('');
  });

  it('prefixes formula-like export cells', async () => {
    const { agent, csrf } = await login(app);
    const contact = await addContact(store, 'jordan.lee@wideworld.example', 'Jordan Lee', 'Wide World Importers');
    await agent.patch(`/api/contacts/${contact.id}`).set('X-CSRF-Token', csrf).send({ contactName: '=1+1' });
    const response = await agent.get('/api/contacts/export').buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body as unknown as ArrayBuffer);
    const values = book.worksheets[0].getSheetValues().flat().map((value) => String(value ?? ''));
    expect(values.some((value) => value.startsWith("'=1+1") || value.startsWith("'=1+1"))).toBe(true);
  });

  it('personalizes missing names, blocks suppressed contacts, and simulates a dry run', async () => {
    const named = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics');
    const unnamed = await addContact(store, 'avery.chen@adventureworks.example', null, null);
    const { agent, csrf } = await login(app);
    const created = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'Vendor empanelment',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 10,
      contactIds: [named.id, unnamed.id],
    });
    expect(created.status).toBe(201);
    const early = await agent.post(`/api/campaigns/${created.body.id}/start`).set('X-CSRF-Token', csrf).send({ confirmRecipientCount: 2 });
    expect(early.status).toBe(409);
    const preview = await agent.post(`/api/campaigns/${created.body.id}/generate-previews`).set('X-CSRF-Token', csrf).send({});
    expect(preview.status).toBe(200);
    const unnamedPreview = preview.body.samples.find((row: { email: string }) => row.email === unnamed.email);
    expect(unnamedPreview.personalizedBody.startsWith('Hello,')).toBe(true);
    expect(unnamedPreview.personalizedBody).toContain('your organization');
    const unapproved = await agent.post(`/api/campaigns/${created.body.id}/start`).set('X-CSRF-Token', csrf).send({ confirmRecipientCount: 2 });
    expect(unapproved.status).toBe(409);
    const approved = await agent.post(`/api/campaigns/${created.body.id}/approve`).set('X-CSRF-Token', csrf).send({ confirmRecipientCount: 2 });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    const started = await agent.post(`/api/campaigns/${created.body.id}/start`).set('X-CSRF-Token', csrf).send({ confirmRecipientCount: 2 });
    expect(started.status).toBe(200);
    expect(started.body.mode).toBe('dry_run');
    await runSendTick({ store, config, mailer });
    await runSendTick({ store, config, mailer });
    const recipients = await agent.get(`/api/campaigns/${created.body.id}/recipients?pageSize=10`);
    expect(recipients.body.rows.every((row: { status: string }) => row.status === 'simulated')).toBe(true);
    expect(mailer.calls).toBe(0);
    expect(recipients.body.rows[0].personalizedBody).toContain('/unsubscribe/');
  });

  it('does not send after pause or cancellation', async () => {
    const contact = await addContact(store, 'r.iyer@litware.example', 'R. Iyer', 'Litware');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    await agent.post(`/api/campaigns/${campaign.id}/pause`).set('X-CSRF-Token', csrf).send({});
    await runSendTick({ store, config, mailer });
    let recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('pending');

    const other = await addContact(store, 'jordan.lee@wideworld.example', 'Jordan Lee', 'Wide World Importers');
    const second = await createReadyCampaign(agent, csrf, [other.id]);
    const cancelled = await agent.post(`/api/campaigns/${second.id}/cancel`).set('X-CSRF-Token', csrf).send({});
    expect(cancelled.status).toBe(200);
    await runSendTick({ store, config, mailer });
    recipients = await agent.get(`/api/campaigns/${second.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('cancelled');
    expect(mailer.calls).toBe(0);
  });

  it('skips a recipient suppressed after approval', async () => {
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    const suppressed = await agent.post('/api/suppression').set('X-CSRF-Token', csrf).send({
      email: contact.email,
      reason: 'manual',
      notes: 'Do not contact',
    });
    expect(suppressed.status).toBe(201);
    await runSendTick({ store, config, mailer });
    const recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('suppressed');
    expect(mailer.calls).toBe(0);
  });

  it('pauses an in-progress campaign on startup instead of retrying it', async () => {
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics');
    const campaign = await store.createCampaign({
      name: 'Interrupted',
      templateId: null,
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      senderName: 'Sreekar Kondaveeti',
      senderEmail: 'sreekar.k@skybate.in',
      recipientLimit: 10,
      sendRatePerSecond: 1,
      batchSize: 5,
      maxAttempts: 3,
      circuitBreakerThreshold: 5,
      createdBy: null,
    });
    await store.replaceRecipients(campaign.id, [{
      contactId: contact.id,
      personalizedSubject: DEFAULT_SUBJECT,
      personalizedBody: DEFAULT_BODY,
    }]);
    await store.updateCampaign(campaign.id, { status: 'sending', approvedAt: new Date(), totalRecipients: 1 });
    await store.claimRecipientBatch(campaign.id, 1, 'worker');
    const paused = await recoverOnStartup(store);
    expect(paused).toContain(campaign.id);
    const after = await store.findCampaign(campaign.id);
    expect(after?.status).toBe('paused');
    const recipients = await store.listRecipients(campaign.id, { page: 1, pageSize: 10 });
    expect(recipients.rows[0]?.status).toBe('failed');
    expect(recipients.rows[0]?.failureClass).toBe('ambiguous');
    expect(mailer.calls).toBe(0);
  });

  it('falls back when AI output invents achievements', async () => {
    const { agent, csrf } = await login(app);
    const response = await agent.post('/api/templates/generate').set('X-CSRF-Token', csrf).send({
      purpose: 'Request vendor empanelment for technology hiring.',
      style: 'professional',
    });
    expect(response.status).toBe(200);
    expect(response.body.source).toBe('fallback');
    expect(response.body.body).not.toMatch(/Fortune|placed 500/i);
    expect(mailer.calls).toBe(0);
  });
});

describe('live queue and SES events', () => {
  let app: Express;
  let store: MemoryStore;
  let mailer: FakeMailer;
  let config: AppConfig;

  beforeEach(async () => {
    ({ app, store, mailer, config } = await buildTestApp({ ...liveEnv, MAX_SEND_ATTEMPTS: '2', CIRCUIT_BREAKER_THRESHOLD: '5' }));
  });

  it('retries transient failures up to the limit and does not retry ambiguous outcomes', async () => {
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    mailer.failTimes = 1;
    mailer.failWith = Object.assign(new Error('mailbox busy'), { responseCode: 450 });
    await runSendTick({ store, config, mailer });
    await runSendTick({ store, config, mailer });
    let recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('accepted');
    expect(recipients.body.rows[0].attemptCount).toBe(2);
    expect(mailer.sent).toHaveLength(1);

    const other = await addContact(store, 'avery.chen@adventureworks.example', 'Avery Chen', 'Adventure Works');
    const second = await createReadyCampaign(agent, csrf, [other.id]);
    mailer.failTimes = 1;
    mailer.failWith = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const callsBefore = mailer.calls;
    await runSendTick({ store, config, mailer });
    await runSendTick({ store, config, mailer });
    recipients = await agent.get(`/api/campaigns/${second.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('failed');
    expect(recipients.body.rows[0].failureClass).toBe('ambiguous');
    expect(mailer.calls - callsBefore).toBe(1);
  });

  it('stops retrying after the attempt limit', async () => {
    const contact = await addContact(store, 'r.iyer@litware.example', 'R. Iyer', 'Litware');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    mailer.failTimes = 5;
    mailer.failWith = Object.assign(new Error('try later'), { responseCode: 451 });
    await runSendTick({ store, config, mailer });
    await runSendTick({ store, config, mailer });
    await runSendTick({ store, config, mailer });
    const recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('failed');
    expect(mailer.calls).toBe(2);
    expect(mailer.sent).toHaveLength(0);
  });

  it('applies a verified SES event once and suppresses complaints', async () => {
    const contact = await addContact(store, 'jordan.lee@wideworld.example', 'Jordan Lee', 'Wide World Importers');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    await runSendTick({ store, config, mailer });
    const event = {
      token: 'valid',
      topicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
      event: {
        eventType: 'Complaint',
        mail: {
          messageId: 'fake-1@example.com',
          timestamp: '2026-01-01T00:00:00.000Z',
          destination: [contact.email],
        },
        complaint: {
          timestamp: '2026-01-01T00:00:02.000Z',
          complainedRecipients: [{ emailAddress: contact.email }],
          complaintFeedbackType: 'abuse',
        },
      },
    };
    const first = await request(app).post('/api/webhooks/ses').send(event);
    const second = await request(app).post('/api/webhooks/ses').send(event);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    const rejected = await request(app).post('/api/webhooks/ses').send({ token: 'nope' });
    expect(rejected.status).toBe(401);
    const recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('complained');
    const suppression = await agent.get('/api/suppression');
    expect(suppression.body.rows.filter((row: { emailNormalized: string }) => row.emailNormalized === contact.email)).toHaveLength(1);
    const report = await agent.get(`/api/campaigns/${campaign.id}/events`);
    expect(report.body.counts.delivered).toBe(0);
    expect(report.body.counts.complained).toBe(1);
    expect(report.body.events.total).toBe(1);
  });

  it('records a delivery delay once and does not change accepted status', async () => {
    const contact = await addContact(store, 'r.iyer@litware.example', 'R. Iyer', 'Litware');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    await runSendTick({ store, config, mailer });
    const event = {
      token: 'valid',
      topicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
      event: {
        eventType: 'DeliveryDelay',
        mail: {
          messageId: 'fake-1@example.com',
          timestamp: '2026-01-01T00:00:00.000Z',
          destination: [contact.email],
        },
        deliveryDelay: {
          delayType: 'MailboxFull',
          timestamp: '2026-01-01T00:00:04.000Z',
          delayedRecipients: [{ emailAddress: contact.email, diagnosticCode: 'mailbox full' }],
        },
      },
    };
    const first = await request(app).post('/api/webhooks/ses').send(event);
    const second = await request(app).post('/api/webhooks/ses').send(event);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    const recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('accepted');
    const report = await agent.get(`/api/campaigns/${campaign.id}/events`);
    expect(report.body.counts.delivered).toBe(0);
    expect(report.body.events.total).toBe(1);
    expect(report.body.events.rows[0].eventType).toBe('delivery_delay');
    const suppression = await agent.get('/api/suppression');
    expect(suppression.body.rows).toHaveLength(0);
  });

  it('acknowledges an SNS subscription confirmation without storing an event', async () => {
    const response = await request(app).post('/api/webhooks/ses').send({
      token: 'valid',
      kind: 'confirmation',
      topicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
    });
    expect(response.status).toBe(200);
    expect(response.body.confirmation).toBe(true);
    const wrongTopic = await request(app).post('/api/webhooks/ses').send({
      token: 'valid',
      kind: 'confirmation',
      topicArn: 'arn:aws:sns:ap-south-1:123456789012:other-topic',
    });
    expect(wrongTopic.status).toBe(401);
  });
});

async function createReadyCampaign(
  agent: { post: (url: string) => request.Test },
  csrf: string,
  contactIds: number[],
): Promise<{ id: number }> {
  const created = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
    name: 'Vendor empanelment',
    senderName: 'Sreekar Kondaveeti',
    subject: DEFAULT_SUBJECT,
    body: DEFAULT_BODY,
    recipientLimit: 10,
    contactIds,
  });
  expect(created.status).toBe(201);
  const preview = await agent.post(`/api/campaigns/${created.body.id}/generate-previews`).set('X-CSRF-Token', csrf).send({});
  expect(preview.status).toBe(200);
  const approved = await agent.post(`/api/campaigns/${created.body.id}/approve`).set('X-CSRF-Token', csrf).send({
    confirmRecipientCount: preview.body.totalRecipients,
  });
  expect(approved.status).toBe(200);
  const started = await agent.post(`/api/campaigns/${created.body.id}/start`).set('X-CSRF-Token', csrf).send({
    confirmRecipientCount: preview.body.totalRecipients,
  });
  expect(started.status).toBe(200);
  return { id: created.body.id as number };
}

describe('global outreach tracking', () => {
  it('keeps the migration from deleting contacts, history, or suppression', () => {
    const sql = readFileSync(resolve(__dirname, '../../../database/migrations/20261102_contact_outreach.sql'), 'utf8');
    expect(sql).toMatch(/is_contacted/);
    expect(sql).toMatch(/WHERE c\.contact_count = 0/);
    expect(sql).toMatch(/'accepted', 'delivered', 'bounced', 'complained'/);
    expect(sql).not.toMatch(/DELETE FROM contacts/i);
    expect(sql).not.toMatch(/DELETE FROM campaign_recipients/i);
    expect(sql).not.toMatch(/suppression_list/i);
  });

  it('excludes a previously contacted address and rejects a duplicate in one campaign', async () => {
    const { app, store } = await buildTestApp();
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind');
    await store.recordAcceptedOutreach({ contactId: contact.id, campaignId: 1, sentAt: new Date('2026-10-01T00:00:00.000Z') });
    const { agent, csrf } = await login(app);
    const blocked = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'Second introduction',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 1,
      contactIds: [contact.id],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PREVIOUSLY_CONTACTED');
    const filled = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'Eligible fill',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 5,
      selectEligible: true,
    });
    expect(filled.status).toBe(400);

    const fresh = await addContact(store, 'avery.chen@adventureworks.example', 'Avery Chen', 'Adventure');
    const once = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'One recipient',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 5,
      contactIds: [fresh.id, fresh.id],
    });
    expect(once.status).toBe(201);
    expect(once.body.totalRecipients).toBe(1);
    const queued = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'Same contact again',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 5,
      contactIds: [fresh.id],
    });
    expect(queued.status).toBe(409);
    expect(queued.body.error.code).toBe('CONTACT_ALREADY_QUEUED');
  });

  it('requires an administrator for follow-up and still blocks suppression', async () => {
    const { app, store } = await buildTestApp();
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind');
    await store.recordAcceptedOutreach({ contactId: contact.id, campaignId: 1, sentAt: new Date() });
    const suppressed = await addContact(store, 'jordan.lee@wideworld.example', 'Jordan Lee', 'Wide World');
    await store.updateContact(suppressed.id, { eligibilityStatus: 'suppressed' });
    await store.createUser({
      email: 'operator@example.com',
      passwordHash: await hashPassword('correct-horse-battery', 4),
      displayName: 'Operator',
      role: 'operator',
    });
    const operator = await login(app, 'operator@example.com');
    const denied = await operator.agent.post('/api/campaigns').set('X-CSRF-Token', operator.csrf).send({
      name: 'Operator follow-up',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 1,
      contactIds: [contact.id],
      followUpContactIds: [contact.id],
    });
    expect(denied.status).toBe(403);

    const { agent, csrf } = await login(app);
    const followUp = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'Admin follow-up',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 1,
      contactIds: [contact.id],
      followUpContactIds: [contact.id],
    });
    expect(followUp.status).toBe(201);
    const blocked = await agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({
      name: 'Suppressed follow-up',
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 1,
      contactIds: [suppressed.id],
      followUpContactIds: [suppressed.id],
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('INELIGIBLE_CONTACTS');
  });

  it('does not mark a dry-run recipient as contacted', async () => {
    const { app, store, config, mailer } = await buildTestApp();
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind');
    const { agent, csrf } = await login(app);
    await createReadyCampaign(agent, csrf, [contact.id]);
    await runSendTick({ store, config, mailer });
    const saved = await store.findContactById(contact.id);
    expect(saved?.isContacted).toBe(false);
    expect(saved?.contactCount).toBe(0);
    expect(mailer.calls).toBe(0);
  });

  it('records SMTP acceptance once, ignores failure, and does not recount delivery', async () => {
    const { app, store, config, mailer } = await buildTestApp(liveEnv);
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind');
    const { agent, csrf } = await login(app);
    const campaign = await createReadyCampaign(agent, csrf, [contact.id]);
    await runSendTick({ store, config, mailer });
    await runSendTick({ store, config, mailer });
    const accepted = await store.findContactById(contact.id);
    expect(accepted?.isContacted).toBe(true);
    expect(accepted?.contactCount).toBe(1);
    expect(accepted?.lastCampaignId).toBe(campaign.id);
    expect(mailer.calls).toBe(1);

    const delivery = await request(app).post('/api/webhooks/ses').send({
      token: 'valid',
      topicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
      event: {
        eventType: 'Delivery',
        mail: { messageId: 'fake-1@example.com', timestamp: '2026-11-02T00:00:00.000Z', destination: [contact.email] },
        delivery: { timestamp: '2026-11-02T00:00:02.000Z', recipients: [contact.email] },
      },
    });
    expect(delivery.status).toBe(200);
    const afterDelivery = await store.findContactById(contact.id);
    expect(afterDelivery?.contactCount).toBe(1);
    const recipients = await agent.get(`/api/campaigns/${campaign.id}/recipients`);
    expect(recipients.body.rows[0].status).toBe('delivered');
    const history = await agent.get(`/api/contacts/${contact.id}/outreach`);
    expect(history.body.history[0].smtpAccepted).toBe(true);
    expect(history.body.history[0].delivered).toBe(true);

    const failedContact = await addContact(store, 'avery.chen@adventureworks.example', 'Avery Chen', 'Adventure');
    mailer.failTimes = 1;
    mailer.failWith = Object.assign(new Error('mailbox unavailable'), { responseCode: 550 });
    await createReadyCampaign(agent, csrf, [failedContact.id]);
    await runSendTick({ store, config, mailer });
    const failed = await store.findContactById(failedContact.id);
    expect(failed?.isContacted).toBe(false);
    expect(failed?.contactCount).toBe(0);
  });

  it('lets only one of two concurrent campaigns queue the same contact', async () => {
    const { app, store } = await buildTestApp();
    const contact = await addContact(store, 'mira.patel@northwind.example', 'Mira Patel', 'Northwind');
    const { agent, csrf } = await login(app);
    const body = {
      senderName: 'Sreekar Kondaveeti',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      recipientLimit: 1,
      contactIds: [contact.id],
    };
    const [first, second] = await Promise.all([
      agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({ ...body, name: 'Campaign A' }),
      agent.post('/api/campaigns').set('X-CSRF-Token', csrf).send({ ...body, name: 'Campaign B' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const queued = await store.contactsWithOpenOutreach([contact.id]);
    expect(queued).toEqual([contact.id]);
  });
});

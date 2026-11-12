import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { escapeHtml } from '../domain/html';
import { maskEmail } from '../domain/email';
import { TEMPLATE_STYLES } from '../domain/defaultTemplate';
import { hashUnsubscribeToken, randomId } from '../domain/tokens';
import { AppError } from '../errors';
import { cookieOptions, getContext, requireAdmin, requireCsrf, requireUser } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import type { Store } from '../store';
import type { EligibilityStatus, SuppressionReason, User } from '../types';
import { generateDraft, type AiClient } from '../services/ai';
import {
  approveCampaign,
  campaignReport,
  cancelCampaign,
  createCampaign,
  generatePreviews,
  pauseCampaign,
  startCampaign,
  updateCampaignContent,
} from '../services/campaigns';
import { commitContacts, exportContacts, previewContacts, updateContactRecord } from '../services/contacts';
import { applySesEvent } from '../services/events';
import type { MailTransport } from '../services/mailer';
import { verifyPassword } from '../services/bootstrap';
import { isSafeSnsSubscribeUrl, type VerifiedSns } from '../services/sns';
import {
  enableScheduler,
  executeSchedulerRun,
  getSchedulerDashboard,
  pauseScheduler,
  resumeScheduler,
  saveSchedulerConfig,
  stopScheduler,
} from '../services/scheduler';
import { addSuppression, liftSuppression, unsubscribeAddress } from '../services/suppression';
import { logInfo } from '../logger';

export interface AppDeps {
  store: Store;
  config: AppConfig;
  mailer: MailTransport;
  aiClient: AiClient | null;
  snsVerifier: (body: unknown) => Promise<VerifiedSns>;
}

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
});

const contactQuerySchema = paginationSchema.extend({
  eligibility: z.enum(['eligible', 'invalid_email', 'suppressed']).optional(),
  missingInfo: z.enum(['true', 'false']).optional(),
  outreach: z.enum(['never', 'contacted', 'suppressed', 'invalid']).optional(),
  forCampaign: z.enum(['true', 'false']).optional(),
});

const mappingSchema = z.object({
  email: z.string().trim().min(1).max(255).optional(),
  contactName: z.string().trim().min(1).max(255).optional(),
  companyName: z.string().trim().min(1).max(255).optional(),
  designation: z.string().trim().min(1).max(255).optional(),
  website: z.string().trim().min(1).max(255).optional(),
  source: z.string().trim().min(1).max(255).optional(),
});

const contactPatchSchema = z.object({
  email: z.string().trim().min(1).max(320).optional(),
  contactName: z.string().trim().max(255).nullable().optional(),
  companyName: z.string().trim().max(255).nullable().optional(),
  designation: z.string().trim().max(255).nullable().optional(),
  website: z.string().trim().max(500).nullable().optional(),
  source: z.string().trim().max(255).nullable().optional(),
});

const templateSchema = z.object({
  name: z.string().trim().min(3).max(255),
  style: z.enum(TEMPLATE_STYLES),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20).max(20000),
});

const templatePatchSchema = templateSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one field to update.',
});

const generateSchema = z.object({
  purpose: z.string().trim().min(10).max(2000),
  style: z.enum(TEMPLATE_STYLES),
});

const campaignSchema = z
  .object({
    name: z.string().trim().min(3).max(255),
    templateId: z.number().int().positive().nullable().optional(),
    subject: z.string().trim().min(3).max(200),
    body: z.string().trim().min(20).max(20000),
    senderName: z.string().trim().min(2).max(120),
    recipientLimit: z.number().int().positive(),
    contactIds: z.array(z.number().int().positive()).max(5000).optional(),
    selectEligible: z.boolean().optional(),
    followUpContactIds: z.array(z.number().int().positive()).max(5000).optional(),
  })
  .refine((value) => value.selectEligible || (value.contactIds?.length ?? 0) > 0, {
    message: 'Select contacts or choose eligible contacts up to the limit.',
  });

const campaignPatchSchema = z
  .object({
    name: z.string().trim().min(3).max(255).optional(),
    subject: z.string().trim().min(3).max(200).optional(),
    body: z.string().trim().min(20).max(20000).optional(),
    senderName: z.string().trim().min(2).max(120).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update.' });

const confirmSchema = z.object({
  confirmRecipientCount: z.number().int().positive(),
});

const suppressionSchema = z.object({
  email: z.string().trim().email().max(320),
  reason: z.enum(['unsubscribe', 'hard_bounce', 'complaint', 'manual']),
  notes: z.string().trim().max(500).optional(),
});

const liftSchema = z.object({
  confirmEmail: z.string().trim().email().max(320),
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'Request validation failed.', 'VALIDATION_ERROR', parsed.error.flatten());
  }
  return parsed.data;
}

function publicUser(user: User) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

function actorOf(req: Request, res: Response) {
  const context = getContext(res);
  return { userId: context.user.id, role: context.user.role, ipAddress: req.ip ? req.ip.slice(0, 64) : null };
}

function setSessionCookies(res: Response, config: AppConfig, sessionId: string, csrfToken: string): void {
  const options = cookieOptions(config);
  res.cookie('sid', sessionId, { ...options, httpOnly: true });
  res.cookie('csrf', csrfToken, { ...options, httpOnly: false });
}

function clearSessionCookies(res: Response): void {
  res.clearCookie('sid', { path: '/' });
  res.clearCookie('csrf', { path: '/' });
}

function unsubscribePage(input: { token: string; senderEmail: string; emailMasked?: string; done?: boolean; error?: string }): string {
  const message = input.done
    ? `${escapeHtml(input.emailMasked ?? 'This address')} will not receive future outreach campaigns.`
    : input.error
      ? escapeHtml(input.error)
      : `Confirm that ${escapeHtml(input.emailMasked ?? 'this address')} should stop receiving vendor-empanelment emails from Skybate Technologies Pvt. Ltd.`;
  const form = input.done
    ? ''
    : `<form method="post" action="/unsubscribe/${escapeHtml(input.token)}">
         <button type="submit">Unsubscribe</button>
       </form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe | Skybate Technologies</title>
  <style>
    body { margin: 0; font-family: Georgia, serif; background: #f3efe4; color: #1a1814; }
    main { max-width: 36rem; margin: 8vh auto; padding: 2rem; background: #fffdf8; border: 1px solid #e3d9c6; }
    button { background: #1c2822; color: #f3efe4; border: 0; padding: 0.75rem 1rem; font: inherit; cursor: pointer; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Skybate Technologies</h1>
    <p>${message}</p>
    ${form}
    <p>Sender: ${escapeHtml(input.senderEmail)} · <a href="https://skybate.in">skybate.in</a></p>
  </main>
</body>
</html>`;
}

export function registerRoutes(app: Express, deps: AppDeps): void {
  const { store, config } = deps;
  const authenticate = requireUser(store);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  app.get('/api/health', asyncHandler(async (_req, res) => {
    try {
      await store.ping();
      res.json({ ok: true, mode: config.mode });
    } catch {
      res.status(503).json({ ok: false, mode: config.mode });
    }
  }));

  app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await store.findUserByEmail(body.email.toLowerCase());
    const valid = user ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !valid) throw new AppError(401, 'Email or password is incorrect.', 'INVALID_LOGIN');
    const sessionId = randomId(32);
    const csrfToken = randomId(32);
    await store.createSession({
      id: sessionId,
      userId: user.id,
      csrfToken,
      expiresAt: new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000),
    });
    setSessionCookies(res, config, sessionId, csrfToken);
    res.json({ user: publicUser(user), csrfToken });
  }));

  app.post('/api/auth/logout', asyncHandler(async (req, res) => {
    const sid = req.cookies?.sid;
    if (typeof sid === 'string') await store.deleteSession(sid);
    clearSessionCookies(res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', authenticate, asyncHandler(async (_req, res) => {
    const context = getContext(res);
    res.json({ user: publicUser(context.user), csrfToken: context.csrfToken });
  }));

  app.get('/api/system/status', authenticate, asyncHandler(async (_req, res) => {
    res.json({
      sendingMode: config.mode,
      dryRunReasons: config.dryRunReasons,
      senderEmail: config.sesFromEmail,
      senderName: config.sesFromName,
      maxRecipientsPerCampaign: config.maxRecipientsPerCampaign,
      maxSendRate: config.maxSendRate,
      maxBatchSize: config.maxBatchSize,
      maxAttempts: config.maxSendAttempts,
      circuitBreakerThreshold: config.circuitBreakerThreshold,
    });
  }));

  app.post('/api/system/ses-check', authenticate, requireCsrf, requireAdmin, asyncHandler(async (_req, res) => {
    if (config.mode !== 'live') {
      res.json({
        connected: false,
        skipped: true,
        reason: 'Dry-run mode does not open an SMTP connection.',
        dryRunReasons: config.dryRunReasons,
      });
      return;
    }
    await deps.mailer.verify();
    res.json({ connected: true, skipped: false, senderEmail: config.sesFromEmail });
  }));

  app.get('/api/dashboard/stats', authenticate, asyncHandler(async (_req, res) => {
    const stats = await store.getDashboardStats();
    res.json({ ...stats, sendingMode: config.mode, dryRunReasons: config.dryRunReasons });
  }));

  app.post('/api/contacts/import/preview', authenticate, requireCsrf, upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, 'Choose an Excel file.', 'FILE_REQUIRED');
    let mapping = null;
    if (typeof req.body?.mapping === 'string' && req.body.mapping.trim()) {
      try {
        mapping = parse(mappingSchema, JSON.parse(req.body.mapping) as unknown);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(400, 'Column mapping must be valid JSON.', 'VALIDATION_ERROR');
      }
    }
    const result = await previewContacts({
      store,
      actor: actorOf(req, res),
      filename: req.file.originalname,
      buffer: req.file.buffer,
      mapping,
      maxRows: config.maxImportRows,
    });
    res.json(result);
  }));

  app.post('/api/contacts/import/commit', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ previewId: z.string().uuid() }), req.body);
    res.json(await commitContacts({ store, actor: actorOf(req, res), previewId: body.previewId }));
  }));

  app.get('/api/contacts/export', authenticate, asyncHandler(async (req, res) => {
    const query = parse(contactQuerySchema.omit({ page: true, pageSize: true }), req.query);
    const file = await exportContacts({
      store,
      search: query.search,
      eligibility: query.eligibility as EligibilityStatus | undefined,
      missingInfo: query.missingInfo === undefined ? undefined : query.missingInfo === 'true',
      outreach: query.outreach,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="skybate-contacts.xlsx"');
    res.send(file);
  }));

  app.get('/api/contacts', authenticate, asyncHandler(async (req, res) => {
    const query = parse(contactQuerySchema, req.query);
    res.json(await store.listContacts({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      eligibility: query.eligibility as EligibilityStatus | undefined,
      missingInfo: query.missingInfo === undefined ? undefined : query.missingInfo === 'true',
      outreach: query.outreach,
      blockMode: query.forCampaign === 'true' ? config.mode : undefined,
    }));
  }));

  app.get('/api/contacts/:id/outreach', authenticate, asyncHandler(async (req, res) => {
    const contact = await store.findContactById(Number(req.params.id));
    if (!contact) throw new AppError(404, 'Contact not found.', 'NOT_FOUND');
    res.json({ contact, history: await store.listOutreachHistory(contact.id) });
  }));

  app.get('/api/contacts/:id', authenticate, asyncHandler(async (req, res) => {
    const contact = await store.findContactById(Number(req.params.id));
    if (!contact) throw new AppError(404, 'Contact not found.', 'NOT_FOUND');
    res.json(contact);
  }));

  app.patch('/api/contacts/:id', authenticate, requireCsrf, asyncHandler(async (req, res) => {
    const body = parse(contactPatchSchema, req.body);
    res.json(await updateContactRecord({ store, id: Number(req.params.id), patch: body }));
  }));

  app.get('/api/templates', authenticate, asyncHandler(async (_req, res) => {
    res.json({ rows: await store.listTemplates() });
  }));

  app.post('/api/templates/generate', authenticate, requireCsrf, asyncHandler(async (req, res) => {
    const body = parse(generateSchema, req.body);
    const draft = await generateDraft({
      store,
      client: deps.aiClient,
      config,
      purpose: body.purpose,
      style: body.style,
      createdBy: getContext(res).user.id,
    });
    res.json(draft);
  }));

  app.post('/api/templates', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(templateSchema, req.body);
    const template = await store.createTemplate({
      ...body,
      aiGenerated: false,
      createdBy: getContext(res).user.id,
    });
    res.status(201).json(template);
  }));

  app.patch('/api/templates/:id', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(templatePatchSchema, req.body);
    res.json(await store.updateTemplate(Number(req.params.id), body));
  }));

  app.post('/api/campaigns', authenticate, requireCsrf, asyncHandler(async (req, res) => {
    const body = parse(campaignSchema, req.body);
    const campaign = await createCampaign({
      store,
      config,
      actor: actorOf(req, res),
      name: body.name,
      templateId: body.templateId ?? null,
      subject: body.subject,
      body: body.body,
      senderName: body.senderName,
      recipientLimit: body.recipientLimit,
      contactIds: body.contactIds,
      selectEligible: body.selectEligible,
      followUpContactIds: body.followUpContactIds,
    });
    res.status(201).json(campaign);
  }));

  app.get('/api/campaigns', authenticate, asyncHandler(async (req, res) => {
    const query = parse(paginationSchema.extend({ status: z.string().optional() }), req.query);
    res.json(await store.listCampaigns(query));
  }));

  app.get('/api/campaigns/:id', authenticate, asyncHandler(async (req, res) => {
    const campaign = await store.findCampaign(Number(req.params.id));
    if (!campaign) throw new AppError(404, 'Campaign not found.', 'NOT_FOUND');
    const issues = await store.recipientIssueCounts(campaign.id);
    res.json({ ...campaign, issues });
  }));

  app.patch('/api/campaigns/:id', authenticate, requireCsrf, asyncHandler(async (req, res) => {
    const body = parse(campaignPatchSchema, req.body);
    res.json(await updateCampaignContent({ store, id: Number(req.params.id), patch: body }));
  }));

  app.post('/api/campaigns/:id/generate-previews', authenticate, requireCsrf, asyncHandler(async (req, res) => {
    res.json(await generatePreviews({ store, config, id: Number(req.params.id) }));
  }));

  app.post('/api/campaigns/:id/approve', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(confirmSchema, req.body);
    res.json(await approveCampaign({
      store,
      config,
      actor: actorOf(req, res),
      id: Number(req.params.id),
      confirmRecipientCount: body.confirmRecipientCount,
    }));
  }));

  app.post('/api/campaigns/:id/start', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(confirmSchema, req.body);
    res.json(await startCampaign({
      store,
      config,
      actor: actorOf(req, res),
      id: Number(req.params.id),
      confirmRecipientCount: body.confirmRecipientCount,
    }));
  }));

  app.post('/api/campaigns/:id/pause', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await pauseCampaign({ store, actor: actorOf(req, res), id: Number(req.params.id) }));
  }));

  app.post('/api/campaigns/:id/cancel', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await cancelCampaign({ store, actor: actorOf(req, res), id: Number(req.params.id) }));
  }));

  app.get('/api/campaigns/:id/recipients', authenticate, asyncHandler(async (req, res) => {
    const query = parse(paginationSchema.extend({ status: z.string().optional() }), req.query);
    res.json(await store.listRecipients(Number(req.params.id), query));
  }));

  app.get('/api/campaigns/:id/events', authenticate, asyncHandler(async (req, res) => {
    const campaign = await store.findCampaign(Number(req.params.id));
    if (!campaign) throw new AppError(404, 'Campaign not found.', 'NOT_FOUND');
    res.json(await campaignReport(store, campaign.id));
  }));

  app.get('/api/suppression', authenticate, asyncHandler(async (req, res) => {
    const query = parse(paginationSchema, req.query);
    res.json(await store.listSuppressions(query));
  }));

  app.post('/api/suppression', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(suppressionSchema, req.body);
    res.status(201).json(await addSuppression({
      store,
      actor: actorOf(req, res),
      email: body.email,
      reason: body.reason as SuppressionReason,
      notes: body.notes,
    }));
  }));

  app.post('/api/suppression/:id/lift', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(liftSchema, req.body);
    res.json(await liftSuppression({
      store,
      actor: actorOf(req, res),
      id: Number(req.params.id),
      confirmEmail: body.confirmEmail,
    }));
  }));

  const schedulerSchema = z.object({
    dailyLimit: z.number().int().min(1).max(500),
    executionTime: z.string().trim().max(5),
    workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    timezone: z.string().trim().min(1).max(64),
    templateId: z.number().int().positive().nullable(),
    aiPersonalization: z.boolean(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  });

  app.get('/api/scheduler', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
    res.json(await getSchedulerDashboard(store, new Date(), config.mode));
  }));

  app.put('/api/scheduler', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    const body = parse(schedulerSchema, req.body);
    const saved = await saveSchedulerConfig({
      store,
      config,
      actor: actorOf(req, res),
      patch: body,
    });
    res.json(saved);
  }));

  app.post('/api/scheduler/enable', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await enableScheduler({ store, actor: actorOf(req, res), mode: config.mode }));
  }));

  app.post('/api/scheduler/pause', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await pauseScheduler({ store, actor: actorOf(req, res) }));
  }));

  app.post('/api/scheduler/resume', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await resumeScheduler({ store, actor: actorOf(req, res), mode: config.mode }));
  }));

  app.post('/api/scheduler/stop', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await stopScheduler({ store, actor: actorOf(req, res) }));
  }));

  app.post('/api/scheduler/run', authenticate, requireCsrf, requireAdmin, asyncHandler(async (req, res) => {
    if (config.mode !== 'dry_run') {
      throw new AppError(409, 'The manual batch button only runs while dry-run mode is on.', 'DRY_RUN_REQUIRED');
    }
    const result = await executeSchedulerRun({
      store,
      config,
      mailer: deps.mailer,
      aiClient: deps.aiClient,
      actor: actorOf(req, res),
      trigger: 'manual',
    });
    res.status(result.outcome === 'ran' ? 201 : 200).json(result);
  }));

  app.post('/api/webhooks/ses', asyncHandler(async (req, res) => {
    if (!config.sesSnsTopicArn) {
      throw new AppError(503, 'SES SNS topic is not configured.', 'SNS_NOT_CONFIGURED');
    }
    const verified = await deps.snsVerifier(req.body);
    if (verified.topicArn !== config.sesSnsTopicArn) {
      throw new AppError(401, 'SNS topic is not accepted.', 'SNS_UNVERIFIED');
    }
    if (verified.type === 'subscription_confirmation') {
      if (config.sesSnsAutoConfirm && isSafeSnsSubscribeUrl(verified.subscribeUrl)) {
        await fetch(verified.subscribeUrl);
      }
      logInfo('SNS subscription confirmation received.', { autoConfirm: config.sesSnsAutoConfirm });
      res.json({ ok: true, confirmation: true });
      return;
    }
    res.json({ ok: true, ...(await applySesEvent(store, verified.message)) });
  }));

  app.get('/unsubscribe/:token', asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const record = /^[A-Za-z0-9_-]{20,200}$/.test(token)
      ? await store.findUnsubscribeToken(hashUnsubscribeToken(token))
      : null;
    res.type('html').send(unsubscribePage({
      token,
      senderEmail: config.sesFromEmail,
      emailMasked: record ? maskEmail(record.emailNormalized) : undefined,
      error: record ? undefined : 'This unsubscribe link is invalid.',
    }));
  }));

  app.post('/unsubscribe/:token', asyncHandler(async (req, res) => {
    try {
      const result = await unsubscribeAddress(store, String(req.params.token), req.ip ? req.ip.slice(0, 64) : null);
      if (req.get('accept')?.includes('application/json')) {
        res.json({ ok: true, emailMasked: result.emailMasked });
        return;
      }
      res.type('html').send(unsubscribePage({ token: String(req.params.token), senderEmail: config.sesFromEmail, done: true, emailMasked: result.emailMasked }));
    } catch (error) {
      if (req.get('accept')?.includes('application/json')) throw error;
      const message = error instanceof AppError ? error.message : 'This unsubscribe link is invalid.';
      res.status(error instanceof AppError ? error.statusCode : 400).type('html').send(
        unsubscribePage({ token: String(req.params.token), senderEmail: config.sesFromEmail, error: message }),
      );
    }
  }));
}

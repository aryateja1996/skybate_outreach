import { isValidEmail } from '../domain/email';
import { defaultSchedulerSettings, outreachBlockReason, recipientBlocksScheduler, strongerOutreachBlock } from '../domain/scheduler';
import { AppError, DuplicateEmailError } from '../errors';
import type {
  Campaign,
  Contact,
  DashboardStats,
  EmailEvent,
  ImportPreviewRecord,
  OutreachHistoryItem,
  Recipient,
  RecipientStatus,
  SchedulerDayCounts,
  SchedulerPools,
  SchedulerRun,
  SchedulerSettings,
  SessionRecord,
  Suppression,
  Template,
  User,
} from '../types';
import type {
  CampaignPatch,
  ContactPatch,
  ContactQuery,
  NewAudit,
  NewCampaign,
  NewContact,
  NewEmailEvent,
  NewImportBatch,
  NewRecipient,
  NewSuppression,
  NewTemplate,
  NewUser,
  OutreachBlock,
  PageQuery,
  RecipientCompletion,
  RecipientIssueCounts,
  Store,
  TemplatePatch,
} from './types';

type StoredRecipient = Omit<Recipient, 'email' | 'contactName' | 'companyName' | 'eligibilityStatus'>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function paginate<T>(rows: T[], page: number, pageSize: number): { rows: T[]; total: number; page: number; pageSize: number } {
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize).map((row) => clone(row)), total: rows.length, page, pageSize };
}

function includes(value: string | null | undefined, search: string): boolean {
  return (value ?? '').toLowerCase().includes(search.toLowerCase());
}

const OPEN_OUTREACH = new Set<RecipientStatus>(['pending', 'sending', 'retry_wait']);
const SMTP_ACCEPTED = new Set<RecipientStatus>(['accepted', 'delivered', 'bounced', 'complained']);

const TERMINAL = new Set<RecipientStatus>([
  'simulated',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
  'cancelled',
]);

export class MemoryStore implements Store {
  private seq = 1;
  private users: User[] = [];
  private sessions: SessionRecord[] = [];
  private contacts: Contact[] = [];
  private previews: ImportPreviewRecord[] = [];
  private batches: NewImportBatch[] = [];
  private templates: Template[] = [];
  private aiLogs: Array<{ status: string }> = [];
  private campaigns: Campaign[] = [];
  private recipients: StoredRecipient[] = [];
  private suppressions: Suppression[] = [];
  private events: EmailEvent[] = [];
  private unsubscribeTokens: Array<{ contactId: number; tokenHash: string; usedAt: Date | null }> = [];
  private audits: Array<{ id: number }> = [];
  private schedulerSettings: SchedulerSettings = defaultSchedulerSettings();
  private schedulerRuns: SchedulerRun[] = [];
  private gate: Promise<void> = Promise.resolve();
  private inTransaction = false;

  private nextId(): number {
    const id = this.seq;
    this.seq += 1;
    return id;
  }

  private snapshot(): unknown {
    return {
      seq: this.seq,
      users: this.users,
      sessions: this.sessions,
      contacts: this.contacts,
      previews: this.previews,
      batches: this.batches,
      templates: this.templates,
      aiLogs: this.aiLogs,
      campaigns: this.campaigns,
      recipients: this.recipients,
      suppressions: this.suppressions,
      events: this.events,
      unsubscribeTokens: this.unsubscribeTokens,
      audits: this.audits,
      schedulerSettings: this.schedulerSettings,
      schedulerRuns: this.schedulerRuns,
    };
  }

  private restore(snapshot: unknown): void {
    const data = snapshot as ReturnType<MemoryStore['snapshot']> & {
      seq: number;
      users: User[];
      sessions: SessionRecord[];
      contacts: Contact[];
      previews: ImportPreviewRecord[];
      batches: NewImportBatch[];
      templates: Template[];
      aiLogs: Array<{ status: string }>;
      campaigns: Campaign[];
      recipients: StoredRecipient[];
      suppressions: Suppression[];
      events: EmailEvent[];
      unsubscribeTokens: Array<{ contactId: number; tokenHash: string; usedAt: Date | null }>;
      audits: Array<{ id: number }>;
      schedulerSettings: SchedulerSettings;
      schedulerRuns: SchedulerRun[];
    };
    this.seq = data.seq;
    this.users = data.users;
    this.sessions = data.sessions;
    this.contacts = data.contacts;
    this.previews = data.previews;
    this.batches = data.batches;
    this.templates = data.templates;
    this.aiLogs = data.aiLogs;
    this.campaigns = data.campaigns;
    this.recipients = data.recipients;
    this.suppressions = data.suppressions;
    this.events = data.events;
    this.unsubscribeTokens = data.unsubscribeTokens;
    this.audits = data.audits;
    this.schedulerSettings = data.schedulerSettings;
    this.schedulerRuns = data.schedulerRuns;
  }

  async ping(): Promise<void> {
    return undefined;
  }

  async withTransaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const previous = this.gate;
    let release: () => void = () => undefined;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    this.inTransaction = true;
    const snapshot = structuredClone(this.snapshot());
    try {
      return await fn(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      this.inTransaction = false;
      release();
    }
  }

  async countUsers(): Promise<number> {
    return this.users.length;
  }

  async createUser(input: NewUser): Promise<User> {
    if (this.users.some((user) => user.email === input.email)) {
      throw new AppError(409, 'A user with this email already exists.', 'DUPLICATE_USER');
    }
    const now = new Date();
    const user: User = { id: this.nextId(), ...input, createdAt: now, updatedAt: now };
    this.users.push(user);
    return clone(user);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return clone(this.users.find((user) => user.email === email) ?? null);
  }

  async findUserById(id: number): Promise<User | null> {
    return clone(this.users.find((user) => user.id === id) ?? null);
  }

  async createSession(input: { id: string; userId: number; csrfToken: string; expiresAt: Date }): Promise<void> {
    this.sessions.push({ ...input, createdAt: new Date() });
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    return clone(this.sessions.find((session) => session.id === id) ?? null);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter((session) => session.id !== id);
  }

  private contactMatches(contact: Contact, query: Omit<ContactQuery, 'page' | 'pageSize'>): boolean {
    if (query.eligibility && contact.eligibilityStatus !== query.eligibility) return false;
    if (query.missingInfo === true && !contact.missingInfo) return false;
    if (query.missingInfo === false && contact.missingInfo) return false;
    if (query.outreach === 'never' && (contact.isContacted || contact.eligibilityStatus !== 'eligible')) return false;
    if (query.outreach === 'contacted' && (!contact.isContacted || contact.eligibilityStatus === 'suppressed')) return false;
    if (query.outreach === 'suppressed' && contact.eligibilityStatus !== 'suppressed') return false;
    if (query.outreach === 'invalid' && contact.eligibilityStatus !== 'invalid_email') return false;
    if (query.blockMode && this.contactBlockedForOutreach(contact.id, query.blockMode)) return false;
    if (query.search) {
      const found =
        includes(contact.email, query.search) ||
        includes(contact.contactName, query.search) ||
        includes(contact.companyName, query.search) ||
        includes(contact.designation, query.search);
      if (!found) return false;
    }
    return true;
  }

  async listContacts(query: ContactQuery) {
    const rows = this.contacts.filter((contact) => this.contactMatches(contact, query)).sort((a, b) => b.id - a.id);
    return paginate(rows, query.page, query.pageSize);
  }

  async listAllContacts(query: Omit<ContactQuery, 'page' | 'pageSize'> & { limit: number }): Promise<Contact[]> {
    return this.contacts
      .filter((contact) => this.contactMatches(contact, query))
      .sort((a, b) => b.id - a.id)
      .slice(0, query.limit)
      .map((contact) => clone(contact));
  }

  async findContactById(id: number): Promise<Contact | null> {
    return clone(this.contacts.find((contact) => contact.id === id) ?? null);
  }

  async findContactsByIds(ids: number[]): Promise<Contact[]> {
    const wanted = new Set(ids);
    return this.contacts.filter((contact) => wanted.has(contact.id)).map((contact) => clone(contact));
  }

  async lockContacts(ids: number[]): Promise<Contact[]> {
    return this.findContactsByIds(ids);
  }

  private contactBlockedForOutreach(contactId: number, mode: 'dry_run' | 'live', exceptCampaignId?: number): boolean {
    return this.recipients.some((recipient) => {
      if (recipient.contactId !== contactId) return false;
      if (exceptCampaignId && recipient.campaignId === exceptCampaignId) return false;
      const campaign = this.campaigns.find((item) => item.id === recipient.campaignId);
      return recipientBlocksScheduler({
        status: recipient.status,
        failureClass: recipient.failureClass,
        campaignDryRun: campaign?.dryRun === true,
        mode,
      });
    });
  }

  async contactsBlockedForOutreach(ids: number[], mode: 'dry_run' | 'live', exceptCampaignId?: number): Promise<OutreachBlock[]> {
    const wanted = new Set(ids);
    const best = new Map<number, OutreachBlock['reason']>();
    for (const recipient of this.recipients) {
      if (!wanted.has(recipient.contactId)) continue;
      if (exceptCampaignId && recipient.campaignId === exceptCampaignId) continue;
      const campaign = this.campaigns.find((item) => item.id === recipient.campaignId);
      const reason = outreachBlockReason({
        status: recipient.status,
        failureClass: recipient.failureClass,
        campaignDryRun: campaign?.dryRun === true,
        mode,
      });
      if (!reason) continue;
      best.set(recipient.contactId, strongerOutreachBlock(best.get(recipient.contactId) ?? null, reason));
    }
    return [...best].map(([contactId, reason]) => ({ contactId, reason }));
  }

  async contactsWithOpenOutreach(ids: number[]): Promise<number[]> {
    const wanted = new Set(ids);
    return [...new Set(
      this.recipients
        .filter((recipient) => wanted.has(recipient.contactId) && OPEN_OUTREACH.has(recipient.status))
        .map((recipient) => recipient.contactId),
    )];
  }

  async contactAcceptedByOtherCampaign(input: { contactId: number; recipientId: number; queuedAt: Date }): Promise<boolean> {
    return this.recipients.some((recipient) =>
      recipient.contactId === input.contactId
      && recipient.id !== input.recipientId
      && SMTP_ACCEPTED.has(recipient.status)
      && recipient.sentAt !== null
      && recipient.sentAt.getTime() >= input.queuedAt.getTime(),
    );
  }

  async recordAcceptedOutreach(input: { contactId: number; campaignId: number; sentAt: Date }): Promise<void> {
    const contact = this.contacts.find((item) => item.id === input.contactId);
    if (!contact) return;
    const campaign = this.campaigns.find((item) => item.id === input.campaignId);
    contact.isContacted = true;
    contact.contactCount += 1;
    contact.lastContactedAt = input.sentAt;
    contact.lastCampaignId = input.campaignId;
    contact.lastCampaignName = campaign?.name ?? contact.lastCampaignName;
    contact.updatedAt = new Date();
  }

  async listOutreachHistory(contactId: number): Promise<OutreachHistoryItem[]> {
    return this.recipients
      .filter((recipient) => recipient.contactId === contactId)
      .map((recipient) => {
        const campaign = this.campaigns.find((item) => item.id === recipient.campaignId);
        return {
          recipientId: recipient.id,
          campaignId: recipient.campaignId,
          campaignName: campaign?.name ?? 'Campaign',
          subject: recipient.personalizedSubject,
          sentAt: recipient.sentAt,
          createdAt: recipient.createdAt,
          status: recipient.status,
          attemptCount: recipient.attemptCount,
          smtpAccepted: SMTP_ACCEPTED.has(recipient.status),
          delivered: recipient.status === 'delivered',
          bounced: recipient.status === 'bounced',
          complained: recipient.status === 'complained',
        };
      })
      .sort((left, right) => {
        const leftTime = (left.sentAt ?? left.createdAt).getTime();
        const rightTime = (right.sentAt ?? right.createdAt).getTime();
        return rightTime - leftTime || right.recipientId - left.recipientId;
      });
  }

  async findContactsByNormalizedEmails(emails: string[]): Promise<Contact[]> {
    const wanted = new Set(emails);
    return this.contacts.filter((contact) => wanted.has(contact.emailNormalized)).map((contact) => clone(contact));
  }

  async insertContacts(rows: NewContact[]): Promise<Contact[]> {
    const existing = new Set(this.contacts.map((contact) => contact.emailNormalized));
    const seen = new Set<string>();
    for (const row of rows) {
      if (existing.has(row.emailNormalized) || seen.has(row.emailNormalized)) throw new DuplicateEmailError();
      seen.add(row.emailNormalized);
    }
    const now = new Date();
    return rows.map((row) => {
      const contact: Contact = {
        id: this.nextId(),
        ...row,
        isContacted: false,
        lastContactedAt: null,
        contactCount: 0,
        lastCampaignId: null,
        lastCampaignName: null,
        createdAt: now,
        updatedAt: now,
      };
      this.contacts.push(contact);
      return clone(contact);
    });
  }

  async updateContact(id: number, patch: ContactPatch): Promise<Contact> {
    const contact = this.contacts.find((item) => item.id === id);
    if (!contact) throw new AppError(404, 'Contact not found.', 'NOT_FOUND');
    if (patch.emailNormalized && patch.emailNormalized !== contact.emailNormalized) {
      const clash = this.contacts.some((item) => item.emailNormalized === patch.emailNormalized && item.id !== id);
      if (clash) throw new DuplicateEmailError();
    }
    Object.assign(contact, stripUndefined(patch), { updatedAt: new Date() });
    return clone(contact);
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const countStatus = (status: RecipientStatus) => this.recipients.filter((item) => item.status === status).length;
    const accepted = this.recipients.filter((item) =>
      ['accepted', 'delivered', 'bounced', 'complained'].includes(item.status),
    ).length;
    return {
      totalContacts: this.contacts.length,
      eligibleContacts: this.contacts.filter((item) => item.eligibilityStatus === 'eligible').length,
      duplicateContacts: this.batches.reduce((sum, batch) => sum + batch.duplicateCount, 0),
      invalidFormatAddresses: this.contacts.filter((item) => item.eligibilityStatus === 'invalid_email').length,
      draftCampaigns: this.campaigns.filter((item) => item.status === 'draft' || item.status === 'previewed').length,
      approvedCampaigns: this.campaigns.filter((item) => item.status === 'approved').length,
      sendingAttempts: this.recipients.reduce((sum, item) => sum + item.attemptCount, 0),
      simulatedResults: countStatus('simulated'),
      acceptedByProvider: accepted,
      confirmedDeliveries: countStatus('delivered'),
      bounces: countStatus('bounced'),
      complaints: countStatus('complained'),
      suppressedContacts: this.contacts.filter((item) => item.eligibilityStatus === 'suppressed').length,
      unsubscribeRequests: this.suppressions.filter((item) => item.active && item.reason === 'unsubscribe').length,
      neverContacted: this.contacts.filter((item) => !item.isContacted && item.eligibilityStatus === 'eligible').length,
      previouslyContacted: this.contacts.filter((item) => item.isContacted && item.eligibilityStatus !== 'suppressed').length,
      failedSends: countStatus('failed'),
    };
  }

  async saveImportPreview(preview: ImportPreviewRecord): Promise<void> {
    this.previews = this.previews.filter((item) => item.id !== preview.id);
    this.previews.push(clone(preview));
  }

  async getImportPreview(id: string): Promise<ImportPreviewRecord | null> {
    return clone(this.previews.find((item) => item.id === id) ?? null);
  }

  async deleteImportPreview(id: string): Promise<void> {
    this.previews = this.previews.filter((item) => item.id !== id);
  }

  async createImportBatch(batch: NewImportBatch): Promise<void> {
    this.batches.push(clone(batch));
  }

  async listTemplates(): Promise<Template[]> {
    return this.templates.map((template) => clone(template)).sort((a, b) => b.id - a.id);
  }

  async findTemplate(id: number): Promise<Template | null> {
    return clone(this.templates.find((template) => template.id === id) ?? null);
  }

  async createTemplate(input: NewTemplate): Promise<Template> {
    const now = new Date();
    const template: Template = {
      id: this.nextId(),
      name: input.name,
      style: input.style,
      subject: input.subject,
      body: input.body,
      isDefault: input.isDefault ?? false,
      aiGenerated: input.aiGenerated ?? false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.push(template);
    return clone(template);
  }

  async updateTemplate(id: number, patch: TemplatePatch): Promise<Template> {
    const template = this.templates.find((item) => item.id === id);
    if (!template) throw new AppError(404, 'Template not found.', 'NOT_FOUND');
    Object.assign(template, stripUndefined(patch), { updatedAt: new Date() });
    return clone(template);
  }

  async logAiGeneration(entry: {
    status: 'success' | 'fallback' | 'error';
    model: string | null;
    errorCode: string | null;
    createdBy: number | null;
  }): Promise<void> {
    this.aiLogs.push({ status: entry.status });
  }

  async createCampaign(input: NewCampaign): Promise<Campaign> {
    const now = new Date();
    const campaign: Campaign = {
      id: this.nextId(),
      name: input.name,
      templateId: input.templateId,
      subject: input.subject,
      body: input.body,
      senderName: input.senderName,
      senderEmail: input.senderEmail,
      status: 'draft',
      totalRecipients: 0,
      recipientLimit: input.recipientLimit,
      sendRatePerSecond: input.sendRatePerSecond,
      batchSize: input.batchSize,
      maxAttempts: input.maxAttempts,
      circuitBreakerThreshold: input.circuitBreakerThreshold,
      consecutiveFailures: 0,
      circuitBreakerTripped: false,
      dryRun: true,
      approvedAt: null,
      approvedBy: null,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      cancelledAt: null,
      sendingLockToken: null,
      sendingLockAcquiredAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.campaigns.push(campaign);
    return clone(campaign);
  }

  async updateCampaign(id: number, patch: CampaignPatch): Promise<Campaign> {
    const campaign = this.campaigns.find((item) => item.id === id);
    if (!campaign) throw new AppError(404, 'Campaign not found.', 'NOT_FOUND');
    Object.assign(campaign, stripUndefined(patch), { updatedAt: new Date() });
    return clone(campaign);
  }

  async findCampaign(id: number): Promise<Campaign | null> {
    return clone(this.campaigns.find((item) => item.id === id) ?? null);
  }

  async listCampaigns(query: PageQuery) {
    const rows = this.campaigns
      .filter((campaign) => {
        if (query.status && campaign.status !== query.status) return false;
        if (query.search && !includes(campaign.name, query.search)) return false;
        return true;
      })
      .sort((a, b) => b.id - a.id);
    return paginate(rows, query.page, query.pageSize);
  }

  async replaceRecipients(campaignId: number, rows: NewRecipient[]): Promise<void> {
    this.recipients = this.recipients.filter((item) => item.campaignId !== campaignId);
    const now = new Date();
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.contactId)) {
        throw new AppError(409, 'A contact is already in this campaign.', 'DUPLICATE_RECIPIENT');
      }
      seen.add(row.contactId);
      this.recipients.push({
        id: this.nextId(),
        campaignId,
        contactId: row.contactId,
        personalizedSubject: row.personalizedSubject,
        personalizedBody: row.personalizedBody,
        status: 'pending',
        providerMessageId: null,
        providerMessageIdNormalized: null,
        attemptCount: 0,
        lastError: null,
        failureClass: 'none',
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        sentAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private hydrate(recipient: StoredRecipient): Recipient {
    const contact = this.contacts.find((item) => item.id === recipient.contactId);
    return {
      ...clone(recipient),
      email: contact?.email ?? '',
      contactName: contact?.contactName ?? null,
      companyName: contact?.companyName ?? null,
      eligibilityStatus: contact?.eligibilityStatus ?? 'invalid_email',
    };
  }

  async listRecipients(campaignId: number, query: PageQuery) {
    const rows = this.recipients
      .filter((item) => item.campaignId === campaignId)
      .map((item) => this.hydrate(item))
      .filter((item) => {
        if (query.status && item.status !== query.status) return false;
        if (!query.search) return true;
        return includes(item.email, query.search) || includes(item.contactName, query.search) || includes(item.companyName, query.search);
      })
      .sort((a, b) => a.id - b.id);
    const start = (query.page - 1) * query.pageSize;
    return {
      rows: rows.slice(start, start + query.pageSize),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async recipientIssueCounts(campaignId: number): Promise<RecipientIssueCounts> {
    const rows = this.recipients.filter((item) => item.campaignId === campaignId);
    let suppressed = 0;
    let ineligible = 0;
    for (const row of rows) {
      const contact = this.contacts.find((item) => item.id === row.contactId);
      const active = contact
        ? this.suppressions.some((item) => item.active && item.emailNormalized === contact.emailNormalized)
        : false;
      if (!contact || contact.eligibilityStatus === 'suppressed' || active) {
        if (contact?.eligibilityStatus === 'suppressed' || active) suppressed += 1;
        else ineligible += 1;
      } else if (contact.eligibilityStatus !== 'eligible') ineligible += 1;
    }
    return { total: rows.length, suppressed, ineligible };
  }

  async recoverInterruptedCampaigns(): Promise<number[]> {
    const now = new Date();
    const ids: number[] = [];
    for (const campaign of this.campaigns) {
      if (campaign.status !== 'sending') continue;
      ids.push(campaign.id);
      campaign.status = 'paused';
      campaign.pausedAt = now;
      campaign.sendingLockToken = null;
      campaign.sendingLockAcquiredAt = null;
      campaign.updatedAt = now;
      for (const recipient of this.recipients) {
        if (recipient.campaignId !== campaign.id || recipient.status !== 'sending') continue;
        recipient.status = 'failed';
        recipient.failureClass = 'ambiguous';
        recipient.lastError =
          'Sending interrupted before the outcome was recorded. It was not retried automatically.';
        recipient.lockedAt = null;
        recipient.lockedBy = null;
        recipient.updatedAt = now;
      }
    }
    return ids;
  }

  async claimCampaignLock(campaignId: number, token: string, staleSeconds: number): Promise<boolean> {
    const campaign = this.campaigns.find((item) => item.id === campaignId);
    if (!campaign || campaign.status !== 'sending') return false;
    const now = new Date();
    const lockedAt = campaign.sendingLockAcquiredAt;
    const stale = !lockedAt || now.getTime() - lockedAt.getTime() >= staleSeconds * 1000;
    if (campaign.sendingLockToken && !stale) return false;
    campaign.sendingLockToken = token;
    campaign.sendingLockAcquiredAt = now;
    campaign.updatedAt = now;
    return true;
  }

  async releaseCampaignLock(campaignId: number, token: string): Promise<void> {
    const campaign = this.campaigns.find((item) => item.id === campaignId && item.sendingLockToken === token);
    if (!campaign) return;
    campaign.sendingLockToken = null;
    campaign.sendingLockAcquiredAt = null;
    campaign.updatedAt = new Date();
  }

  async claimRecipientBatch(campaignId: number, limit: number, worker: string): Promise<Recipient[]> {
    const now = new Date();
    const chosen = this.recipients
      .filter((item) => {
        if (item.campaignId !== campaignId) return false;
        if (item.status !== 'pending' && item.status !== 'retry_wait') return false;
        if (item.nextAttemptAt && item.nextAttemptAt.getTime() > now.getTime()) return false;
        if (item.lockedAt && now.getTime() - item.lockedAt.getTime() < 5 * 60 * 1000) return false;
        return true;
      })
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    for (const recipient of chosen) {
      recipient.status = 'sending';
      recipient.lockedAt = now;
      recipient.lockedBy = worker;
      recipient.updatedAt = now;
    }
    return chosen.map((item) => this.hydrate(item));
  }

  async updateRecipientFromEvent(id: number, status: RecipientStatus): Promise<void> {
    const recipient = this.recipients.find((item) => item.id === id);
    if (!recipient) return;
    recipient.status = status;
    recipient.updatedAt = new Date();
  }

  async completeRecipient(id: number, result: RecipientCompletion): Promise<boolean> {
    const recipient = this.recipients.find((item) => item.id === id && item.status === 'sending');
    if (!recipient) return false;
    recipient.status = result.status;
    if (result.providerMessageId !== undefined) recipient.providerMessageId = result.providerMessageId;
    if (result.providerMessageIdNormalized !== undefined) {
      recipient.providerMessageIdNormalized = result.providerMessageIdNormalized;
    }
    recipient.lastError = result.lastError ?? null;
    recipient.failureClass = result.failureClass ?? 'none';
    recipient.sentAt = result.sentAt ?? null;
    if (result.personalizedBody) recipient.personalizedBody = result.personalizedBody;
    if (result.incrementAttempt) recipient.attemptCount += 1;
    recipient.nextAttemptAt = null;
    recipient.lockedAt = null;
    recipient.lockedBy = null;
    recipient.updatedAt = new Date();
    return true;
  }

  async rescheduleRecipient(id: number, input: { lastError: string; nextAttemptAt: Date; incrementAttempt: boolean }): Promise<boolean> {
    const recipient = this.recipients.find((item) => item.id === id && item.status === 'sending');
    if (!recipient) return false;
    recipient.status = 'retry_wait';
    recipient.lastError = input.lastError;
    recipient.failureClass = 'transient';
    recipient.nextAttemptAt = input.nextAttemptAt;
    if (input.incrementAttempt) recipient.attemptCount += 1;
    recipient.lockedAt = null;
    recipient.lockedBy = null;
    recipient.updatedAt = new Date();
    return true;
  }

  async releaseRecipientToStatus(id: number, status: RecipientStatus): Promise<void> {
    const recipient = this.recipients.find((item) => item.id === id && item.status === 'sending');
    if (!recipient) return;
    recipient.status = status;
    recipient.lockedAt = null;
    recipient.lockedBy = null;
    recipient.updatedAt = new Date();
  }

  async cancelOpenRecipients(campaignId: number): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const recipient of this.recipients) {
      if (recipient.campaignId !== campaignId) continue;
      if (!['pending', 'retry_wait', 'sending'].includes(recipient.status)) continue;
      recipient.status = 'cancelled';
      recipient.lockedAt = null;
      recipient.lockedBy = null;
      recipient.updatedAt = now;
      count += 1;
    }
    return count;
  }

  async listSendableCampaigns(): Promise<Campaign[]> {
    return this.campaigns.filter((item) => item.status === 'sending').map((item) => clone(item));
  }

  async markCampaignCompletedIfDone(campaignId: number): Promise<boolean> {
    const campaign = this.campaigns.find((item) => item.id === campaignId);
    const rows = this.recipients.filter((item) => item.campaignId === campaignId);
    if (!campaign || rows.length === 0) return false;
    if (!rows.every((item) => TERMINAL.has(item.status))) return false;
    if (campaign.status !== 'sending') return false;
    campaign.status = 'completed';
    campaign.completedAt = new Date();
    campaign.sendingLockToken = null;
    campaign.sendingLockAcquiredAt = null;
    campaign.updatedAt = new Date();
    return true;
  }

  async recordCircuitFailure(campaignId: number, threshold: number): Promise<boolean> {
    const campaign = this.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return false;
    campaign.consecutiveFailures += 1;
    campaign.updatedAt = new Date();
    if (campaign.consecutiveFailures < threshold || campaign.status !== 'sending') return false;
    campaign.status = 'paused';
    campaign.pausedAt = new Date();
    campaign.circuitBreakerTripped = true;
    campaign.sendingLockToken = null;
    campaign.sendingLockAcquiredAt = null;
    return true;
  }

  async resetCircuitFailures(campaignId: number): Promise<void> {
    const campaign = this.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return;
    campaign.consecutiveFailures = 0;
    campaign.circuitBreakerTripped = false;
    campaign.updatedAt = new Date();
  }

  async findActiveSuppression(emailNormalized: string): Promise<Suppression | null> {
    return clone(
      this.suppressions.find((item) => item.active && item.emailNormalized === emailNormalized) ?? null,
    );
  }

  async findActiveSuppressions(emails: string[]): Promise<Set<string>> {
    const wanted = new Set(emails);
    return new Set(
      this.suppressions.filter((item) => item.active && wanted.has(item.emailNormalized)).map((item) => item.emailNormalized),
    );
  }

  async listSuppressions(query: PageQuery) {
    const rows = this.suppressions
      .filter((item) => (query.search ? includes(item.emailNormalized, query.search) : true))
      .sort((a, b) => b.id - a.id);
    return paginate(rows, query.page, query.pageSize);
  }

  async upsertSuppression(input: NewSuppression): Promise<Suppression> {
    const existing = this.suppressions.find((item) => item.emailNormalized === input.emailNormalized);
    const now = new Date();
    if (existing) {
      existing.reason = input.reason;
      existing.source = input.source;
      existing.notes = input.notes ?? existing.notes;
      existing.active = true;
      existing.updatedAt = now;
      return clone(existing);
    }
    const created: Suppression = {
      id: this.nextId(),
      emailNormalized: input.emailNormalized,
      reason: input.reason,
      source: input.source,
      notes: input.notes,
      active: true,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.suppressions.push(created);
    return clone(created);
  }

  async liftSuppression(id: number): Promise<Suppression | null> {
    const row = this.suppressions.find((item) => item.id === id && item.active);
    if (!row) return null;
    row.active = false;
    row.updatedAt = new Date();
    return clone(row);
  }

  async markContactsSuppressed(emailNormalized: string): Promise<void> {
    const now = new Date();
    for (const contact of this.contacts) {
      if (contact.emailNormalized !== emailNormalized) continue;
      contact.eligibilityStatus = 'suppressed';
      contact.updatedAt = now;
    }
  }

  async restoreContactEligibility(emailNormalized: string): Promise<void> {
    const now = new Date();
    for (const contact of this.contacts) {
      if (contact.emailNormalized !== emailNormalized || contact.eligibilityStatus !== 'suppressed') continue;
      contact.eligibilityStatus = isValidEmail(contact.emailNormalized) ? 'eligible' : 'invalid_email';
      contact.updatedAt = now;
    }
  }

  async insertEmailEvent(event: NewEmailEvent): Promise<{ inserted: boolean; id: number }> {
    const existing = this.events.find((item) => item.eventKey === event.eventKey);
    if (existing) return { inserted: false, id: existing.id };
    const created: EmailEvent = {
      id: this.nextId(),
      campaignRecipientId: event.campaignRecipientId,
      providerMessageId: event.providerMessageId,
      eventType: event.eventType,
      eventKey: event.eventKey,
      payload: event.payload,
      occurredAt: event.occurredAt,
      createdAt: new Date(),
    };
    this.events.push(created);
    return { inserted: true, id: created.id };
  }

  async listEventsForCampaign(campaignId: number, query: PageQuery) {
    const ids = new Set(this.recipients.filter((item) => item.campaignId === campaignId).map((item) => item.id));
    const rows = this.events.filter((item) => item.campaignRecipientId != null && ids.has(item.campaignRecipientId)).sort((a, b) => b.id - a.id);
    return paginate(rows, query.page, query.pageSize);
  }

  async findRecipientByMessageId(messageIdNormalized: string): Promise<Recipient | null> {
    const recipient = this.recipients.find((item) => item.providerMessageIdNormalized === messageIdNormalized);
    return recipient ? this.hydrate(recipient) : null;
  }

  async createUnsubscribeToken(input: { contactId: number; tokenHash: string }): Promise<void> {
    this.unsubscribeTokens.push({ contactId: input.contactId, tokenHash: input.tokenHash, usedAt: null });
  }

  async findUnsubscribeToken(tokenHash: string) {
    const token = this.unsubscribeTokens.find((item) => item.tokenHash === tokenHash);
    if (!token) return null;
    const contact = this.contacts.find((item) => item.id === token.contactId);
    if (!contact) return null;
    return { contactId: token.contactId, emailNormalized: contact.emailNormalized, usedAt: token.usedAt };
  }

  async markUnsubscribeTokenUsed(tokenHash: string): Promise<void> {
    const token = this.unsubscribeTokens.find((item) => item.tokenHash === tokenHash);
    if (token && !token.usedAt) token.usedAt = new Date();
  }

  async addAudit(entry: NewAudit) {
    const created = { id: this.nextId(), ...entry, createdAt: new Date() };
    this.audits.push(created);
    return clone(created);
  }

  async getSchedulerSettings(): Promise<SchedulerSettings> {
    return clone(this.schedulerSettings);
  }

  async lockSchedulerSettings(): Promise<SchedulerSettings> {
    return this.getSchedulerSettings();
  }

  async saveSchedulerSettings(settings: SchedulerSettings): Promise<SchedulerSettings> {
    this.schedulerSettings = clone(settings);
    return clone(this.schedulerSettings);
  }

  async listSchedulerRuns(limit: number): Promise<SchedulerRun[]> {
    return this.schedulerRuns
      .slice()
      .sort((left, right) => right.id - left.id)
      .slice(0, limit)
      .map((run) => clone(run));
  }

  async listRunningSchedulerRuns(): Promise<SchedulerRun[]> {
    return this.schedulerRuns.filter((run) => run.status === 'running').map((run) => clone(run));
  }

  async findSchedulerRunByDate(scheduledDate: string): Promise<SchedulerRun | null> {
    const run = this.schedulerRuns.find((item) => item.scheduledDate === scheduledDate);
    return run ? clone(run) : null;
  }

  async insertSchedulerRun(input: {
    scheduledDate: string;
    batchNumber: number;
    trigger: SchedulerRun['trigger'];
    startedAt: Date;
  }): Promise<SchedulerRun> {
    if (this.schedulerRuns.some((run) => run.scheduledDate === input.scheduledDate)) {
      throw new AppError(409, 'A scheduler batch already exists for this date.', 'SCHEDULER_ALREADY_RAN');
    }
    const run: SchedulerRun = {
      id: this.nextId(),
      scheduledDate: input.scheduledDate,
      batchNumber: input.batchNumber,
      campaignId: null,
      status: 'running',
      trigger: input.trigger,
      selectedCount: 0,
      errorMessage: null,
      startedAt: input.startedAt,
      finishedAt: null,
    };
    this.schedulerRuns.push(run);
    return clone(run);
  }

  async updateSchedulerRun(id: number, patch: Partial<Omit<SchedulerRun, 'id' | 'scheduledDate' | 'trigger'>>): Promise<SchedulerRun> {
    const run = this.schedulerRuns.find((item) => item.id === id);
    if (!run) throw new AppError(404, 'Scheduler run not found.', 'NOT_FOUND');
    Object.assign(run, stripUndefined(patch));
    return clone(run);
  }

  private schedulerEligibleContacts(mode: 'dry_run' | 'live'): Contact[] {
    const suppressed = new Set(
      this.suppressions.filter((item) => item.active).map((item) => item.emailNormalized),
    );
    const seen = new Set<string>();
    return this.contacts
      .slice()
      .sort((left, right) => left.id - right.id)
      .filter((contact) => {
        if (seen.has(contact.emailNormalized)) return false;
        seen.add(contact.emailNormalized);
        if (!isValidEmail(contact.email) || contact.eligibilityStatus !== 'eligible' || contact.isContacted) return false;
        if (suppressed.has(contact.emailNormalized)) return false;
        const blocked = this.recipients.some((recipient) => {
          if (recipient.contactId !== contact.id) return false;
          const campaign = this.campaigns.find((item) => item.id === recipient.campaignId);
          return recipientBlocksScheduler({
            status: recipient.status,
            failureClass: recipient.failureClass,
            campaignDryRun: campaign?.dryRun === true,
            mode,
          });
        });
        return !blocked;
      });
  }

  async selectSchedulerContacts(limit: number, mode: 'dry_run' | 'live'): Promise<Contact[]> {
    return this.schedulerEligibleContacts(mode).slice(0, limit).map((contact) => clone(contact));
  }

  async countSchedulerPools(mode: 'dry_run' | 'live'): Promise<SchedulerPools> {
    const suppressed = new Set(this.suppressions.filter((item) => item.active).map((item) => item.emailNormalized));
    const eligible = this.contacts.filter(
      (contact) => contact.eligibilityStatus === 'eligible' && isValidEmail(contact.email) && !suppressed.has(contact.emailNormalized),
    ).length;
    return {
      eligible,
      remaining: this.schedulerEligibleContacts(mode).length,
      contacted: this.contacts.filter((contact) => contact.isContacted).length,
    };
  }

  async countSmtpAcceptedBetween(start: Date, end: Date): Promise<number> {
    return this.recipients.filter((recipient) => {
      if (!['accepted', 'delivered', 'bounced', 'complained'].includes(recipient.status) || !recipient.sentAt) return false;
      const sent = recipient.sentAt.getTime();
      return sent >= start.getTime() && sent < end.getTime();
    }).length;
  }

  async schedulerDayCounts(scheduledDate: string): Promise<SchedulerDayCounts> {
    const runs = this.schedulerRuns.filter((run) => run.scheduledDate === scheduledDate);
    const campaignIds = new Set(runs.map((run) => run.campaignId).filter((id): id is number => id !== null));
    const recipients = this.recipients.filter((recipient) => campaignIds.has(recipient.campaignId));
    const count = (status: RecipientStatus) => recipients.filter((recipient) => recipient.status === status).length;
    return {
      batches: runs.length,
      recipients: recipients.length,
      simulated: count('simulated'),
      accepted: recipients.filter((recipient) => ['accepted', 'delivered', 'bounced', 'complained'].includes(recipient.status)).length,
      delivered: count('delivered'),
      bounced: count('bounced'),
      complained: count('complained'),
      failed: count('failed'),
    };
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function stripUndefined<T extends object>(patch: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, value] of Object.entries(patch) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

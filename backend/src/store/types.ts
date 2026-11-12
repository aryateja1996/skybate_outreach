import type {
  AnalyzedRow,
  AuditEntry,
  Campaign,
  CampaignStatus,
  Contact,
  DashboardStats,
  EligibilityStatus,
  EmailEvent,
  EmailEventType,
  FailureClass,
  ImportPreviewRecord,
  ImportSummary,
  OutreachHistoryItem,
  Page,
  Recipient,
  RecipientStatus,
  Role,
  SchedulerDayCounts,
  SchedulerPools,
  SchedulerRun,
  SchedulerSettings,
  SessionRecord,
  Suppression,
  SuppressionReason,
  Template,
  User,
} from '../types';

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
  role: Role;
}

export interface NewContact {
  email: string;
  emailNormalized: string;
  contactName: string | null;
  companyName: string | null;
  designation: string | null;
  website: string | null;
  source: string | null;
  eligibilityStatus: EligibilityStatus;
  missingInfo: boolean;
}

export interface ContactPatch {
  email?: string;
  emailNormalized?: string;
  contactName?: string | null;
  companyName?: string | null;
  designation?: string | null;
  website?: string | null;
  source?: string | null;
  eligibilityStatus?: EligibilityStatus;
  missingInfo?: boolean;
}

export type OutreachFilter = 'never' | 'contacted' | 'suppressed' | 'invalid';

export interface ContactQuery {
  page: number;
  pageSize: number;
  search?: string;
  eligibility?: EligibilityStatus;
  missingInfo?: boolean;
  outreach?: OutreachFilter;
  blockMode?: 'dry_run' | 'live';
}

export interface OutreachBlock {
  contactId: number;
  reason: 'open' | 'simulated' | 'accepted' | 'ambiguous';
}

export interface NewTemplate {
  name: string;
  style: string;
  subject: string;
  body: string;
  isDefault?: boolean;
  aiGenerated?: boolean;
  createdBy: number | null;
}

export interface TemplatePatch {
  name?: string;
  style?: string;
  subject?: string;
  body?: string;
}

export interface NewCampaign {
  name: string;
  templateId: number | null;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  recipientLimit: number;
  sendRatePerSecond: number;
  batchSize: number;
  maxAttempts: number;
  circuitBreakerThreshold: number;
  createdBy: number | null;
}

export interface CampaignPatch {
  name?: string;
  templateId?: number | null;
  subject?: string;
  body?: string;
  senderName?: string;
  status?: CampaignStatus;
  totalRecipients?: number;
  recipientLimit?: number;
  sendRatePerSecond?: number;
  batchSize?: number;
  consecutiveFailures?: number;
  circuitBreakerTripped?: boolean;
  dryRun?: boolean;
  approvedAt?: Date | null;
  approvedBy?: number | null;
  startedAt?: Date | null;
  pausedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  sendingLockToken?: string | null;
  sendingLockAcquiredAt?: Date | null;
}

export interface NewRecipient {
  contactId: number;
  personalizedSubject: string;
  personalizedBody: string;
}

export interface RecipientCompletion {
  status: RecipientStatus;
  providerMessageId?: string | null;
  providerMessageIdNormalized?: string | null;
  lastError?: string | null;
  failureClass?: FailureClass;
  sentAt?: Date | null;
  personalizedBody?: string;
  incrementAttempt: boolean;
}

export interface NewSuppression {
  emailNormalized: string;
  reason: SuppressionReason;
  source: string | null;
  notes: string | null;
  createdBy: number | null;
}

export interface NewEmailEvent {
  campaignRecipientId: number | null;
  providerMessageId: string | null;
  eventType: EmailEventType;
  eventKey: string;
  payload: Record<string, unknown> | null;
  occurredAt: Date | null;
}

export interface NewAudit {
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface NewImportBatch {
  filename: string;
  totalRows: number;
  insertedCount: number;
  duplicateCount: number;
  invalidCount: number;
  missingEmailCount: number;
  missingInfoCount: number;
  suppressedCount: number;
  createdBy: number | null;
}

export interface PageQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
}

export interface RecipientIssueCounts {
  total: number;
  suppressed: number;
  ineligible: number;
}

export interface Store {
  ping(): Promise<void>;
  withTransaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;

  countUsers(): Promise<number>;
  createUser(input: NewUser): Promise<User>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: number): Promise<User | null>;

  createSession(input: { id: string; userId: number; csrfToken: string; expiresAt: Date }): Promise<void>;
  findSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;

  listContacts(query: ContactQuery): Promise<Page<Contact>>;
  listAllContacts(query: Omit<ContactQuery, 'page' | 'pageSize'> & { limit: number }): Promise<Contact[]>;
  findContactById(id: number): Promise<Contact | null>;
  findContactsByIds(ids: number[]): Promise<Contact[]>;
  lockContacts(ids: number[]): Promise<Contact[]>;
  contactsWithOpenOutreach(ids: number[]): Promise<number[]>;
  contactsBlockedForOutreach(ids: number[], mode: 'dry_run' | 'live', exceptCampaignId?: number): Promise<OutreachBlock[]>;
  contactAcceptedByOtherCampaign(input: { contactId: number; recipientId: number; queuedAt: Date }): Promise<boolean>;
  recordAcceptedOutreach(input: { contactId: number; campaignId: number; sentAt: Date }): Promise<void>;
  listOutreachHistory(contactId: number): Promise<OutreachHistoryItem[]>;
  findContactsByNormalizedEmails(emails: string[]): Promise<Contact[]>;
  insertContacts(rows: NewContact[]): Promise<Contact[]>;
  updateContact(id: number, patch: ContactPatch): Promise<Contact>;

  getDashboardStats(): Promise<DashboardStats>;
  saveImportPreview(preview: ImportPreviewRecord): Promise<void>;
  getImportPreview(id: string): Promise<ImportPreviewRecord | null>;
  deleteImportPreview(id: string): Promise<void>;
  createImportBatch(batch: NewImportBatch): Promise<void>;

  listTemplates(): Promise<Template[]>;
  findTemplate(id: number): Promise<Template | null>;
  createTemplate(input: NewTemplate): Promise<Template>;
  updateTemplate(id: number, patch: TemplatePatch): Promise<Template>;
  logAiGeneration(entry: {
    status: 'success' | 'fallback' | 'error';
    model: string | null;
    errorCode: string | null;
    createdBy: number | null;
  }): Promise<void>;

  createCampaign(input: NewCampaign): Promise<Campaign>;
  updateCampaign(id: number, patch: CampaignPatch): Promise<Campaign>;
  findCampaign(id: number): Promise<Campaign | null>;
  listCampaigns(query: PageQuery): Promise<Page<Campaign>>;

  replaceRecipients(campaignId: number, rows: NewRecipient[]): Promise<void>;
  listRecipients(campaignId: number, query: PageQuery): Promise<Page<Recipient>>;
  recipientIssueCounts(campaignId: number): Promise<RecipientIssueCounts>;

  recoverInterruptedCampaigns(): Promise<number[]>;
  claimCampaignLock(campaignId: number, token: string, staleSeconds: number): Promise<boolean>;
  releaseCampaignLock(campaignId: number, token: string): Promise<void>;
  claimRecipientBatch(campaignId: number, limit: number, worker: string): Promise<Recipient[]>;
  completeRecipient(id: number, result: RecipientCompletion): Promise<boolean>;
  updateRecipientFromEvent(id: number, status: RecipientStatus): Promise<void>;
  rescheduleRecipient(id: number, input: {
    lastError: string;
    nextAttemptAt: Date;
    incrementAttempt: boolean;
  }): Promise<boolean>;
  releaseRecipientToStatus(id: number, status: RecipientStatus): Promise<void>;
  cancelOpenRecipients(campaignId: number): Promise<number>;
  listSendableCampaigns(): Promise<Campaign[]>;
  markCampaignCompletedIfDone(campaignId: number): Promise<boolean>;
  recordCircuitFailure(campaignId: number, threshold: number): Promise<boolean>;
  resetCircuitFailures(campaignId: number): Promise<void>;

  findActiveSuppression(emailNormalized: string): Promise<Suppression | null>;
  findActiveSuppressions(emails: string[]): Promise<Set<string>>;
  listSuppressions(query: PageQuery): Promise<Page<Suppression>>;
  upsertSuppression(input: NewSuppression): Promise<Suppression>;
  liftSuppression(id: number): Promise<Suppression | null>;
  markContactsSuppressed(emailNormalized: string): Promise<void>;
  restoreContactEligibility(emailNormalized: string): Promise<void>;

  insertEmailEvent(event: NewEmailEvent): Promise<{ inserted: boolean; id: number }>;
  listEventsForCampaign(campaignId: number, query: PageQuery): Promise<Page<EmailEvent>>;
  findRecipientByMessageId(messageIdNormalized: string): Promise<Recipient | null>;

  createUnsubscribeToken(input: { contactId: number; tokenHash: string }): Promise<void>;
  findUnsubscribeToken(tokenHash: string): Promise<{
    contactId: number;
    emailNormalized: string;
    usedAt: Date | null;
  } | null>;
  markUnsubscribeTokenUsed(tokenHash: string): Promise<void>;
  addAudit(entry: NewAudit): Promise<AuditEntry>;

  getSchedulerSettings(): Promise<SchedulerSettings>;
  lockSchedulerSettings(): Promise<SchedulerSettings>;
  saveSchedulerSettings(settings: SchedulerSettings): Promise<SchedulerSettings>;
  listSchedulerRuns(limit: number): Promise<SchedulerRun[]>;
  listRunningSchedulerRuns(): Promise<SchedulerRun[]>;
  findSchedulerRunByDate(scheduledDate: string): Promise<SchedulerRun | null>;
  insertSchedulerRun(input: {
    scheduledDate: string;
    batchNumber: number;
    trigger: SchedulerRun['trigger'];
    startedAt: Date;
  }): Promise<SchedulerRun>;
  updateSchedulerRun(id: number, patch: Partial<Omit<SchedulerRun, 'id' | 'scheduledDate' | 'trigger'>>): Promise<SchedulerRun>;
  selectSchedulerContacts(limit: number, mode: 'dry_run' | 'live'): Promise<Contact[]>;
  countSchedulerPools(mode: 'dry_run' | 'live'): Promise<SchedulerPools>;
  countSmtpAcceptedBetween(start: Date, end: Date): Promise<number>;
  schedulerDayCounts(scheduledDate: string): Promise<SchedulerDayCounts>;

  close(): Promise<void>;
}

export type { AnalyzedRow, ImportSummary };

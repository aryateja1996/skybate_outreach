export type Role = 'admin' | 'operator';

export type EligibilityStatus = 'eligible' | 'invalid_email' | 'suppressed';

export type CampaignStatus =
  | 'draft'
  | 'previewed'
  | 'approved'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type RecipientStatus =
  | 'pending'
  | 'sending'
  | 'retry_wait'
  | 'simulated'
  | 'accepted'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'suppressed'
  | 'cancelled';

export type FailureClass = 'none' | 'transient' | 'permanent' | 'ambiguous';

export type SuppressionReason = 'unsubscribe' | 'hard_bounce' | 'complaint' | 'manual';

export type EmailEventType =
  | 'send'
  | 'delivery'
  | 'bounce'
  | 'complaint'
  | 'reject'
  | 'rendering_failure'
  | 'delivery_delay';

export type ImportAction =
  | 'insert'
  | 'insert_suppressed'
  | 'insert_invalid'
  | 'skip_duplicate'
  | 'skip_missing_email';

export interface User {
  id: number;
  email: string;
  passwordHash: string;
  displayName: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: number;
  csrfToken: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface Contact {
  id: number;
  email: string;
  emailNormalized: string;
  contactName: string | null;
  companyName: string | null;
  designation: string | null;
  website: string | null;
  source: string | null;
  eligibilityStatus: EligibilityStatus;
  missingInfo: boolean;
  isContacted: boolean;
  lastContactedAt: Date | null;
  contactCount: number;
  lastCampaignId: number | null;
  lastCampaignName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ColumnMapping {
  email?: string;
  contactName?: string;
  companyName?: string;
  designation?: string;
  website?: string;
  source?: string;
}

export interface ParsedContactRow {
  rowNumber: number;
  email: string;
  contactName: string;
  companyName: string;
  designation: string;
  website: string;
  source: string;
}

export interface AnalyzedRow {
  rowNumber: number;
  email: string;
  emailNormalized: string;
  contactName: string;
  companyName: string;
  designation: string;
  website: string;
  source: string;
  issues: string[];
  action: ImportAction;
}

export interface ImportSummary {
  totalRows: number;
  readyToInsert: number;
  invalidEmail: number;
  suppressed: number;
  duplicateInFile: number;
  duplicateInDatabase: number;
  missingEmail: number;
  missingName: number;
  missingCompany: number;
  missingDesignation: number;
  missingWebsite: number;
}

export interface ImportPreviewRecord {
  id: string;
  userId: number;
  filename: string;
  rows: AnalyzedRow[];
  summary: ImportSummary;
  expiresAt: Date;
  createdAt: Date;
}

export interface ImportBatch {
  id: number;
  filename: string;
  totalRows: number;
  insertedCount: number;
  duplicateCount: number;
  invalidCount: number;
  missingEmailCount: number;
  missingInfoCount: number;
  suppressedCount: number;
  createdBy: number | null;
  createdAt: Date;
}

export interface Template {
  id: number;
  name: string;
  style: string;
  subject: string;
  body: string;
  isDefault: boolean;
  aiGenerated: boolean;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Campaign {
  id: number;
  name: string;
  templateId: number | null;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  status: CampaignStatus;
  totalRecipients: number;
  recipientLimit: number;
  sendRatePerSecond: number;
  batchSize: number;
  maxAttempts: number;
  circuitBreakerThreshold: number;
  consecutiveFailures: number;
  circuitBreakerTripped: boolean;
  dryRun: boolean;
  approvedAt: Date | null;
  approvedBy: number | null;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  sendingLockToken: string | null;
  sendingLockAcquiredAt: Date | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Recipient {
  id: number;
  campaignId: number;
  contactId: number;
  personalizedSubject: string;
  personalizedBody: string;
  status: RecipientStatus;
  providerMessageId: string | null;
  providerMessageIdNormalized: string | null;
  attemptCount: number;
  lastError: string | null;
  failureClass: FailureClass;
  nextAttemptAt: Date | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  contactName: string | null;
  companyName: string | null;
  eligibilityStatus: EligibilityStatus;
}

export interface Suppression {
  id: number;
  emailNormalized: string;
  reason: SuppressionReason;
  source: string | null;
  notes: string | null;
  active: boolean;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailEvent {
  id: number;
  campaignRecipientId: number | null;
  providerMessageId: string | null;
  eventType: EmailEventType;
  eventKey: string;
  payload: Record<string, unknown> | null;
  occurredAt: Date | null;
  createdAt: Date;
}

export interface AuditEntry {
  id: number;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DashboardStats {
  totalContacts: number;
  eligibleContacts: number;
  duplicateContacts: number;
  invalidFormatAddresses: number;
  draftCampaigns: number;
  approvedCampaigns: number;
  sendingAttempts: number;
  simulatedResults: number;
  acceptedByProvider: number;
  confirmedDeliveries: number;
  bounces: number;
  complaints: number;
  suppressedContacts: number;
  unsubscribeRequests: number;
  neverContacted: number;
  previouslyContacted: number;
  failedSends: number;
}

export type SchedulerStatus = 'disabled' | 'enabled' | 'paused' | 'completed';

export type SchedulerRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type SchedulerTrigger = 'schedule' | 'manual';

export interface SchedulerSettings {
  status: SchedulerStatus;
  dailyLimit: number;
  executionTime: string;
  workingDays: number[];
  timezone: string;
  templateId: number | null;
  aiPersonalization: boolean;
  startDate: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  lastSuccessAt: Date | null;
  updatedBy: number | null;
}

export interface SchedulerRun {
  id: number;
  scheduledDate: string;
  batchNumber: number;
  campaignId: number | null;
  status: SchedulerRunStatus;
  trigger: SchedulerTrigger;
  selectedCount: number;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface SchedulerPools {
  eligible: number;
  remaining: number;
  contacted: number;
}

export interface SchedulerDayCounts {
  batches: number;
  recipients: number;
  simulated: number;
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
}

export interface OutreachHistoryItem {
  recipientId: number;
  campaignId: number;
  campaignName: string;
  subject: string;
  sentAt: Date | null;
  createdAt: Date;
  status: RecipientStatus;
  attemptCount: number;
  smtpAccepted: boolean;
  delivered: boolean;
  bounced: boolean;
  complained: boolean;
}

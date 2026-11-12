export type SendingMode = 'dry_run' | 'live';

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'operator';
}

export interface SystemStatus {
  sendingMode: SendingMode;
  dryRunReasons: string[];
  senderEmail: string;
  senderName: string;
  maxRecipientsPerCampaign: number;
  maxSendRate: number;
  maxBatchSize: number;
  maxAttempts: number;
  circuitBreakerThreshold: number;
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
  sendingMode: SendingMode;
  dryRunReasons: string[];
}

export interface Contact {
  id: number;
  email: string;
  contactName: string | null;
  companyName: string | null;
  designation: string | null;
  website: string | null;
  source: string | null;
  eligibilityStatus: 'eligible' | 'invalid_email' | 'suppressed';
  missingInfo: boolean;
  isContacted: boolean;
  lastContactedAt: string | null;
  contactCount: number;
  lastCampaignId: number | null;
  lastCampaignName: string | null;
}

export interface OutreachHistoryItem {
  recipientId: number;
  campaignId: number;
  campaignName: string;
  subject: string;
  sentAt: string | null;
  createdAt: string;
  status: string;
  attemptCount: number;
  smtpAccepted: boolean;
  delivered: boolean;
  bounced: boolean;
  complained: boolean;
}

export interface SchedulerSettings {
  status: 'disabled' | 'enabled' | 'paused' | 'completed';
  dailyLimit: number;
  executionTime: string;
  workingDays: number[];
  timezone: string;
  templateId: number | null;
  aiPersonalization: boolean;
  startDate: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
}

export interface SchedulerRun {
  id: number;
  scheduledDate: string;
  batchNumber: number;
  campaignId: number | null;
  status: string;
  trigger: string;
  selectedCount: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

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
  nextRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  history: SchedulerRun[];
  completionMessage: string | null;
  dueNow: boolean;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Template {
  id: number;
  name: string;
  style: string;
  subject: string;
  body: string;
  isDefault: boolean;
  aiGenerated: boolean;
}

export interface Campaign {
  id: number;
  name: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  status: string;
  totalRecipients: number;
  recipientLimit: number;
  sendRatePerSecond: number;
  batchSize: number;
  dryRun: boolean;
  circuitBreakerTripped: boolean;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  issues?: { total: number; suppressed: number; ineligible: number };
}

export interface Recipient {
  id: number;
  email: string;
  contactName: string | null;
  companyName: string | null;
  personalizedSubject: string;
  personalizedBody: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  failureClass: string;
  providerMessageId: string | null;
}

export interface Suppression {
  id: number;
  emailNormalized: string;
  reason: string;
  source: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

export interface ImportPreview {
  needsMapping: boolean;
  headers: string[];
  suggestedMapping: Record<string, string | undefined>;
  mapping: Record<string, string | undefined>;
  sampleRows: Record<string, string>[];
  previewId?: string;
  summary?: {
    totalRows: number;
    readyToInsert: number;
    invalidEmail: number;
    suppressed: number;
    duplicateInFile: number;
    duplicateInDatabase: number;
    missingEmail: number;
    missingName: number;
    missingCompany: number;
  };
  rows?: Array<{
    rowNumber: number;
    email: string;
    contactName: string;
    companyName: string;
    issues: string[];
    action: string;
  }>;
  sampleTruncated?: boolean;
}

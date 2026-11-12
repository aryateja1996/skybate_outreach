import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from '../config';
import { isValidEmail } from '../domain/email';
import { outreachBlockReason, strongerOutreachBlock } from '../domain/scheduler';
import { DuplicateEmailError, AppError } from '../errors';
import type {
  Campaign,
  CampaignStatus,
  Contact,
  DashboardStats,
  EligibilityStatus,
  EmailEvent,
  EmailEventType,
  FailureClass,
  ImportPreviewRecord,
  OutreachHistoryItem,
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

type Executor = Pool | PoolConnection;

const CAMPAIGN_STATUSES = new Set<CampaignStatus>([
  'draft',
  'previewed',
  'approved',
  'sending',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);

const RECIPIENT_STATUSES = new Set<RecipientStatus>([
  'pending',
  'sending',
  'retry_wait',
  'simulated',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
  'cancelled',
]);

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mustDate(value: unknown): Date {
  return asDate(value) ?? new Date(0);
}

function jsonValue<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

function mapUser(row: RowDataPacket): User {
  return {
    id: num(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    displayName: String(row.display_name),
    role: row.role as Role,
    createdAt: mustDate(row.created_at),
    updatedAt: mustDate(row.updated_at),
  };
}

function mapContact(row: RowDataPacket): Contact {
  return {
    id: num(row.id),
    email: String(row.email),
    emailNormalized: String(row.email_normalized),
    contactName: row.contact_name == null ? null : String(row.contact_name),
    companyName: row.company_name == null ? null : String(row.company_name),
    designation: row.designation == null ? null : String(row.designation),
    website: row.website == null ? null : String(row.website),
    source: row.source == null ? null : String(row.source),
    eligibilityStatus: row.eligibility_status as EligibilityStatus,
    missingInfo: bool(row.missing_info),
    isContacted: bool(row.is_contacted),
    lastContactedAt: asDate(row.last_contacted_at),
    contactCount: num(row.contact_count),
    lastCampaignId: row.last_campaign_id == null ? null : num(row.last_campaign_id),
    lastCampaignName: row.last_campaign_name == null ? null : String(row.last_campaign_name),
    createdAt: mustDate(row.created_at),
    updatedAt: mustDate(row.updated_at),
  };
}

function mapTemplate(row: RowDataPacket): Template {
  return {
    id: num(row.id),
    name: String(row.name),
    style: String(row.style),
    subject: String(row.subject),
    body: String(row.body),
    isDefault: bool(row.is_default),
    aiGenerated: bool(row.ai_generated),
    createdBy: row.created_by == null ? null : num(row.created_by),
    createdAt: mustDate(row.created_at),
    updatedAt: mustDate(row.updated_at),
  };
}

function mapCampaign(row: RowDataPacket): Campaign {
  return {
    id: num(row.id),
    name: String(row.name),
    templateId: row.template_id == null ? null : num(row.template_id),
    subject: String(row.subject),
    body: String(row.body),
    senderName: String(row.sender_name),
    senderEmail: String(row.sender_email),
    status: row.status as CampaignStatus,
    totalRecipients: num(row.total_recipients),
    recipientLimit: num(row.recipient_limit),
    sendRatePerSecond: num(row.send_rate_per_second),
    batchSize: num(row.batch_size),
    maxAttempts: num(row.max_attempts),
    circuitBreakerThreshold: num(row.circuit_breaker_threshold),
    consecutiveFailures: num(row.consecutive_failures),
    circuitBreakerTripped: bool(row.circuit_breaker_tripped),
    dryRun: bool(row.dry_run),
    approvedAt: asDate(row.approved_at),
    approvedBy: row.approved_by == null ? null : num(row.approved_by),
    startedAt: asDate(row.started_at),
    pausedAt: asDate(row.paused_at),
    completedAt: asDate(row.completed_at),
    cancelledAt: asDate(row.cancelled_at),
    sendingLockToken: row.sending_lock_token == null ? null : String(row.sending_lock_token),
    sendingLockAcquiredAt: asDate(row.sending_lock_acquired_at),
    createdBy: row.created_by == null ? null : num(row.created_by),
    createdAt: mustDate(row.created_at),
    updatedAt: mustDate(row.updated_at),
  };
}

function mapRecipient(row: RowDataPacket): Recipient {
  return {
    id: num(row.id),
    campaignId: num(row.campaign_id),
    contactId: num(row.contact_id),
    personalizedSubject: String(row.personalized_subject),
    personalizedBody: String(row.personalized_body),
    status: row.status as RecipientStatus,
    providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
    providerMessageIdNormalized:
      row.provider_message_id_normalized == null ? null : String(row.provider_message_id_normalized),
    attemptCount: num(row.attempt_count),
    lastError: row.last_error == null ? null : String(row.last_error),
    failureClass: (row.failure_class as FailureClass) ?? 'none',
    nextAttemptAt: asDate(row.next_attempt_at),
    lockedAt: asDate(row.locked_at),
    lockedBy: row.locked_by == null ? null : String(row.locked_by),
    sentAt: asDate(row.sent_at),
    createdAt: mustDate(row.created_at),
    updatedAt: mustDate(row.updated_at),
    email: String(row.email ?? ''),
    contactName: row.contact_name == null ? null : String(row.contact_name),
    companyName: row.company_name == null ? null : String(row.company_name),
    eligibilityStatus: (row.eligibility_status as EligibilityStatus) ?? 'invalid_email',
  };
}

function mapSuppression(row: RowDataPacket): Suppression {
  return {
    id: num(row.id),
    emailNormalized: String(row.email_normalized),
    reason: row.reason as SuppressionReason,
    source: row.source == null ? null : String(row.source),
    notes: row.notes == null ? null : String(row.notes),
    active: bool(row.active),
    createdBy: row.created_by == null ? null : num(row.created_by),
    createdAt: mustDate(row.created_at),
    updatedAt: mustDate(row.updated_at),
  };
}

function mapEvent(row: RowDataPacket): EmailEvent {
  return {
    id: num(row.id),
    campaignRecipientId: row.campaign_recipient_id == null ? null : num(row.campaign_recipient_id),
    providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
    eventType: row.event_type as EmailEventType,
    eventKey: String(row.event_key),
    payload: jsonValue<Record<string, unknown>>(row.payload_json),
    occurredAt: asDate(row.occurred_at),
    createdAt: mustDate(row.created_at),
  };
}

function isDuplicate(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ER_DUP_ENTRY');
}

export class MysqlStore implements Store {
  constructor(
    private readonly pool: Pool,
    private readonly connection: Executor,
    private readonly inTransaction: boolean,
  ) {}

  private async query<T extends RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
    const [rows] = await this.connection.query<T>(sql, params);
    return rows;
  }

  private async execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
    const [result] = await this.connection.query<ResultSetHeader>(sql, params);
    return result;
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1 AS ok');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withTransaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const tx = new MysqlStore(this.pool, connection, true);
      const result = await fn(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async countUsers(): Promise<number> {
    const rows = await this.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM users');
    return num(rows[0]?.total);
  }

  async createUser(input: NewUser): Promise<User> {
    try {
      const result = await this.execute(
        `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)`,
        [input.email, input.passwordHash, input.displayName, input.role],
      );
      const user = await this.findUserById(num(result.insertId));
      if (!user) throw new AppError(500, 'User could not be loaded after insert.', 'USER_CREATE_FAILED');
      return user;
    } catch (error) {
      if (isDuplicate(error)) throw new AppError(409, 'A user with this email already exists.', 'DUPLICATE_USER');
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findUserById(id: number): Promise<User | null> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async createSession(input: { id: string; userId: number; csrfToken: string; expiresAt: Date }): Promise<void> {
    await this.execute(
      `INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)`,
      [input.id, input.userId, input.csrfToken, input.expiresAt],
    );
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM sessions WHERE id = ? LIMIT 1', [id]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      userId: num(row.user_id),
      csrfToken: String(row.csrf_token),
      expiresAt: mustDate(row.expires_at),
      createdAt: mustDate(row.created_at),
    };
  }

  async deleteSession(id: string): Promise<void> {
    await this.execute('DELETE FROM sessions WHERE id = ?', [id]);
  }

  private contactWhere(query: Omit<ContactQuery, 'page' | 'pageSize'>): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.eligibility) {
      where.push('c.eligibility_status = ?');
      params.push(query.eligibility);
    }
    if (query.missingInfo === true) where.push('c.missing_info = 1');
    if (query.missingInfo === false) where.push('c.missing_info = 0');
    if (query.outreach === 'never') where.push("c.is_contacted = 0 AND c.eligibility_status = 'eligible'");
    if (query.outreach === 'contacted') where.push("c.is_contacted = 1 AND c.eligibility_status <> 'suppressed'");
    if (query.outreach === 'suppressed') where.push("c.eligibility_status = 'suppressed'");
    if (query.outreach === 'invalid') where.push("c.eligibility_status = 'invalid_email'");
    if (query.blockMode) {
      const excludeSimulated = query.blockMode === 'dry_run' ? 1 : 0;
      where.push(`NOT EXISTS (
        SELECT 1 FROM campaign_recipients r
        INNER JOIN campaigns camp ON camp.id = r.campaign_id
        WHERE r.contact_id = c.id
          AND (
            r.status IN ('pending', 'sending', 'retry_wait', 'accepted', 'delivered', 'bounced', 'complained')
            OR (? = 1 AND r.status = 'simulated')
            OR (r.failure_class = 'ambiguous' AND (? = 1 OR camp.dry_run = 0))
          )
      )`);
      params.push(excludeSimulated, excludeSimulated);
    }
    if (query.search) {
      where.push(
        `(c.email_normalized LIKE ? ESCAPE '\\\\' OR c.contact_name LIKE ? ESCAPE '\\\\' OR c.company_name LIKE ? ESCAPE '\\\\' OR c.designation LIKE ? ESCAPE '\\\\')`,
      );
      const term = likeContains(query.search);
      params.push(term, term, term, term);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  async listContacts(query: ContactQuery) {
    const filter = this.contactWhere(query);
    const totalRows = await this.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM contacts c ${filter.sql}`,
      filter.params,
    );
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.query<RowDataPacket[]>(
      `${this.contactSelect()} ${filter.sql} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...filter.params, query.pageSize, offset],
    );
    return { rows: rows.map(mapContact), total: num(totalRows[0]?.total), page: query.page, pageSize: query.pageSize };
  }

  async listAllContacts(query: Omit<ContactQuery, 'page' | 'pageSize'> & { limit: number }): Promise<Contact[]> {
    const filter = this.contactWhere(query);
    const rows = await this.query<RowDataPacket[]>(
      `${this.contactSelect()} ${filter.sql} ORDER BY c.id DESC LIMIT ?`,
      [...filter.params, query.limit],
    );
    return rows.map(mapContact);
  }

  async findContactById(id: number): Promise<Contact | null> {
    const rows = await this.query<RowDataPacket[]>(`${this.contactSelect()} WHERE c.id = ? LIMIT 1`, [id]);
    return rows[0] ? mapContact(rows[0]) : null;
  }

  async findContactsByIds(ids: number[]): Promise<Contact[]> {
    if (ids.length === 0) return [];
    const rows = await this.query<RowDataPacket[]>(
      `${this.contactSelect()} WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    return rows.map(mapContact);
  }

  private contactSelect(): string {
    return `SELECT c.*, camp.name AS last_campaign_name
            FROM contacts c
            LEFT JOIN campaigns camp ON camp.id = c.last_campaign_id`;
  }

  async lockContacts(ids: number[]): Promise<Contact[]> {
    if (ids.length === 0) return [];
    const rows = await this.query<RowDataPacket[]>(
      `SELECT * FROM contacts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
      ids,
    );
    return rows.map(mapContact);
  }

  async contactsBlockedForOutreach(ids: number[], mode: 'dry_run' | 'live', exceptCampaignId?: number): Promise<OutreachBlock[]> {
    if (ids.length === 0) return [];
    const rows = await this.query<RowDataPacket[]>(
      `SELECT r.contact_id, r.campaign_id, r.status, r.failure_class, camp.dry_run
       FROM campaign_recipients r
       INNER JOIN campaigns camp ON camp.id = r.campaign_id
       WHERE r.contact_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const best = new Map<number, OutreachBlock['reason']>();
    for (const row of rows) {
      const campaignId = num(row.campaign_id);
      if (exceptCampaignId && campaignId === exceptCampaignId) continue;
      const reason = outreachBlockReason({
        status: String(row.status) as RecipientStatus,
        failureClass: (row.failure_class as FailureClass) ?? 'none',
        campaignDryRun: bool(row.dry_run),
        mode,
      });
      if (!reason) continue;
      const contactId = num(row.contact_id);
      best.set(contactId, strongerOutreachBlock(best.get(contactId) ?? null, reason));
    }
    return [...best].map(([contactId, reason]) => ({ contactId, reason }));
  }

  async contactsWithOpenOutreach(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await this.query<RowDataPacket[]>(
      `SELECT DISTINCT contact_id
       FROM campaign_recipients
       WHERE contact_id IN (${ids.map(() => '?').join(',')})
         AND status IN ('pending', 'sending', 'retry_wait')`,
      ids,
    );
    return rows.map((row) => num(row.contact_id));
  }

  async contactAcceptedByOtherCampaign(input: { contactId: number; recipientId: number; queuedAt: Date }): Promise<boolean> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT id
       FROM campaign_recipients
       WHERE contact_id = ?
         AND id <> ?
         AND status IN ('accepted', 'delivered', 'bounced', 'complained')
         AND sent_at IS NOT NULL
         AND sent_at >= ?
       LIMIT 1`,
      [input.contactId, input.recipientId, input.queuedAt],
    );
    return rows.length > 0;
  }

  async recordAcceptedOutreach(input: { contactId: number; campaignId: number; sentAt: Date }): Promise<void> {
    await this.execute(
      `UPDATE contacts
       SET is_contacted = 1,
           contact_count = contact_count + 1,
           last_contacted_at = ?,
           last_campaign_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [input.sentAt, input.campaignId, input.contactId],
    );
  }

  async listOutreachHistory(contactId: number): Promise<OutreachHistoryItem[]> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT r.id, r.campaign_id, camp.name AS campaign_name, r.personalized_subject, r.sent_at,
              r.created_at, r.status, r.attempt_count
       FROM campaign_recipients r
       JOIN campaigns camp ON camp.id = r.campaign_id
       WHERE r.contact_id = ?
       ORDER BY COALESCE(r.sent_at, r.created_at) DESC, r.id DESC`,
      [contactId],
    );
    return rows.map((row) => {
      const status = String(row.status) as Recipient['status'];
      return {
        recipientId: num(row.id),
        campaignId: num(row.campaign_id),
        campaignName: String(row.campaign_name),
        subject: String(row.personalized_subject),
        sentAt: asDate(row.sent_at),
        createdAt: mustDate(row.created_at),
        status,
        attemptCount: num(row.attempt_count),
        smtpAccepted: status === 'accepted' || status === 'delivered' || status === 'bounced' || status === 'complained',
        delivered: status === 'delivered',
        bounced: status === 'bounced',
        complained: status === 'complained',
      };
    });
  }

  async findContactsByNormalizedEmails(emails: string[]): Promise<Contact[]> {
    if (emails.length === 0) return [];
    const rows = await this.query<RowDataPacket[]>(
      `${this.contactSelect()} WHERE c.email_normalized IN (${emails.map(() => '?').join(',')})`,
      emails,
    );
    return rows.map(mapContact);
  }

  async insertContacts(rows: NewContact[]): Promise<Contact[]> {
    if (rows.length === 0) return [];
    const inserted: Contact[] = [];
    try {
      for (const group of chunks(rows, 200)) {
        const result = await this.execute(
          `INSERT INTO contacts
            (email, email_normalized, contact_name, company_name, designation, website, source, eligibility_status, missing_info)
           VALUES ?`,
          [
            group.map((row) => [
              row.email,
              row.emailNormalized,
              row.contactName,
              row.companyName,
              row.designation,
              row.website,
              row.source,
              row.eligibilityStatus,
              row.missingInfo ? 1 : 0,
            ]),
          ],
        );
        const firstId = num(result.insertId);
        group.forEach((row, index) => {
          const now = new Date();
          inserted.push({
            id: firstId + index,
            ...row,
            isContacted: false,
            lastContactedAt: null,
            contactCount: 0,
            lastCampaignId: null,
            lastCampaignName: null,
            createdAt: now,
            updatedAt: now,
          });
        });
      }
      return inserted;
    } catch (error) {
      if (isDuplicate(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  async updateContact(id: number, patch: ContactPatch): Promise<Contact> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const pairs: Array<[keyof ContactPatch, string, unknown]> = [
      ['email', 'email', patch.email],
      ['emailNormalized', 'email_normalized', patch.emailNormalized],
      ['contactName', 'contact_name', patch.contactName],
      ['companyName', 'company_name', patch.companyName],
      ['designation', 'designation', patch.designation],
      ['website', 'website', patch.website],
      ['source', 'source', patch.source],
      ['eligibilityStatus', 'eligibility_status', patch.eligibilityStatus],
      ['missingInfo', 'missing_info', patch.missingInfo === undefined ? undefined : patch.missingInfo ? 1 : 0],
    ];
    for (const [, column, value] of pairs) {
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      params.push(value);
    }
    if (assignments.length) {
      try {
        const result = await this.execute(
          `UPDATE contacts SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [...params, id],
        );
        if (result.affectedRows === 0 && !(await this.findContactById(id))) {
          throw new AppError(404, 'Contact not found.', 'NOT_FOUND');
        }
      } catch (error) {
        if (isDuplicate(error)) throw new DuplicateEmailError();
        throw error;
      }
    }
    const contact = await this.findContactById(id);
    if (!contact) throw new AppError(404, 'Contact not found.', 'NOT_FOUND');
    return contact;
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const contacts = await this.query<RowDataPacket[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(eligibility_status = 'eligible') AS eligible,
         SUM(eligibility_status = 'invalid_email') AS invalid_emails,
         SUM(eligibility_status = 'suppressed') AS suppressed,
         SUM(is_contacted = 0 AND eligibility_status = 'eligible') AS never_contacted,
         SUM(is_contacted = 1 AND eligibility_status <> 'suppressed') AS previously_contacted
       FROM contacts`,
    );
    const duplicates = await this.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(duplicate_count), 0) AS duplicates FROM import_batches`,
    );
    const campaigns = await this.query<RowDataPacket[]>(
      `SELECT
         SUM(status IN ('draft', 'previewed')) AS drafts,
         SUM(status = 'approved') AS approved
       FROM campaigns`,
    );
    const recipients = await this.query<RowDataPacket[]>(
      `SELECT
         COALESCE(SUM(attempt_count), 0) AS attempts,
         SUM(status = 'simulated') AS simulated,
         SUM(status IN ('accepted', 'delivered', 'bounced', 'complained')) AS accepted,
         SUM(status = 'delivered') AS delivered,
         SUM(status = 'bounced') AS bounces,
         SUM(status = 'complained') AS complaints,
         SUM(status = 'failed') AS failed
       FROM campaign_recipients`,
    );
    const unsubscribes = await this.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM suppression_list WHERE active = 1 AND reason = 'unsubscribe'`,
    );
    return {
      totalContacts: num(contacts[0]?.total),
      eligibleContacts: num(contacts[0]?.eligible),
      duplicateContacts: num(duplicates[0]?.duplicates),
      invalidFormatAddresses: num(contacts[0]?.invalid_emails),
      draftCampaigns: num(campaigns[0]?.drafts),
      approvedCampaigns: num(campaigns[0]?.approved),
      sendingAttempts: num(recipients[0]?.attempts),
      simulatedResults: num(recipients[0]?.simulated),
      acceptedByProvider: num(recipients[0]?.accepted),
      confirmedDeliveries: num(recipients[0]?.delivered),
      bounces: num(recipients[0]?.bounces),
      complaints: num(recipients[0]?.complaints),
      suppressedContacts: num(contacts[0]?.suppressed),
      unsubscribeRequests: num(unsubscribes[0]?.total),
      neverContacted: num(contacts[0]?.never_contacted),
      previouslyContacted: num(contacts[0]?.previously_contacted),
      failedSends: num(recipients[0]?.failed),
    };
  }

  async saveImportPreview(preview: ImportPreviewRecord): Promise<void> {
    await this.execute(
      `INSERT INTO import_previews (id, user_id, filename, rows_json, summary_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         filename = VALUES(filename),
         rows_json = VALUES(rows_json),
         summary_json = VALUES(summary_json),
         expires_at = VALUES(expires_at)`,
      [preview.id, preview.userId, preview.filename, JSON.stringify(preview.rows), JSON.stringify(preview.summary), preview.expiresAt],
    );
  }

  async getImportPreview(id: string): Promise<ImportPreviewRecord | null> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM import_previews WHERE id = ? LIMIT 1', [id]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      userId: num(row.user_id),
      filename: String(row.filename),
      rows: jsonValue(row.rows_json) ?? [],
      summary: jsonValue(row.summary_json) ?? {
        totalRows: 0,
        readyToInsert: 0,
        invalidEmail: 0,
        suppressed: 0,
        duplicateInFile: 0,
        duplicateInDatabase: 0,
        missingEmail: 0,
        missingName: 0,
        missingCompany: 0,
        missingDesignation: 0,
        missingWebsite: 0,
      },
      expiresAt: mustDate(row.expires_at),
      createdAt: mustDate(row.created_at),
    };
  }

  async deleteImportPreview(id: string): Promise<void> {
    await this.execute('DELETE FROM import_previews WHERE id = ?', [id]);
  }

  async createImportBatch(batch: NewImportBatch): Promise<void> {
    await this.execute(
      `INSERT INTO import_batches
        (filename, total_rows, inserted_count, duplicate_count, invalid_count, missing_email_count, missing_info_count, suppressed_count, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        batch.filename,
        batch.totalRows,
        batch.insertedCount,
        batch.duplicateCount,
        batch.invalidCount,
        batch.missingEmailCount,
        batch.missingInfoCount,
        batch.suppressedCount,
        batch.createdBy,
      ],
    );
  }

  async listTemplates(): Promise<Template[]> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM email_templates ORDER BY id DESC');
    return rows.map(mapTemplate);
  }

  async findTemplate(id: number): Promise<Template | null> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM email_templates WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapTemplate(rows[0]) : null;
  }

  async createTemplate(input: NewTemplate): Promise<Template> {
    const result = await this.execute(
      `INSERT INTO email_templates (name, style, subject, body, is_default, ai_generated, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.name, input.style, input.subject, input.body, input.isDefault ? 1 : 0, input.aiGenerated ? 1 : 0, input.createdBy],
    );
    const template = await this.findTemplate(num(result.insertId));
    if (!template) throw new AppError(500, 'Template could not be loaded after insert.', 'TEMPLATE_CREATE_FAILED');
    return template;
  }

  async updateTemplate(id: number, patch: TemplatePatch): Promise<Template> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      assignments.push('name = ?');
      params.push(patch.name);
    }
    if (patch.style !== undefined) {
      assignments.push('style = ?');
      params.push(patch.style);
    }
    if (patch.subject !== undefined) {
      assignments.push('subject = ?');
      params.push(patch.subject);
    }
    if (patch.body !== undefined) {
      assignments.push('body = ?');
      params.push(patch.body);
    }
    if (assignments.length) {
      const result = await this.execute(
        `UPDATE email_templates SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...params, id],
      );
      if (result.affectedRows === 0 && !(await this.findTemplate(id))) {
        throw new AppError(404, 'Template not found.', 'NOT_FOUND');
      }
    }
    const template = await this.findTemplate(id);
    if (!template) throw new AppError(404, 'Template not found.', 'NOT_FOUND');
    return template;
  }

  async logAiGeneration(entry: {
    status: 'success' | 'fallback' | 'error';
    model: string | null;
    errorCode: string | null;
    createdBy: number | null;
  }): Promise<void> {
    await this.execute(
      `INSERT INTO ai_generation_logs (status, model, error_code, created_by) VALUES (?, ?, ?, ?)`,
      [entry.status, entry.model, entry.errorCode, entry.createdBy],
    );
  }

  async createCampaign(input: NewCampaign): Promise<Campaign> {
    const result = await this.execute(
      `INSERT INTO campaigns
        (name, template_id, subject, body, sender_name, sender_email, status, recipient_limit, send_rate_per_second, batch_size, max_attempts, circuit_breaker_threshold, created_by, dry_run)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 1)`,
      [
        input.name,
        input.templateId,
        input.subject,
        input.body,
        input.senderName,
        input.senderEmail,
        input.recipientLimit,
        input.sendRatePerSecond,
        input.batchSize,
        input.maxAttempts,
        input.circuitBreakerThreshold,
        input.createdBy,
      ],
    );
    const campaign = await this.findCampaign(num(result.insertId));
    if (!campaign) throw new AppError(500, 'Campaign could not be loaded after insert.', 'CAMPAIGN_CREATE_FAILED');
    return campaign;
  }

  async updateCampaign(id: number, patch: CampaignPatch): Promise<Campaign> {
    const entries: Array<[string, unknown]> = [
      ['name', patch.name],
      ['template_id', patch.templateId],
      ['subject', patch.subject],
      ['body', patch.body],
      ['sender_name', patch.senderName],
      ['status', patch.status],
      ['total_recipients', patch.totalRecipients],
      ['recipient_limit', patch.recipientLimit],
      ['send_rate_per_second', patch.sendRatePerSecond],
      ['batch_size', patch.batchSize],
      ['consecutive_failures', patch.consecutiveFailures],
      ['circuit_breaker_tripped', patch.circuitBreakerTripped === undefined ? undefined : patch.circuitBreakerTripped ? 1 : 0],
      ['dry_run', patch.dryRun === undefined ? undefined : patch.dryRun ? 1 : 0],
      ['approved_at', patch.approvedAt],
      ['approved_by', patch.approvedBy],
      ['started_at', patch.startedAt],
      ['paused_at', patch.pausedAt],
      ['completed_at', patch.completedAt],
      ['cancelled_at', patch.cancelledAt],
      ['sending_lock_token', patch.sendingLockToken],
      ['sending_lock_acquired_at', patch.sendingLockAcquiredAt],
    ];
    const usable = entries.filter((entry) => entry[1] !== undefined);
    if (usable.length) {
      const result = await this.execute(
        `UPDATE campaigns SET ${usable.map(([column]) => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...usable.map(([, value]) => value), id],
      );
      if (result.affectedRows === 0 && !(await this.findCampaign(id))) {
        throw new AppError(404, 'Campaign not found.', 'NOT_FOUND');
      }
    }
    const campaign = await this.findCampaign(id);
    if (!campaign) throw new AppError(404, 'Campaign not found.', 'NOT_FOUND');
    return campaign;
  }

  async findCampaign(id: number): Promise<Campaign | null> {
    const rows = await this.query<RowDataPacket[]>('SELECT * FROM campaigns WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapCampaign(rows[0]) : null;
  }

  async listCampaigns(query: PageQuery) {
    if (query.status && !CAMPAIGN_STATUSES.has(query.status as CampaignStatus)) {
      throw new AppError(400, 'Unknown campaign status filter.', 'VALIDATION_ERROR');
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.search) {
      where.push(`name LIKE ? ESCAPE '\\\\'`);
      params.push(likeContains(query.search));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRows = await this.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM campaigns ${clause}`, params);
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.query<RowDataPacket[]>(
      `SELECT * FROM campaigns ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, query.pageSize, offset],
    );
    return { rows: rows.map(mapCampaign), total: num(totalRows[0]?.total), page: query.page, pageSize: query.pageSize };
  }

  async replaceRecipients(campaignId: number, rows: NewRecipient[]): Promise<void> {
    if (!this.inTransaction) {
      await this.withTransaction((tx) => tx.replaceRecipients(campaignId, rows));
      return;
    }
    await this.execute('DELETE FROM campaign_recipients WHERE campaign_id = ?', [campaignId]);
    for (const group of chunks(rows, 200)) {
      if (group.length === 0) continue;
      await this.execute(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, personalized_subject, personalized_body, status)
         VALUES ?`,
        [group.map((row) => [campaignId, row.contactId, row.personalizedSubject, row.personalizedBody, 'pending'])],
      );
    }
  }

  private recipientSelect(): string {
    return `SELECT r.*, c.email, c.contact_name, c.company_name, c.eligibility_status
            FROM campaign_recipients r
            JOIN contacts c ON c.id = r.contact_id`;
  }

  async listRecipients(campaignId: number, query: PageQuery) {
    if (query.status && !RECIPIENT_STATUSES.has(query.status as RecipientStatus)) {
      throw new AppError(400, 'Unknown recipient status filter.', 'VALIDATION_ERROR');
    }
    const where = ['r.campaign_id = ?'];
    const params: unknown[] = [campaignId];
    if (query.status) {
      where.push('r.status = ?');
      params.push(query.status);
    }
    if (query.search) {
      where.push(`(c.email_normalized LIKE ? ESCAPE '\\\\' OR c.contact_name LIKE ? ESCAPE '\\\\' OR c.company_name LIKE ? ESCAPE '\\\\')`);
      const term = likeContains(query.search);
      params.push(term, term, term);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const totalRows = await this.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id ${clause}`,
      params,
    );
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.query<RowDataPacket[]>(
      `${this.recipientSelect()} ${clause} ORDER BY r.id ASC LIMIT ? OFFSET ?`,
      [...params, query.pageSize, offset],
    );
    return { rows: rows.map(mapRecipient), total: num(totalRows[0]?.total), page: query.page, pageSize: query.pageSize };
  }

  async recipientIssueCounts(campaignId: number): Promise<RecipientIssueCounts> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(
           c.eligibility_status = 'suppressed'
           OR EXISTS (
             SELECT 1 FROM suppression_list s
             WHERE s.email_normalized = c.email_normalized AND s.active = 1
           )
         ) AS suppressed,
         SUM(
           c.eligibility_status <> 'eligible'
           AND c.eligibility_status <> 'suppressed'
           AND NOT EXISTS (
             SELECT 1 FROM suppression_list s
             WHERE s.email_normalized = c.email_normalized AND s.active = 1
           )
         ) AS ineligible
       FROM campaign_recipients r
       JOIN contacts c ON c.id = r.contact_id
       WHERE r.campaign_id = ?`,
      [campaignId],
    );
    return {
      total: num(rows[0]?.total),
      suppressed: num(rows[0]?.suppressed),
      ineligible: num(rows[0]?.ineligible),
    };
  }

  async recoverInterruptedCampaigns(): Promise<number[]> {
    return this.withTransaction(async (tx) => {
      const store = tx as MysqlStore;
      const rows = await store.query<RowDataPacket[]>(
        `SELECT id FROM campaigns WHERE status = 'sending' FOR UPDATE`,
      );
      const ids = rows.map((row) => num(row.id));
      if (ids.length === 0) return [];
      await store.execute(
        `UPDATE campaign_recipients
         SET status = 'failed',
             failure_class = 'ambiguous',
             last_error = 'Sending interrupted before the outcome was recorded. It was not retried automatically.',
             locked_at = NULL,
             locked_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE status = 'sending' AND campaign_id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      await store.execute(
        `UPDATE campaigns
         SET status = 'paused',
             paused_at = CURRENT_TIMESTAMP,
             sending_lock_token = NULL,
             sending_lock_acquired_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      return ids;
    });
  }

  async claimCampaignLock(campaignId: number, token: string, staleSeconds: number): Promise<boolean> {
    const result = await this.execute(
      `UPDATE campaigns
       SET sending_lock_token = ?, sending_lock_acquired_at = UTC_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = 'sending'
         AND (
           sending_lock_token IS NULL
           OR sending_lock_acquired_at IS NULL
           OR sending_lock_acquired_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
         )`,
      [token, campaignId, staleSeconds],
    );
    return result.affectedRows === 1;
  }

  async releaseCampaignLock(campaignId: number, token: string): Promise<void> {
    await this.execute(
      `UPDATE campaigns
       SET sending_lock_token = NULL, sending_lock_acquired_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND sending_lock_token = ?`,
      [campaignId, token],
    );
  }

  async claimRecipientBatch(campaignId: number, limit: number, worker: string): Promise<Recipient[]> {
    if (!this.inTransaction) return this.withTransaction((tx) => tx.claimRecipientBatch(campaignId, limit, worker));
    const rows = await this.query<RowDataPacket[]>(
      `SELECT id FROM campaign_recipients
       WHERE campaign_id = ?
         AND status IN ('pending', 'retry_wait')
         AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
         AND (locked_at IS NULL OR locked_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))
       ORDER BY id
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [campaignId, limit],
    );
    const ids = rows.map((row) => num(row.id));
    if (ids.length === 0) return [];
    await this.execute(
      `UPDATE campaign_recipients
       SET status = 'sending', locked_at = UTC_TIMESTAMP(), locked_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      [worker, ...ids],
    );
    const selected = await this.query<RowDataPacket[]>(
      `${this.recipientSelect()} WHERE r.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`,
      ids,
    );
    return selected.map(mapRecipient);
  }

  async updateRecipientFromEvent(id: number, status: RecipientStatus): Promise<void> {
    await this.execute(
      `UPDATE campaign_recipients SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, id],
    );
  }

  async completeRecipient(id: number, result: RecipientCompletion): Promise<boolean> {
    const assignments = ['status = ?', 'last_error = ?', 'failure_class = ?', 'locked_at = NULL', 'locked_by = NULL', 'next_attempt_at = NULL'];
    const params: unknown[] = [result.status, result.lastError ?? null, result.failureClass ?? 'none'];
    if (result.providerMessageId !== undefined) {
      assignments.push('provider_message_id = ?');
      params.push(result.providerMessageId);
    }
    if (result.providerMessageIdNormalized !== undefined) {
      assignments.push('provider_message_id_normalized = ?');
      params.push(result.providerMessageIdNormalized);
    }
    if (result.sentAt !== undefined) {
      assignments.push('sent_at = ?');
      params.push(result.sentAt);
    }
    if (result.personalizedBody) {
      assignments.push('personalized_body = ?');
      params.push(result.personalizedBody);
    }
    if (result.incrementAttempt) assignments.push('attempt_count = attempt_count + 1');
    const updated = await this.execute(
      `UPDATE campaign_recipients SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'`,
      [...params, id],
    );
    return updated.affectedRows === 1;
  }

  async rescheduleRecipient(
    id: number,
    input: { lastError: string; nextAttemptAt: Date; incrementAttempt: boolean },
  ): Promise<boolean> {
    const updated = await this.execute(
      `UPDATE campaign_recipients
       SET status = 'retry_wait',
           last_error = ?,
           failure_class = 'transient',
           next_attempt_at = ?,
           attempt_count = attempt_count + ?,
           locked_at = NULL,
           locked_by = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'sending'`,
      [input.lastError, input.nextAttemptAt, input.incrementAttempt ? 1 : 0, id],
    );
    return updated.affectedRows === 1;
  }

  async releaseRecipientToStatus(id: number, status: RecipientStatus): Promise<void> {
    await this.execute(
      `UPDATE campaign_recipients
       SET status = ?, locked_at = NULL, locked_by = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'sending'`,
      [status, id],
    );
  }

  async cancelOpenRecipients(campaignId: number): Promise<number> {
    const result = await this.execute(
      `UPDATE campaign_recipients
       SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = ? AND status IN ('pending', 'retry_wait', 'sending')`,
      [campaignId],
    );
    return result.affectedRows;
  }

  async listSendableCampaigns(): Promise<Campaign[]> {
    const rows = await this.query<RowDataPacket[]>(`SELECT * FROM campaigns WHERE status = 'sending' ORDER BY id`);
    return rows.map(mapCampaign);
  }

  async markCampaignCompletedIfDone(campaignId: number): Promise<boolean> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(status IN ('simulated','accepted','delivered','bounced','complained','failed','suppressed','cancelled')) AS terminal
       FROM campaign_recipients
       WHERE campaign_id = ?`,
      [campaignId],
    );
    const total = num(rows[0]?.total);
    const terminal = num(rows[0]?.terminal);
    if (total === 0 || total !== terminal) return false;
    const result = await this.execute(
      `UPDATE campaigns
       SET status = 'completed',
           completed_at = CURRENT_TIMESTAMP,
           sending_lock_token = NULL,
           sending_lock_acquired_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'sending'`,
      [campaignId],
    );
    return result.affectedRows === 1;
  }

  async recordCircuitFailure(campaignId: number, threshold: number): Promise<boolean> {
    await this.execute(
      `UPDATE campaigns SET consecutive_failures = consecutive_failures + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [campaignId],
    );
    const result = await this.execute(
      `UPDATE campaigns
       SET status = 'paused',
           paused_at = CURRENT_TIMESTAMP,
           circuit_breaker_tripped = 1,
           sending_lock_token = NULL,
           sending_lock_acquired_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'sending' AND consecutive_failures >= ?`,
      [campaignId, threshold],
    );
    return result.affectedRows === 1;
  }

  async resetCircuitFailures(campaignId: number): Promise<void> {
    await this.execute(
      `UPDATE campaigns
       SET consecutive_failures = 0, circuit_breaker_tripped = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [campaignId],
    );
  }

  async findActiveSuppression(emailNormalized: string): Promise<Suppression | null> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT * FROM suppression_list WHERE email_normalized = ? AND active = 1 LIMIT 1`,
      [emailNormalized],
    );
    return rows[0] ? mapSuppression(rows[0]) : null;
  }

  async findActiveSuppressions(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows = await this.query<RowDataPacket[]>(
      `SELECT email_normalized FROM suppression_list
       WHERE active = 1 AND email_normalized IN (${emails.map(() => '?').join(',')})`,
      emails,
    );
    return new Set(rows.map((row) => String(row.email_normalized)));
  }

  async listSuppressions(query: PageQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      where.push(`email_normalized LIKE ? ESCAPE '\\\\'`);
      params.push(likeContains(query.search));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRows = await this.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM suppression_list ${clause}`,
      params,
    );
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.query<RowDataPacket[]>(
      `SELECT * FROM suppression_list ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, query.pageSize, offset],
    );
    return {
      rows: rows.map(mapSuppression),
      total: num(totalRows[0]?.total),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async upsertSuppression(input: NewSuppression): Promise<Suppression> {
    await this.execute(
      `INSERT INTO suppression_list (email_normalized, reason, source, notes, active, created_by)
       VALUES (?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         reason = VALUES(reason),
         source = VALUES(source),
         notes = COALESCE(VALUES(notes), notes),
         active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [input.emailNormalized, input.reason, input.source, input.notes, input.createdBy],
    );
    const rows = await this.query<RowDataPacket[]>(
      `SELECT * FROM suppression_list WHERE email_normalized = ? LIMIT 1`,
      [input.emailNormalized],
    );
    if (!rows[0]) throw new AppError(500, 'Suppression record could not be loaded.', 'SUPPRESSION_FAILED');
    return mapSuppression(rows[0]);
  }

  async liftSuppression(id: number): Promise<Suppression | null> {
    const result = await this.execute(
      `UPDATE suppression_list SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1`,
      [id],
    );
    if (result.affectedRows === 0) return null;
    const rows = await this.query<RowDataPacket[]>(`SELECT * FROM suppression_list WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ? mapSuppression(rows[0]) : null;
  }

  async markContactsSuppressed(emailNormalized: string): Promise<void> {
    await this.execute(
      `UPDATE contacts SET eligibility_status = 'suppressed', updated_at = CURRENT_TIMESTAMP WHERE email_normalized = ?`,
      [emailNormalized],
    );
  }

  async restoreContactEligibility(emailNormalized: string): Promise<void> {
    const status = isValidEmail(emailNormalized) ? 'eligible' : 'invalid_email';
    await this.execute(
      `UPDATE contacts
       SET eligibility_status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE email_normalized = ? AND eligibility_status = 'suppressed'`,
      [status, emailNormalized],
    );
  }

  async insertEmailEvent(event: NewEmailEvent): Promise<{ inserted: boolean; id: number }> {
    try {
      const result = await this.execute(
        `INSERT INTO email_events
          (campaign_recipient_id, provider_message_id, event_type, event_key, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          event.campaignRecipientId,
          event.providerMessageId,
          event.eventType,
          event.eventKey,
          event.payload ? JSON.stringify(event.payload) : null,
          event.occurredAt,
        ],
      );
      return { inserted: true, id: num(result.insertId) };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const rows = await this.query<RowDataPacket[]>(
        `SELECT id FROM email_events WHERE event_key = ? LIMIT 1`,
        [event.eventKey],
      );
      return { inserted: false, id: num(rows[0]?.id) };
    }
  }

  async listEventsForCampaign(campaignId: number, query: PageQuery) {
    const totalRows = await this.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM email_events e
       JOIN campaign_recipients r ON r.id = e.campaign_recipient_id
       WHERE r.campaign_id = ?`,
      [campaignId],
    );
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.query<RowDataPacket[]>(
      `SELECT e.*
       FROM email_events e
       JOIN campaign_recipients r ON r.id = e.campaign_recipient_id
       WHERE r.campaign_id = ?
       ORDER BY e.id DESC
       LIMIT ? OFFSET ?`,
      [campaignId, query.pageSize, offset],
    );
    return { rows: rows.map(mapEvent), total: num(totalRows[0]?.total), page: query.page, pageSize: query.pageSize };
  }

  async findRecipientByMessageId(messageIdNormalized: string): Promise<Recipient | null> {
    const rows = await this.query<RowDataPacket[]>(
      `${this.recipientSelect()} WHERE r.provider_message_id_normalized = ? LIMIT 1`,
      [messageIdNormalized],
    );
    return rows[0] ? mapRecipient(rows[0]) : null;
  }

  async createUnsubscribeToken(input: { contactId: number; tokenHash: string }): Promise<void> {
    await this.execute(
      `INSERT INTO unsubscribe_tokens (contact_id, token_hash) VALUES (?, ?)`,
      [input.contactId, input.tokenHash],
    );
  }

  async findUnsubscribeToken(tokenHash: string) {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT t.contact_id, t.used_at, c.email_normalized
       FROM unsubscribe_tokens t
       JOIN contacts c ON c.id = t.contact_id
       WHERE t.token_hash = ?
       LIMIT 1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      contactId: num(row.contact_id),
      emailNormalized: String(row.email_normalized),
      usedAt: asDate(row.used_at),
    };
  }

  async markUnsubscribeTokenUsed(tokenHash: string): Promise<void> {
    await this.execute(
      `UPDATE unsubscribe_tokens SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE token_hash = ?`,
      [tokenHash],
    );
  }

  async addAudit(entry: NewAudit) {
    const result = await this.execute(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.actorUserId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.ipAddress,
      ],
    );
    return {
      id: num(result.insertId),
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress,
      createdAt: new Date(),
    };
  }

  private async ensureSchedulerSettings(): Promise<void> {
    await this.execute(
      `INSERT INTO outreach_scheduler_settings (
         id, status, daily_limit, execution_time, working_days, timezone, ai_personalization
       )
       SELECT 1, 'disabled', 20, '10:00', '1,2,3,4,5', 'Asia/Kolkata', 0
       FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM outreach_scheduler_settings WHERE id = 1)`,
    );
  }

  private mapSchedulerSettings(row: RowDataPacket): SchedulerSettings {
    return {
      status: row.status,
      dailyLimit: num(row.daily_limit),
      executionTime: String(row.execution_time),
      workingDays: String(row.working_days).split(',').map((day) => Number(day)).filter((day) => day >= 1 && day <= 7),
      timezone: String(row.timezone),
      templateId: row.template_id == null ? null : num(row.template_id),
      aiPersonalization: bool(row.ai_personalization),
      startDate: row.start_date == null ? null : String(row.start_date).slice(0, 10),
      lastRunAt: asDate(row.last_run_at),
      nextRunAt: asDate(row.next_run_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      lastSuccessAt: asDate(row.last_success_at),
      updatedBy: row.updated_by == null ? null : num(row.updated_by),
    };
  }

  private schedulerSettingsSelect(lock: boolean): string {
    return `SELECT status, daily_limit, execution_time, working_days, timezone, template_id, ai_personalization,
              DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, last_run_at, next_run_at, last_error, last_success_at, updated_by
            FROM outreach_scheduler_settings
            WHERE id = 1${lock ? ' FOR UPDATE' : ''}`;
  }

  async getSchedulerSettings(): Promise<SchedulerSettings> {
    await this.ensureSchedulerSettings();
    const rows = await this.query<RowDataPacket[]>(this.schedulerSettingsSelect(false));
    return this.mapSchedulerSettings(rows[0]);
  }

  async lockSchedulerSettings(): Promise<SchedulerSettings> {
    await this.ensureSchedulerSettings();
    const rows = await this.query<RowDataPacket[]>(this.schedulerSettingsSelect(true));
    return this.mapSchedulerSettings(rows[0]);
  }

  async saveSchedulerSettings(settings: SchedulerSettings): Promise<SchedulerSettings> {
    await this.ensureSchedulerSettings();
    await this.execute(
      `UPDATE outreach_scheduler_settings
       SET status = ?, daily_limit = ?, execution_time = ?, working_days = ?, timezone = ?, template_id = ?,
           ai_personalization = ?, start_date = ?, last_run_at = ?, next_run_at = ?, last_error = ?,
           last_success_at = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [
        settings.status,
        settings.dailyLimit,
        settings.executionTime,
        settings.workingDays.join(','),
        settings.timezone,
        settings.templateId,
        settings.aiPersonalization ? 1 : 0,
        settings.startDate,
        settings.lastRunAt,
        settings.nextRunAt,
        settings.lastError,
        settings.lastSuccessAt,
        settings.updatedBy,
      ],
    );
    return this.getSchedulerSettings();
  }

  private mapSchedulerRun(row: RowDataPacket): SchedulerRun {
    return {
      id: num(row.id),
      scheduledDate: String(row.scheduled_date).slice(0, 10),
      batchNumber: num(row.batch_number),
      campaignId: row.campaign_id == null ? null : num(row.campaign_id),
      status: row.status,
      trigger: row.trigger_source,
      selectedCount: num(row.selected_count),
      errorMessage: row.error_message == null ? null : String(row.error_message),
      startedAt: asDate(row.started_at) ?? new Date(),
      finishedAt: asDate(row.finished_at),
    };
  }

  private schedulerRunSelect(): string {
    return `SELECT id, DATE_FORMAT(scheduled_date, '%Y-%m-%d') AS scheduled_date, batch_number, campaign_id,
              status, trigger_source, selected_count, error_message, started_at, finished_at
            FROM outreach_scheduler_runs`;
  }

  async listSchedulerRuns(limit: number): Promise<SchedulerRun[]> {
    const rows = await this.query<RowDataPacket[]>(`${this.schedulerRunSelect()} ORDER BY id DESC LIMIT ?`, [limit]);
    return rows.map((row) => this.mapSchedulerRun(row));
  }

  async listRunningSchedulerRuns(): Promise<SchedulerRun[]> {
    const rows = await this.query<RowDataPacket[]>(`${this.schedulerRunSelect()} WHERE status = 'running' ORDER BY id`);
    return rows.map((row) => this.mapSchedulerRun(row));
  }

  async findSchedulerRunByDate(scheduledDate: string): Promise<SchedulerRun | null> {
    const rows = await this.query<RowDataPacket[]>(
      `${this.schedulerRunSelect()} WHERE scheduled_date = ? LIMIT 1`,
      [scheduledDate],
    );
    return rows[0] ? this.mapSchedulerRun(rows[0]) : null;
  }

  async insertSchedulerRun(input: {
    scheduledDate: string;
    batchNumber: number;
    trigger: SchedulerRun['trigger'];
    startedAt: Date;
  }): Promise<SchedulerRun> {
    try {
      const result = await this.execute(
        `INSERT INTO outreach_scheduler_runs
           (scheduled_date, batch_number, status, trigger_source, selected_count, started_at)
         VALUES (?, ?, 'running', ?, 0, ?)`,
        [input.scheduledDate, input.batchNumber, input.trigger, input.startedAt],
      );
      const rows = await this.query<RowDataPacket[]>(`${this.schedulerRunSelect()} WHERE id = ?`, [result.insertId]);
      return this.mapSchedulerRun(rows[0]);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ER_DUP_ENTRY') {
        throw new AppError(409, 'A scheduler batch already exists for this date.', 'SCHEDULER_ALREADY_RAN');
      }
      throw error;
    }
  }

  async updateSchedulerRun(id: number, patch: Partial<Omit<SchedulerRun, 'id' | 'scheduledDate' | 'trigger'>>): Promise<SchedulerRun> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const mapping: Array<[keyof typeof patch, string]> = [
      ['batchNumber', 'batch_number'],
      ['campaignId', 'campaign_id'],
      ['status', 'status'],
      ['selectedCount', 'selected_count'],
      ['errorMessage', 'error_message'],
      ['startedAt', 'started_at'],
      ['finishedAt', 'finished_at'],
    ];
    for (const [key, column] of mapping) {
      if (patch[key] !== undefined) {
        assignments.push(`${column} = ?`);
        params.push(patch[key]);
      }
    }
    if (assignments.length) {
      assignments.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      await this.execute(`UPDATE outreach_scheduler_runs SET ${assignments.join(', ')} WHERE id = ?`, params);
    }
    const rows = await this.query<RowDataPacket[]>(`${this.schedulerRunSelect()} WHERE id = ?`, [id]);
    if (!rows[0]) throw new AppError(404, 'Scheduler run not found.', 'NOT_FOUND');
    return this.mapSchedulerRun(rows[0]);
  }

  private schedulerEligibleFilter(mode: 'dry_run' | 'live'): { sql: string; params: number[] } {
    const excludeSimulated = mode === 'dry_run' ? 1 : 0;
    return {
      sql: `c.eligibility_status = 'eligible'
      AND c.is_contacted = 0
      AND NOT EXISTS (
        SELECT 1 FROM suppression_list s
        WHERE s.email_normalized = c.email_normalized AND s.active = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM contacts earlier
        WHERE earlier.email_normalized = c.email_normalized AND earlier.id < c.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM campaign_recipients r
        INNER JOIN campaigns camp ON camp.id = r.campaign_id
        WHERE r.contact_id = c.id
          AND (
            r.status IN ('pending', 'sending', 'retry_wait', 'accepted', 'delivered', 'bounced', 'complained')
            OR (? = 1 AND r.status = 'simulated')
            OR (r.failure_class = 'ambiguous' AND (? = 1 OR camp.dry_run = 0))
          )
      )`,
      params: [excludeSimulated, excludeSimulated],
    };
  }

  async selectSchedulerContacts(limit: number, mode: 'dry_run' | 'live'): Promise<Contact[]> {
    if (limit < 1) return [];
    const filter = this.schedulerEligibleFilter(mode);
    const lock = this.inTransaction ? ' FOR UPDATE' : '';
    const ids = await this.query<RowDataPacket[]>(
      `SELECT c.id FROM contacts c WHERE ${filter.sql} ORDER BY c.id ASC LIMIT ?${lock}`,
      [...filter.params, limit],
    );
    if (ids.length === 0) return [];
    const selected = ids.map((row) => num(row.id));
    const rows = await this.query<RowDataPacket[]>(
      `${this.contactSelect()} WHERE c.id IN (${selected.map(() => '?').join(',')}) ORDER BY c.id`,
      selected,
    );
    return rows.map(mapContact).filter((contact) => isValidEmail(contact.email)).slice(0, limit);
  }

  async countSchedulerPools(mode: 'dry_run' | 'live'): Promise<SchedulerPools> {
    const filter = this.schedulerEligibleFilter(mode);
    const rows = await this.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM contacts c
           WHERE c.eligibility_status = 'eligible'
             AND NOT EXISTS (
               SELECT 1 FROM suppression_list s
               WHERE s.email_normalized = c.email_normalized AND s.active = 1
             )) AS eligible,
         (SELECT COUNT(*) FROM contacts c WHERE ${filter.sql}) AS remaining,
         (SELECT COUNT(*) FROM contacts WHERE is_contacted = 1) AS contacted`,
      filter.params,
    );
    return { eligible: num(rows[0]?.eligible), remaining: num(rows[0]?.remaining), contacted: num(rows[0]?.contacted) };
  }

  async countSmtpAcceptedBetween(start: Date, end: Date): Promise<number> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM campaign_recipients
       WHERE status IN ('accepted', 'delivered', 'bounced', 'complained')
         AND sent_at >= ? AND sent_at < ?`,
      [start, end],
    );
    return num(rows[0]?.total);
  }

  async schedulerDayCounts(scheduledDate: string): Promise<SchedulerDayCounts> {
    const rows = await this.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM outreach_scheduler_runs WHERE scheduled_date = ?) AS batches,
         (SELECT COUNT(*)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS recipients,
         (SELECT COALESCE(SUM(r.status = 'simulated'), 0)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS simulated,
         (SELECT COALESCE(SUM(r.status IN ('accepted', 'delivered', 'bounced', 'complained')), 0)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS accepted,
         (SELECT COALESCE(SUM(r.status = 'delivered'), 0)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS delivered,
         (SELECT COALESCE(SUM(r.status = 'bounced'), 0)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS bounced,
         (SELECT COALESCE(SUM(r.status = 'complained'), 0)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS complained,
         (SELECT COALESCE(SUM(r.status = 'failed'), 0)
            FROM campaign_recipients r
            JOIN outreach_scheduler_runs run ON run.campaign_id = r.campaign_id
           WHERE run.scheduled_date = ?) AS failed`,
      Array.from({ length: 8 }, () => scheduledDate),
    );
    return {
      batches: num(rows[0]?.batches),
      recipients: num(rows[0]?.recipients),
      simulated: num(rows[0]?.simulated),
      accepted: num(rows[0]?.accepted),
      delivered: num(rows[0]?.delivered),
      bounced: num(rows[0]?.bounced),
      complained: num(rows[0]?.complained),
      failed: num(rows[0]?.failed),
    };
  }
}

export function createMysqlStore(config: AppConfig): MysqlStore {
  const pool = mysql.createPool({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    connectionLimit: config.dbConnectionLimit,
    timezone: 'Z',
    decimalNumbers: true,
    supportBigNumbers: true,
    charset: 'utf8mb4',
  });
  return new MysqlStore(pool, pool, false);
}

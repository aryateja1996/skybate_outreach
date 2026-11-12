import { randomUUID } from 'crypto';
import { hasMissingInfo, analyzeImportRows, suggestMapping } from '../domain/importAnalyze';
import { isValidEmail, normalizeEmail } from '../domain/email';
import { AppError } from '../errors';
import type { Store } from '../store';
import type { AnalyzedRow, ColumnMapping, Contact, ImportSummary, Role } from '../types';
import { buildContactsWorkbook, mapSheetRows, parseSpreadsheet } from './excel';

export interface Actor {
  userId: number;
  role: Role;
  ipAddress: string | null;
}

export interface PreviewResult {
  needsMapping: boolean;
  headers: string[];
  suggestedMapping: ColumnMapping;
  mapping: ColumnMapping;
  sampleRows: Record<string, string>[];
  previewId?: string;
  summary?: ImportSummary;
  rows?: AnalyzedRow[];
  sampleTruncated?: boolean;
}

export async function previewContacts(input: {
  store: Store;
  actor: Actor;
  filename: string;
  buffer: Buffer;
  mapping: ColumnMapping | null;
  maxRows: number;
}): Promise<PreviewResult> {
  const parsed = await parseSpreadsheet(input.filename, input.buffer, input.maxRows);
  const suggestedMapping = suggestMapping(parsed.headers);
  const mapping = { ...suggestedMapping, ...(input.mapping ?? {}) };
  const sampleRows = parsed.rows.slice(0, 8);
  if (!mapping.email) {
    return {
      needsMapping: true,
      headers: parsed.headers,
      suggestedMapping,
      mapping,
      sampleRows,
    };
  }

  const mapped = mapSheetRows(parsed.rows, mapping);
  const normalized = [...new Set(mapped.map((row) => normalizeEmail(row.email)).filter(Boolean))];
  const existing = await input.store.findContactsByNormalizedEmails(normalized);
  const suppressed = await input.store.findActiveSuppressions(normalized);
  const analyzed = analyzeImportRows({
    rows: mapped,
    existingEmails: new Set(existing.map((contact) => contact.emailNormalized)),
    suppressedEmails: suppressed,
  });
  const previewId = randomUUID();
  const now = new Date();
  await input.store.saveImportPreview({
    id: previewId,
    userId: input.actor.userId,
    filename: input.filename,
    rows: analyzed.rows,
    summary: analyzed.summary,
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    createdAt: now,
  });
  return {
    needsMapping: false,
    headers: parsed.headers,
    suggestedMapping,
    mapping,
    sampleRows,
    previewId,
    summary: analyzed.summary,
    rows: analyzed.rows.slice(0, 100),
    sampleTruncated: analyzed.rows.length > 100,
  };
}

export async function commitContacts(input: { store: Store; actor: Actor; previewId: string }) {
  const preview = await input.store.getImportPreview(input.previewId);
  if (!preview || preview.userId !== input.actor.userId) {
    throw new AppError(404, 'Import preview not found.', 'NOT_FOUND');
  }
  if (preview.expiresAt.getTime() < Date.now()) {
    throw new AppError(410, 'Import preview has expired. Upload the file again.', 'PREVIEW_EXPIRED');
  }

  const normalized = [...new Set(preview.rows.map((row) => row.emailNormalized).filter(Boolean))];
  const existing = await input.store.findContactsByNormalizedEmails(normalized);
  const suppressed = await input.store.findActiveSuppressions(normalized);
  const analyzed = analyzeImportRows({
    rows: preview.rows.map((row) => ({
      rowNumber: row.rowNumber,
      email: row.email,
      contactName: row.contactName,
      companyName: row.companyName,
      designation: row.designation,
      website: row.website,
      source: row.source,
    })),
    existingEmails: new Set(existing.map((contact) => contact.emailNormalized)),
    suppressedEmails: suppressed,
  });

  const insertable = analyzed.rows.filter(
    (row) => row.action === 'insert' || row.action === 'insert_invalid' || row.action === 'insert_suppressed',
  );

  const result = await input.store.withTransaction(async (tx) => {
    const inserted = await tx.insertContacts(
      insertable.map((row) => ({
        email: row.action === 'insert_invalid' ? row.email.slice(0, 320) : row.emailNormalized,
        emailNormalized: row.emailNormalized.slice(0, 320),
        contactName: row.contactName || null,
        companyName: row.companyName || null,
        designation: row.designation || null,
        website: row.website || null,
        source: row.source || null,
        eligibilityStatus:
          row.action === 'insert_invalid' ? 'invalid_email' : row.action === 'insert_suppressed' ? 'suppressed' : 'eligible',
        missingInfo: hasMissingInfo(row.contactName, row.companyName),
      })),
    );
    await tx.createImportBatch({
      filename: preview.filename,
      totalRows: analyzed.summary.totalRows,
      insertedCount: inserted.length,
      duplicateCount: analyzed.summary.duplicateInFile + analyzed.summary.duplicateInDatabase,
      invalidCount: analyzed.summary.invalidEmail,
      missingEmailCount: analyzed.summary.missingEmail,
      missingInfoCount: analyzed.rows.filter((row) => hasMissingInfo(row.contactName, row.companyName) && row.action.startsWith('insert')).length,
      suppressedCount: analyzed.summary.suppressed,
      createdBy: input.actor.userId,
    });
    await tx.deleteImportPreview(preview.id);
    await tx.addAudit({
      actorUserId: input.actor.userId,
      action: 'contacts_imported',
      entityType: 'import_batch',
      entityId: null,
      metadata: {
        filename: preview.filename,
        inserted: inserted.length,
        duplicates: analyzed.summary.duplicateInFile + analyzed.summary.duplicateInDatabase,
      },
      ipAddress: input.actor.ipAddress,
    });
    return { inserted: inserted.length, summary: analyzed.summary };
  });

  return result;
}

export async function updateContactRecord(input: {
  store: Store;
  id: number;
  patch: {
    email?: string;
    contactName?: string | null;
    companyName?: string | null;
    designation?: string | null;
    website?: string | null;
    source?: string | null;
  };
}): Promise<Contact> {
  const current = await input.store.findContactById(input.id);
  if (!current) throw new AppError(404, 'Contact not found.', 'NOT_FOUND');
  const nextEmail = input.patch.email === undefined ? current.email : input.patch.email.trim();
  const emailNormalized = normalizeEmail(nextEmail);
  if (!emailNormalized) throw new AppError(400, 'Email is required.', 'VALIDATION_ERROR');
  const suppression = await input.store.findActiveSuppression(emailNormalized);
  let eligibility = current.eligibilityStatus;
  if (suppression) eligibility = 'suppressed';
  else if (!isValidEmail(emailNormalized)) eligibility = 'invalid_email';
  else eligibility = 'eligible';
  const contactName = input.patch.contactName === undefined ? current.contactName : input.patch.contactName;
  const companyName = input.patch.companyName === undefined ? current.companyName : input.patch.companyName;
  return input.store.updateContact(input.id, {
    email: eligibility === 'invalid_email' ? nextEmail.slice(0, 320) : emailNormalized,
    emailNormalized: emailNormalized.slice(0, 320),
    contactName,
    companyName,
    designation: input.patch.designation === undefined ? current.designation : input.patch.designation,
    website: input.patch.website === undefined ? current.website : input.patch.website,
    source: input.patch.source === undefined ? current.source : input.patch.source,
    eligibilityStatus: eligibility,
    missingInfo: hasMissingInfo(contactName, companyName),
  });
}

export async function exportContacts(input: {
  store: Store;
  search?: string;
  eligibility?: Contact['eligibilityStatus'];
  missingInfo?: boolean;
  outreach?: 'never' | 'contacted' | 'suppressed' | 'invalid';
}): Promise<Buffer> {
  const contacts = await input.store.listAllContacts({
    search: input.search,
    eligibility: input.eligibility,
    missingInfo: input.missingInfo,
    outreach: input.outreach,
    limit: 10000,
  });
  return buildContactsWorkbook(contacts);
}

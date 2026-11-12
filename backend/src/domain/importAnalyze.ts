import { isValidEmail, normalizeEmail } from './email';
import type { AnalyzedRow, ImportSummary, ParsedContactRow } from '../types';

export interface AnalyzeInput {
  rows: ParsedContactRow[];
  existingEmails: Set<string>;
  suppressedEmails: Set<string>;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

export function hasMissingInfo(name?: string | null, company?: string | null): boolean {
  return !name?.trim() || !company?.trim();
}

export function analyzeImportRows(input: AnalyzeInput): { rows: AnalyzedRow[]; summary: ImportSummary } {
  const seenInFile = new Set<string>();
  const summary: ImportSummary = {
    totalRows: input.rows.length,
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
  };

  const rows: AnalyzedRow[] = input.rows.map((row) => {
    const issues: string[] = [];
    const email = row.email.trim();
    const emailNormalized = normalizeEmail(email);
    if (blank(row.contactName)) {
      issues.push('Missing contact name');
      summary.missingName += 1;
    }
    if (blank(row.companyName)) {
      issues.push('Missing company');
      summary.missingCompany += 1;
    }
    if (blank(row.designation)) {
      issues.push('Missing designation');
      summary.missingDesignation += 1;
    }
    if (blank(row.website)) {
      issues.push('Missing website');
      summary.missingWebsite += 1;
    }

    let action: AnalyzedRow['action'];
    if (!emailNormalized) {
      action = 'skip_missing_email';
      issues.push('Missing email');
      summary.missingEmail += 1;
    } else if (seenInFile.has(emailNormalized)) {
      action = 'skip_duplicate';
      issues.push('Duplicate email in this file');
      summary.duplicateInFile += 1;
    } else if (input.existingEmails.has(emailNormalized)) {
      action = 'skip_duplicate';
      issues.push('Duplicate of a contact already in the database');
      summary.duplicateInDatabase += 1;
      seenInFile.add(emailNormalized);
    } else if (!isValidEmail(emailNormalized)) {
      action = 'insert_invalid';
      issues.push('Invalid email format');
      summary.invalidEmail += 1;
      seenInFile.add(emailNormalized);
    } else if (input.suppressedEmails.has(emailNormalized)) {
      action = 'insert_suppressed';
      issues.push('Address is on the suppression list');
      summary.suppressed += 1;
      seenInFile.add(emailNormalized);
    } else {
      action = 'insert';
      summary.readyToInsert += 1;
      seenInFile.add(emailNormalized);
    }

    return {
      rowNumber: row.rowNumber,
      email,
      emailNormalized,
      contactName: row.contactName.trim(),
      companyName: row.companyName.trim(),
      designation: row.designation.trim(),
      website: row.website.trim(),
      source: row.source.trim(),
      issues,
      action,
    };
  });

  return { rows, summary };
}

const HEADER_ALIASES: Record<keyof import('../types').ColumnMapping, string[]> = {
  email: ['email', 'emailaddress', 'emailid', 'mail', 'workemail'],
  contactName: ['contactname', 'name', 'fullname', 'contact', 'person'],
  companyName: ['company', 'companyname', 'organization', 'organisation', 'account'],
  designation: ['designation', 'title', 'jobtitle', 'role', 'position'],
  website: ['website', 'url', 'web', 'companywebsite'],
  source: ['source', 'list', 'origin', 'listsource'],
};

function canonicalHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function suggestMapping(headers: string[]): import('../types').ColumnMapping {
  const mapping: import('../types').ColumnMapping = {};
  for (const header of headers) {
    const token = canonicalHeader(header);
    if (!token) continue;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
      [keyof import('../types').ColumnMapping, string[]]
    >) {
      if (!mapping[field] && aliases.includes(token)) {
        mapping[field] = header;
      }
    }
  }
  return mapping;
}

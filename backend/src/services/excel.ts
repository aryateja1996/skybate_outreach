import ExcelJS from 'exceljs';
import { neutralizeSpreadsheetText, sanitizeExportCell } from '../domain/exportSafety';
import { AppError } from '../errors';
import type { ColumnMapping, Contact, ParsedContactRow } from '../types';

function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export function assertSpreadsheet(filename: string, buffer: Buffer): void {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xls') && !lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
    throw new AppError(400, 'Save the workbook as .xlsx. Legacy .xls files are not accepted.', 'INVALID_FILE');
  }
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
    throw new AppError(400, 'Upload an Excel file ending in .xlsx.', 'INVALID_FILE');
  }
  if (!isZip(buffer)) {
    throw new AppError(400, 'The file is not a valid .xlsx workbook.', 'INVALID_FILE');
  }
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value && value.result != null && !('formula' in value && value.result == null)) {
      return cellText(value.result as ExcelJS.CellValue);
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('hyperlink' in value && 'text' in value) return String(value.text ?? '');
  }
  return '';
}

function emptyRow(values: string[]): boolean {
  return values.every((value) => value.trim() === '');
}

async function parseXlsx(buffer: Buffer, maxRows: number): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError(400, 'The workbook has no worksheets.', 'INVALID_FILE');
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  const lastColumn = Math.max(headerRow.cellCount, sheet.columnCount);
  for (let column = 1; column <= lastColumn; column += 1) {
    headers.push(cellText(headerRow.getCell(column).value).trim());
  }
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
  if (headers.length === 0 || headers.every((header) => header === '')) {
    throw new AppError(400, 'The first row must contain column headings.', 'INVALID_FILE');
  }
  const rows: Record<string, string>[] = [];
  const limit = Math.min(sheet.rowCount, maxRows + 1);
  if (sheet.rowCount - 1 > maxRows) {
    throw new AppError(400, `The workbook exceeds the limit of ${maxRows} data rows.`, 'TOO_MANY_ROWS');
  }
  for (let rowNumber = 2; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = headers.map((_, index) => cellText(row.getCell(index + 1).value).trim());
    if (emptyRow(values)) continue;
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = values[index] ?? '';
    });
    rows.push(record);
  }
  return { headers: headers.filter(Boolean), rows };
}

export async function parseSpreadsheet(
  filename: string,
  buffer: Buffer,
  maxRows: number,
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  assertSpreadsheet(filename, buffer);
  return parseXlsx(buffer, maxRows);
}

export function mapSheetRows(rows: Record<string, string>[], mapping: ColumnMapping): ParsedContactRow[] {
  const read = (row: Record<string, string>, header?: string): string => {
    if (!header) return '';
    return neutralizeSpreadsheetText(row[header] ?? '');
  };
  return rows.map((row, index) => ({
    rowNumber: index + 2,
    email: (mapping.email ? row[mapping.email] ?? '' : '').trim(),
    contactName: read(row, mapping.contactName),
    companyName: read(row, mapping.companyName),
    designation: read(row, mapping.designation),
    website: read(row, mapping.website),
    source: read(row, mapping.source),
  }));
}

export async function buildContactsWorkbook(contacts: Contact[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Contacts');
  const headers = ['Email', 'Contact name', 'Company', 'Designation', 'Website', 'Source', 'Eligibility', 'Missing information'];
  sheet.addRow(headers);
  for (const contact of contacts) {
    sheet.addRow([
      sanitizeExportCell(contact.email),
      sanitizeExportCell(contact.contactName),
      sanitizeExportCell(contact.companyName),
      sanitizeExportCell(contact.designation),
      sanitizeExportCell(contact.website),
      sanitizeExportCell(contact.source),
      sanitizeExportCell(contact.eligibilityStatus),
      contact.missingInfo ? 'yes' : 'no',
    ]);
  }
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

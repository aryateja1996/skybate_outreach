const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function sanitizeExportCell(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function neutralizeSpreadsheetText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return FORMULA_PREFIX.test(trimmed) ? `'${trimmed}` : trimmed;
}

import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import { Banner, Button, inputClass } from '../components/ui';
import type { ImportPreview } from '../types';

const fields = [
  ['email', 'Email'],
  ['contactName', 'Contact name'],
  ['companyName', 'Company'],
  ['designation', 'Designation'],
  ['website', 'Website'],
  ['source', 'Source'],
] as const;

export function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setResult('');
    const body = new FormData();
    body.set('file', file);
    if (Object.keys(mapping).length) body.set('mapping', JSON.stringify(mapping));
    try {
      const response = await api.post<ImportPreview>('/api/contacts/import/preview', body);
      setPreview(response.data);
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.data.mapping)) {
        if (value) next[key] = value;
      }
      setMapping(next);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview?.previewId) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.post('/api/contacts/import/commit', { previewId: preview.previewId });
      setResult(`Inserted ${response.data.inserted} contacts. Duplicates were not inserted.`);
      setPreview(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <h2 className="font-serif text-4xl">Import contacts</h2>
      <p className="mt-2 text-sm text-muted">Preview the workbook, map columns, and commit only after you review duplicates and invalid addresses. This step does not send email.</p>
      <form className="mt-6 space-y-4" onSubmit={(event) => void analyze(event)}>
        <input
          className="block text-sm"
          type="file"
          accept=".xlsx,.xlsm,.xls"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        {preview ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map(([key, label]) => (
              <label key={key} className="text-sm">
                <span className="mb-1 block text-muted">{label}</span>
                <select
                  className={inputClass}
                  value={mapping[key] ?? ''}
                  onChange={(event) => setMapping((current) => ({ ...current, [key]: event.target.value }))}
                >
                  <option value="">Not mapped</option>
                  {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>
            ))}
          </div>
        ) : null}
        <Button type="submit" disabled={!file || busy}>{busy ? 'Reading…' : 'Preview spreadsheet'}</Button>
      </form>
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      {result ? <div className="mt-4"><Banner tone="info">{result}</Banner></div> : null}
      {preview?.needsMapping ? <div className="mt-4"><Banner tone="warn">Map the email column, then preview again.</Banner></div> : null}
      {preview?.summary ? (
        <div className="mt-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Summary label="Ready to insert" value={preview.summary.readyToInsert} />
            <Summary label="Duplicates" value={preview.summary.duplicateInFile + preview.summary.duplicateInDatabase} />
            <Summary label="Invalid emails" value={preview.summary.invalidEmail} />
            <Summary label="Missing email" value={preview.summary.missingEmail} />
            <Summary label="Missing name" value={preview.summary.missingName} />
            <Summary label="Suppressed" value={preview.summary.suppressed} />
          </div>
          <div className="mt-4 overflow-x-auto bg-card shadow-card">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Issues</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows?.map((row) => (
                  <tr key={row.rowNumber} className="border-b border-line/70">
                    <td className="px-3 py-2">{row.rowNumber}</td>
                    <td className="px-3 py-2">{row.email || '—'}</td>
                    <td className="px-3 py-2">{row.contactName || '—'}</td>
                    <td className="px-3 py-2">{row.companyName || '—'}</td>
                    <td className="px-3 py-2">{row.action}</td>
                    <td className="px-3 py-2">{row.issues.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.sampleTruncated ? <p className="mt-2 text-xs text-muted">Showing the first 100 analyzed rows. The counts include the full file.</p> : null}
          <Button className="mt-4" type="button" disabled={busy || !preview.previewId} onClick={() => void commit()}>
            Commit import
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card p-4 shadow-card">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-serif text-3xl">{value}</p>
    </div>
  );
}

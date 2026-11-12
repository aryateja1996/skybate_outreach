import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Button, Empty, inputClass } from '../components/ui';
import type { Contact, DashboardStats, Page } from '../types';

const outreachFilters = [
  ['', 'All contacts'],
  ['never', 'Never contacted'],
  ['contacted', 'Previously contacted'],
  ['suppressed', 'Suppressed'],
  ['invalid', 'Invalid'],
] as const;

export function ContactsPage() {
  const [search, setSearch] = useState('');
  const [outreach, setOutreach] = useState('');
  const [missingInfo, setMissingInfo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Contact> | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState('');

  function queryString(nextPage = page): string {
    const params = new URLSearchParams({ page: String(nextPage), pageSize: '25' });
    if (search) params.set('search', search);
    if (outreach) params.set('outreach', outreach);
    if (missingInfo) params.set('missingInfo', missingInfo);
    return params.toString();
  }

  function load(nextPage = page) {
    api.get<Page<Contact>>(`/api/contacts?${queryString(nextPage)}`)
      .then((response) => setData(response.data))
      .catch((reason) => setError(errorMessage(reason)));
  }

  useEffect(() => {
    load(1);
    api.get<DashboardStats>('/api/dashboard/stats').then((response) => setStats(response.data)).catch(() => undefined);
    // Initial load only. Filters apply from the form submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function exportFile() {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (outreach) params.set('outreach', outreach);
    if (missingInfo) params.set('missingInfo', missingInfo);
    const response = await api.get(`/api/contacts/export?${params.toString()}`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'skybate-contacts.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-4xl">Contacts</h2>
          <p className="mt-2 text-sm text-muted">Importing a spreadsheet never sends email. Invalid and suppressed addresses stay ineligible.</p>
        </div>
        <Link className="text-sm text-copper" to="/contacts/import">Import Excel</Link>
      </div>
      {stats ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ['Total contacts', stats.totalContacts],
            ['Never contacted', stats.neverContacted],
            ['Previously contacted', stats.previouslyContacted],
            ['Suppressed', stats.suppressedContacts],
            ['Invalid contacts', stats.invalidFormatAddresses],
          ].map(([label, value]) => (
            <article key={String(label)} className="bg-card p-4 shadow-card">
              <p className="text-sm text-muted">{label}</p>
              <p className="mt-2 font-serif text-3xl">{value}</p>
            </article>
          ))}
        </div>
      ) : null}
      <form
        className="mt-6 grid gap-3 md:grid-cols-[1fr_12rem_12rem_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          load(1);
        }}
      >
        <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search email, name, or company" />
        <select className={inputClass} value={outreach} onChange={(event) => setOutreach(event.target.value)}>
          {outreachFilters.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
        </select>
        <select className={inputClass} value={missingInfo} onChange={(event) => setMissingInfo(event.target.value)}>
          <option value="">Any completeness</option>
          <option value="true">Missing name or company</option>
          <option value="false">Name and company present</option>
        </select>
        <Button type="submit">Apply</Button>
        <Button type="button" variant="secondary" onClick={() => void exportFile()}>Export</Button>
      </form>
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      <div className="mt-4 overflow-x-auto bg-card shadow-card">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-3 py-3 font-medium">Email</th>
              <th className="px-3 py-3 font-medium">Name</th>
              <th className="px-3 py-3 font-medium">Company</th>
              <th className="px-3 py-3 font-medium">Designation</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Outreach</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((contact) => (
              <tr key={contact.id} className="border-b border-line/80">
                <td className="px-3 py-3"><Link className="text-copper" to={`/contacts/${contact.id}`}>{contact.email}</Link></td>
                <td className="px-3 py-3">{contact.contactName || '—'}</td>
                <td className="px-3 py-3">{contact.companyName || '—'}</td>
                <td className="px-3 py-3">{contact.designation || '—'}</td>
                <td className="px-3 py-3">
                  {contact.eligibilityStatus}
                  {contact.missingInfo ? ' · missing info' : ''}
                </td>
                <td className="px-3 py-3">{contact.isContacted ? 'Previously contacted' : 'Never contacted'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 ? <Empty>No contacts match these filters.</Empty> : null}
      </div>
      {data ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted">{data.total} contacts</span>
          <div className="flex gap-2">
            <Button variant="secondary" type="button" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); load(next); }}>Previous</Button>
            <Button variant="secondary" type="button" disabled={page * data.pageSize >= data.total} onClick={() => { const next = page + 1; setPage(next); load(next); }}>Next</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

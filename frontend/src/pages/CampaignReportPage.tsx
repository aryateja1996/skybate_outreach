import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { Campaign } from '../types';

interface Report {
  campaign: Campaign;
  counts: Record<string, number>;
  note: string;
  events: { rows: Array<{ id: number; eventType: string; providerMessageId: string | null; createdAt: string }> };
}

const labels: Array<[string, string]> = [
  ['recipients', 'Recipients'],
  ['attempts', 'Sending attempts'],
  ['simulated', 'Simulated results'],
  ['accepted', 'Accepted by provider'],
  ['delivered', 'Confirmed deliveries'],
  ['bounced', 'Bounces'],
  ['complained', 'Complaints'],
  ['suppressed', 'Suppressed at send'],
  ['unsubscribes', 'Suppressed addresses in this campaign'],
  ['failed', 'Failed'],
  ['pending', 'Still open'],
  ['cancelled', 'Cancelled'],
];

export function CampaignReportPage() {
  const { id } = useParams();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Report>(`/api/campaigns/${id}/events`)
      .then((response) => setReport(response.data))
      .catch((reason) => setError(errorMessage(reason)));
  }, [id]);

  if (!report) return <p className="text-sm text-muted">{error || 'Loading report…'}</p>;

  return (
    <div>
      <Link className="text-sm text-copper" to={`/campaigns/${report.campaign.id}`}>Back to campaign</Link>
      <h2 className="mt-3 font-serif text-4xl">{report.campaign.name}</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">{report.note}</p>
      <p className="mt-2 text-sm">Status: {report.campaign.status}. Mode recorded on the campaign: {report.campaign.dryRun ? 'dry run' : 'live'}.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {labels.map(([key, label]) => (
          <article key={key} className="bg-card p-4 shadow-card">
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-2 font-serif text-3xl">{report.counts[key] ?? 0}</p>
          </article>
        ))}
      </div>
      <h3 className="mt-8 font-serif text-2xl">Provider events</h3>
      <div className="mt-3 bg-card shadow-card">
        {report.events.rows.length === 0 ? <p className="p-4 text-sm text-muted">No SES events yet. Dry-run results do not create provider events.</p> : (
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">Message id</th>
                <th className="px-3 py-2">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {report.events.rows.map((event) => (
                <tr key={event.id} className="border-b border-line">
                  <td className="px-3 py-2">{event.eventType}</td>
                  <td className="px-3 py-2">{event.providerMessageId || '—'}</td>
                  <td className="px-3 py-2">{new Date(event.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

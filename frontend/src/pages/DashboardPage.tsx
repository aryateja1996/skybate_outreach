import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { metricNote } from '../lib/metrics';
import type { DashboardStats } from '../types';

const items: Array<[keyof DashboardStats, string]> = [
  ['totalContacts', 'Total contacts'],
  ['neverContacted', 'Never contacted'],
  ['previouslyContacted', 'Previously contacted'],
  ['suppressedContacts', 'Suppressed'],
  ['invalidFormatAddresses', 'Invalid contacts'],
  ['eligibleContacts', 'Eligible for outreach'],
  ['duplicateContacts', 'Duplicate contacts'],
  ['draftCampaigns', 'Draft campaigns'],
  ['approvedCampaigns', 'Approved campaigns'],
  ['sendingAttempts', 'Sending attempts'],
  ['simulatedResults', 'Simulated results'],
  ['acceptedByProvider', 'Successfully accepted'],
  ['confirmedDeliveries', 'Delivered'],
  ['failedSends', 'Failed'],
  ['bounces', 'Bounces'],
  ['complaints', 'Complaints'],
];

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<DashboardStats>('/api/dashboard/stats')
      .then((response) => setStats(response.data))
      .catch((reason) => setError(errorMessage(reason)));
  }, []);

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-serif text-4xl">Dashboard</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">Figures come from the database. An empty desk shows zeros. Simulated results are never counted as confirmed deliveries.</p>
        </div>
        <Link className="text-sm text-copper" to="/campaigns/new">New campaign</Link>
      </div>
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {items.map(([key, label]) => (
          <article key={key} className="bg-card p-4 shadow-card">
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-2 font-serif text-4xl">{stats ? Number(stats[key] ?? 0) : '—'}</p>
            {stats ? <p className="mt-2 text-xs leading-5 text-muted">{metricNote(key, stats.sendingMode)}</p> : null}
          </article>
        ))}
      </div>
      {stats ? (
        <p className="mt-6 text-sm text-muted">
          Suppressed contacts: {stats.suppressedContacts}. Unsubscribe requests: {stats.unsubscribeRequests}.
        </p>
      ) : null}
    </div>
  );
}

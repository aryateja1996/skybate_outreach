import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Empty } from '../components/ui';
import { statusCaption } from '../lib/metrics';
import type { Campaign, Page } from '../types';

export function CampaignsPage() {
  const [data, setData] = useState<Page<Campaign> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Page<Campaign>>('/api/campaigns')
      .then((response) => setData(response.data))
      .catch((reason) => setError(errorMessage(reason)));
  }, []);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h2 className="font-serif text-4xl">Campaigns</h2>
          <p className="mt-2 text-sm text-muted">Approval does not send. Starting is a separate action, and dry-run stays simulated.</p>
        </div>
        <Link className="text-sm text-copper" to="/campaigns/new">Create campaign</Link>
      </div>
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      <div className="mt-6 space-y-3">
        {data?.rows.map((campaign) => (
          <Link key={campaign.id} to={`/campaigns/${campaign.id}`} className="block bg-card p-4 shadow-card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-serif text-2xl">{campaign.name}</h3>
              <span className="text-sm text-muted">{campaign.status} · {campaign.dryRun ? 'dry run' : 'live'} · {campaign.totalRecipients} recipients</span>
            </div>
            <p className="mt-2 text-sm text-muted">{campaign.subject}</p>
            <p className="mt-1 text-xs text-muted">{statusCaption(campaign.status)}</p>
          </Link>
        ))}
        {data && data.rows.length === 0 ? <Empty>No campaigns yet.</Empty> : null}
      </div>
    </div>
  );
}

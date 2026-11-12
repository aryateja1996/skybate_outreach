import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Banner, Button, Modal } from '../components/ui';
import { statusCaption } from '../lib/metrics';
import type { Campaign, Page, Recipient, SystemStatus } from '../types';

export function CampaignDetailPage() {
  const { id } = useParams();
  const system = useOutletContext<SystemStatus | null>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Page<Recipient> | null>(null);
  const [footer, setFooter] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'approve' | 'start' | null>(null);
  const [typedCount, setTypedCount] = useState('');

  async function reload() {
    const [campaignResponse, recipientResponse] = await Promise.all([
      api.get<Campaign>(`/api/campaigns/${id}`),
      api.get<Page<Recipient>>(`/api/campaigns/${id}/recipients?pageSize=8`),
    ]);
    setCampaign(campaignResponse.data);
    setRecipients(recipientResponse.data);
  }

  useEffect(() => {
    reload().catch((reason) => setError(errorMessage(reason)));
  }, [id]);

  async function run(action: string, body?: unknown) {
    setError('');
    try {
      const response = await api.post(`/api/campaigns/${id}/${action}`, body ?? {});
      if (action === 'generate-previews') setFooter(response.data.footer ?? '');
      setConfirm(null);
      setTypedCount('');
      await reload();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (!campaign) return <p className="text-sm text-muted">{error || 'Loading campaign…'}</p>;
  const count = campaign.issues?.total ?? campaign.totalRecipients;

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-4xl">{campaign.name}</h2>
          <p className="mt-2 text-sm text-muted">{campaign.status} · {campaign.dryRun ? 'Will simulate' : 'Live campaign'} · {count} recipients · limit {campaign.recipientLimit}</p>
        </div>
        <Link className="text-sm text-copper" to={`/campaigns/${campaign.id}/report`}>Open report</Link>
      </div>
      {campaign.circuitBreakerTripped ? <div className="mt-4"><Banner tone="bad">The circuit breaker paused this campaign after repeated failures.</Banner></div> : null}
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      <article className="mt-6 bg-card p-5 shadow-card">
        <p className="text-sm text-muted">From {campaign.senderName} &lt;{campaign.senderEmail}&gt;</p>
        <h3 className="mt-3 font-serif text-2xl">{campaign.subject}</h3>
        <pre className="mt-4 whitespace-pre-wrap font-serif text-sm leading-6">{campaign.body}</pre>
      </article>
      <div className="mt-4 flex flex-wrap gap-2">
        {['draft', 'previewed'].includes(campaign.status) ? <Button type="button" onClick={() => void run('generate-previews')}>Generate previews</Button> : null}
        {campaign.status === 'previewed' ? <Button type="button" onClick={() => setConfirm('approve')}>Approve</Button> : null}
        {['approved', 'paused'].includes(campaign.status) ? <Button type="button" onClick={() => setConfirm('start')}>Start sending</Button> : null}
        {campaign.status === 'sending' ? <Button type="button" variant="secondary" onClick={() => void run('pause')}>Pause</Button> : null}
        {['draft', 'previewed', 'approved', 'sending', 'paused'].includes(campaign.status) ? <Button type="button" variant="danger" onClick={() => void run('cancel')}>Cancel</Button> : null}
      </div>
      <p className="mt-4 text-sm text-muted">Rate {campaign.sendRatePerSecond}/sec · batch {campaign.batchSize}. Approval alone does not send.</p>
      {footer ? <pre className="mt-4 whitespace-pre-wrap bg-[#f8efd8] p-4 text-sm">{footer}</pre> : null}
      <h3 className="mt-8 font-serif text-2xl">Preview sample</h3>
      <div className="mt-3 space-y-3">
        {recipients?.rows.map((recipient) => (
          <article key={recipient.id} className="border border-line bg-card p-4">
            <p className="text-sm text-muted">{recipient.contactName || 'Hello'} · {recipient.email} · {recipient.companyName || 'your organization'}</p>
            <p className="mt-2 text-sm font-medium">{recipient.personalizedSubject}</p>
            <pre className="mt-2 whitespace-pre-wrap font-serif text-sm leading-6">{recipient.personalizedBody}</pre>
            <p className="mt-2 text-xs text-muted">{statusCaption(recipient.status)}{recipient.lastError ? ` ${recipient.lastError}` : ''}</p>
          </article>
        ))}
        {recipients && recipients.rows.length === 0 ? <p className="text-sm text-muted">Generate previews to review personalized messages.</p> : null}
      </div>
      {confirm ? (
        <Modal title={confirm === 'approve' ? 'Approve campaign' : 'Start campaign'} onClose={() => setConfirm(null)}>
          <p className="text-sm leading-6">
            {confirm === 'approve'
              ? `Approving does not send email. Type ${count} to confirm the recipient count.`
              : system?.sendingMode === 'live'
                ? `This will send ${count} individual messages. Type ${count} to continue.`
                : `This will simulate ${count} individual messages. No email is sent. Type ${count} to continue.`}
          </p>
          <input className="mt-3 w-full border border-line px-3 py-2" value={typedCount} onChange={(event) => setTypedCount(event.target.value)} />
          <Button
            className="mt-4"
            type="button"
            disabled={Number(typedCount) !== count}
            onClick={() => void run(confirm, { confirmRecipientCount: count })}
          >
            {confirm === 'approve' ? 'Approve only' : 'Start'}
          </Button>
        </Modal>
      ) : null}
    </div>
  );
}

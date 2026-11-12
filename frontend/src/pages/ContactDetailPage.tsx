import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { statusCaption } from '../lib/metrics';
import type { Contact, OutreachHistoryItem } from '../types';

function when(value: string | null): string {
  if (!value) return 'Not sent';
  return new Date(value).toLocaleString();
}

export function ContactDetailPage() {
  const { id } = useParams();
  const [contact, setContact] = useState<Contact | null>(null);
  const [history, setHistory] = useState<OutreachHistoryItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ contact: Contact; history: OutreachHistoryItem[] }>(`/api/contacts/${id}/outreach`)
      .then((response) => {
        setContact(response.data.contact);
        setHistory(response.data.history);
      })
      .catch((reason) => setError(errorMessage(reason)));
  }, [id]);

  if (!contact) return <p className="text-sm text-muted">{error || 'Loading contact…'}</p>;

  return (
    <div className="max-w-4xl">
      <Link className="text-sm text-copper" to="/contacts">Back to contacts</Link>
      <h2 className="mt-3 font-serif text-4xl">{contact.contactName || 'Hello'}</h2>
      <p className="mt-2 text-sm text-muted">{contact.email} · {contact.companyName || 'your organization'}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <article className="bg-card p-4 shadow-card">
          <p className="text-sm text-muted">Outreach</p>
          <p className="mt-2 font-serif text-2xl">{contact.isContacted ? 'Previously contacted' : 'Never contacted'}</p>
        </article>
        <article className="bg-card p-4 shadow-card">
          <p className="text-sm text-muted">Accepted sends</p>
          <p className="mt-2 font-serif text-2xl">{contact.contactCount}</p>
        </article>
        <article className="bg-card p-4 shadow-card">
          <p className="text-sm text-muted">Last outreach</p>
          <p className="mt-2 text-sm">{when(contact.lastContactedAt)}</p>
        </article>
        <article className="bg-card p-4 shadow-card">
          <p className="text-sm text-muted">Last campaign</p>
          <p className="mt-2 text-sm">{contact.lastCampaignName || '—'}</p>
        </article>
      </div>
      <p className="mt-4 text-sm text-muted">Eligibility: {contact.eligibilityStatus}. Suppression still blocks every campaign, including follow-up.</p>
      <h3 className="mt-8 font-serif text-2xl">Outreach history</h3>
      <div className="mt-3 space-y-3">
        {history.map((item) => (
          <article key={item.recipientId} className="border border-line bg-card p-4">
            <p className="font-medium">{item.campaignName}</p>
            <p className="mt-1 text-sm">{item.subject}</p>
            <p className="mt-2 text-sm text-muted">{when(item.sentAt)} · {item.attemptCount} attempt{item.attemptCount === 1 ? '' : 's'}</p>
            <p className="mt-2 text-sm">{statusCaption(item.status)}</p>
            <p className="mt-1 text-xs text-muted">
              SMTP accepted: {item.smtpAccepted ? 'yes' : 'no'}
              {' · '}Delivery: {item.delivered ? 'confirmed' : 'not confirmed'}
              {item.bounced ? ' · Bounced' : ''}
              {item.complained ? ' · Complaint' : ''}
            </p>
          </article>
        ))}
        {history.length === 0 ? <p className="text-sm text-muted">No campaign has included this contact yet.</p> : null}
      </div>
    </div>
  );
}

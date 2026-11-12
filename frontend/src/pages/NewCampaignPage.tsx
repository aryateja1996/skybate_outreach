import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, inputClass, Modal } from '../components/ui';
import { statusCaption } from '../lib/metrics';
import type { Contact, OutreachHistoryItem, Page, SystemStatus, Template } from '../types';

const schema = z.object({
  name: z.string().trim().min(3, 'Name the campaign.'),
  senderName: z.string().trim().min(2, 'Enter the sender display name.'),
  subject: z.string().trim().min(3, 'Enter a subject.'),
  body: z.string().trim().min(20, 'Enter the message.'),
  recipientLimit: z.coerce.number().int().positive('Set a recipient limit.'),
  selectEligible: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

function contactLabel(contact: Contact): string {
  const history = contact.isContacted
    ? `Previously contacted${contact.lastContactedAt ? ` ${new Date(contact.lastContactedAt).toLocaleString()}` : ''}${contact.lastCampaignName ? ` · ${contact.lastCampaignName}` : ''} · ${contact.contactCount} accepted`
    : 'Never contacted';
  return `${contact.contactName || 'Hello'} · ${contact.email} · ${contact.companyName || 'your organization'} · ${history}`;
}

export function NewCampaignPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contacted, setContacted] = useState<Contact[]>([]);
  const [showContacted, setShowContacted] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [followUpIds, setFollowUpIds] = useState<number[]>([]);
  const [pendingFollowUp, setPendingFollowUp] = useState<Contact | null>(null);
  const [followUpHistory, setFollowUpHistory] = useState<OutreachHistoryItem[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState('');
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      senderName: 'Sreekar Kondaveeti',
      subject: '',
      body: '',
      recipientLimit: 10,
      selectEligible: false,
    },
  });
  const selectEligible = form.watch('selectEligible');

  useEffect(() => {
    api.get<{ rows: Template[] }>('/api/templates').then((response) => {
      setTemplates(response.data.rows);
      const initial = response.data.rows.find((template) => template.isDefault) ?? response.data.rows[0];
      if (initial) {
        form.setValue('subject', initial.subject);
        form.setValue('body', initial.body);
      }
    }).catch(() => undefined);
    api.get<Page<Contact>>('/api/contacts?outreach=never&forCampaign=true&pageSize=100').then((response) => setContacts(response.data.rows)).catch(() => undefined);
    api.get<SystemStatus>('/api/system/status').then((response) => {
      setStatus(response.data);
      form.setValue('senderName', response.data.senderName);
    }).catch(() => undefined);
    // Load reference data once. setValue is stable for the lifetime of the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      className="max-w-3xl space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError('');
        try {
          const response = await api.post('/api/campaigns', {
            name: values.name,
            senderName: values.senderName,
            subject: values.subject,
            body: values.body,
            recipientLimit: values.recipientLimit,
            selectEligible: values.selectEligible,
            contactIds: values.selectEligible ? undefined : selected,
            followUpContactIds: values.selectEligible ? undefined : followUpIds,
          });
          navigate(`/campaigns/${response.data.id}`);
        } catch (reason) {
          setError(errorMessage(reason));
        }
      })}
    >
      <h2 className="font-serif text-4xl">New campaign</h2>
      <p className="text-sm text-muted">
        The sender address is fixed to {status?.senderEmail ?? 'the configured SES identity'}. The recipient cap is {status?.maxRecipientsPerCampaign ?? 25}. The list leaves out addresses already simulated in a dry-run, accepted by SMTP, suppressed, or left unresolved.
      </p>
      <Field label="Saved template">
        <select
          className={inputClass}
          onChange={(event) => {
            const template = templates.find((item) => item.id === Number(event.target.value));
            if (!template) return;
            form.setValue('subject', template.subject);
            form.setValue('body', template.body);
          }}
        >
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </Field>
      <Field label="Campaign name" error={form.formState.errors.name?.message}>
        <input className={inputClass} {...form.register('name')} />
      </Field>
      <Field label="Sender display name" error={form.formState.errors.senderName?.message}>
        <input className={inputClass} {...form.register('senderName')} />
      </Field>
      <Field label="Subject" error={form.formState.errors.subject?.message}>
        <input className={inputClass} {...form.register('subject')} />
      </Field>
      <Field label="Message" error={form.formState.errors.body?.message}>
        <textarea className={`${inputClass} min-h-64 font-serif`} {...form.register('body')} />
      </Field>
      <Field label="Recipient limit" error={form.formState.errors.recipientLimit?.message}>
        <input className={inputClass} type="number" min={1} {...form.register('recipientLimit')} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register('selectEligible')} />
        Use never-contacted eligible contacts up to this limit
      </label>
      {selectEligible ? null : (
        <div className="max-h-64 overflow-auto border border-line bg-card">
          {contacts.map((contact) => (
            <label key={contact.id} className="flex gap-2 border-b border-line px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(contact.id)}
                onChange={(event) => {
                  setSelected((current) => event.target.checked ? [...current, contact.id] : current.filter((id) => id !== contact.id));
                }}
              />
              <span>{contactLabel(contact)}</span>
            </label>
          ))}
        </div>
      )}
      {selectEligible || user?.role !== 'admin' ? null : (
        <div className="border border-line bg-card p-4">
          <p className="text-sm">Previously contacted addresses stay out of a normal campaign. An administrator can add one only as an explicit follow-up. Suppression still blocks the address.</p>
          {showContacted ? null : (
            <Button
              className="mt-3"
              type="button"
              variant="secondary"
              onClick={() => {
                api.get<Page<Contact>>('/api/contacts?outreach=contacted&pageSize=50')
                  .then((response) => {
                    setContacted(response.data.rows);
                    setShowContacted(true);
                  })
                  .catch((reason) => setError(errorMessage(reason)));
              }}
            >
              Show previously contacted
            </Button>
          )}
          {showContacted ? (
            <div className="mt-3 max-h-64 overflow-auto border border-line">
              {contacted.map((contact) => (
                <label key={contact.id} className="flex gap-2 border-b border-line px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={followUpIds.includes(contact.id)}
                    onChange={(event) => {
                      if (!event.target.checked) {
                        setFollowUpIds((current) => current.filter((id) => id !== contact.id));
                        setSelected((current) => current.filter((id) => id !== contact.id));
                        return;
                      }
                      setPendingFollowUp(contact);
                      api.get<{ history: OutreachHistoryItem[] }>(`/api/contacts/${contact.id}/outreach`)
                        .then((response) => setFollowUpHistory(response.data.history))
                        .catch(() => setFollowUpHistory([]));
                    }}
                  />
                  <span>{contactLabel(contact)}</span>
                </label>
              ))}
              {contacted.length === 0 ? <p className="px-3 py-3 text-sm text-muted">No previously contacted addresses are available.</p> : null}
            </div>
          ) : null}
        </div>
      )}
      {pendingFollowUp ? (
        <Modal title="Add a follow-up recipient" onClose={() => setPendingFollowUp(null)}>
          <p className="text-sm leading-6">
            {pendingFollowUp.email} was already accepted by SES{pendingFollowUp.contactCount ? ` ${pendingFollowUp.contactCount} time${pendingFollowUp.contactCount === 1 ? '' : 's'}` : ''}.
            {pendingFollowUp.lastCampaignName ? ` Last campaign: ${pendingFollowUp.lastCampaignName}.` : ''} Adding this address sends another outreach message. It does not bypass suppression.
          </p>
          <ul className="mt-3 max-h-40 space-y-2 overflow-auto text-sm text-muted">
            {followUpHistory.slice(0, 5).map((item) => (
              <li key={item.recipientId}>{item.campaignName} · {item.subject} · {statusCaption(item.status)}</li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <Button
              type="button"
              onClick={() => {
                setFollowUpIds((current) => current.includes(pendingFollowUp.id) ? current : [...current, pendingFollowUp.id]);
                setSelected((current) => current.includes(pendingFollowUp.id) ? current : [...current, pendingFollowUp.id]);
                setPendingFollowUp(null);
              }}
            >
              Add as follow-up
            </Button>
            <Button type="button" variant="secondary" onClick={() => setPendingFollowUp(null)}>Cancel</Button>
          </div>
        </Modal>
      ) : null}
      {error ? <p className="text-sm text-bad">{error}</p> : null}
      <Button type="submit" disabled={form.formState.isSubmitting}>Create draft</Button>
    </form>
  );
}

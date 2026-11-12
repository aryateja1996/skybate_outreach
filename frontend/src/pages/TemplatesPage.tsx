import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, errorMessage } from '../api/client';
import { Banner, Button, Field, inputClass } from '../components/ui';
import type { Template } from '../types';

const schema = z.object({
  purpose: z.string().trim().min(10, 'Describe the campaign purpose.'),
  style: z.enum(['professional', 'concise', 'formal']),
  name: z.string().trim().min(3, 'Name the template before saving.'),
  subject: z.string().trim().min(3, 'Enter a subject.'),
  body: z.string().trim().min(20, 'Enter a message.'),
});

type FormValues = z.infer<typeof schema>;

const previewContact = {
  contact_name: 'Mira Patel',
  company_name: 'Northwind Analytics',
};

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { purpose: '', style: 'professional', name: '', subject: '', body: '' },
  });
  const body = form.watch('body');
  const subject = form.watch('subject');

  function load() {
    api.get<{ rows: Template[] }>('/api/templates').then((response) => setTemplates(response.data.rows)).catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  const previewBody = body
    .replaceAll('{{contact_name}}', previewContact.contact_name)
    .replaceAll('{{company_name}}', previewContact.company_name);

  return (
    <div className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit(async (values) => {
          setError('');
          try {
            await api.post('/api/templates', {
              name: values.name,
              style: values.style,
              subject: values.subject,
              body: values.body,
            });
            setNotice('Template saved. It can be selected when creating a campaign. Saving does not send email.');
            load();
          } catch (reason) {
            setError(errorMessage(reason));
          }
        })}
      >
        <h2 className="font-serif text-4xl">AI email writer</h2>
        <p className="text-sm text-muted">Generated text stays editable. It is not sent. If AI is unavailable, the standard Skybate template is used.</p>
        <Field label="Campaign purpose" error={form.formState.errors.purpose?.message}>
          <textarea className={`${inputClass} min-h-24`} {...form.register('purpose')} />
        </Field>
        <Field label="Style">
          <select className={inputClass} {...form.register('style')}>
            <option value="professional">Professional</option>
            <option value="concise">Concise</option>
            <option value="formal">Formal</option>
          </select>
        </Field>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setError('');
            api.post('/api/templates/generate', { purpose: form.getValues('purpose'), style: form.getValues('style') })
              .then((response) => {
                form.setValue('subject', response.data.subject);
                form.setValue('body', response.data.body);
                setNotice(response.data.notice);
              })
              .catch((reason) => setError(errorMessage(reason)));
          }}
        >
          Generate draft
        </Button>
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        <Field label="Template name" error={form.formState.errors.name?.message}>
          <input className={inputClass} {...form.register('name')} />
        </Field>
        <Field label="Subject" error={form.formState.errors.subject?.message}>
          <input className={inputClass} {...form.register('subject')} />
        </Field>
        <Field label="Message" error={form.formState.errors.body?.message}>
          <textarea className={`${inputClass} min-h-72 font-serif`} {...form.register('body')} />
        </Field>
        {error ? <p className="text-sm text-bad">{error}</p> : null}
        <Button type="submit">Save template</Button>
      </form>
      <aside>
        <h3 className="font-serif text-2xl">Personalization preview</h3>
        <p className="mt-2 text-sm text-muted">Sample only: {previewContact.contact_name} at {previewContact.company_name}. Missing names render as Hello.</p>
        <article className="mt-4 bg-card p-4 shadow-card">
          <p className="text-sm font-medium">{subject.replaceAll('{{company_name}}', previewContact.company_name) || 'Subject preview'}</p>
          <pre className="mt-3 whitespace-pre-wrap font-serif text-sm leading-6">{previewBody || 'The message preview appears here.'}</pre>
        </article>
        <h3 className="mt-8 font-serif text-2xl">Saved templates</h3>
        <div className="mt-3 space-y-2">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className="block w-full bg-card p-3 text-left shadow-card"
              onClick={() => {
                form.setValue('name', template.name);
                form.setValue('subject', template.subject);
                form.setValue('body', template.body);
                form.setValue('style', template.style as FormValues['style']);
              }}
            >
              <span className="font-medium">{template.name}</span>
              <span className="mt-1 block text-xs text-muted">{template.style}{template.aiGenerated ? ' · AI' : ''}</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

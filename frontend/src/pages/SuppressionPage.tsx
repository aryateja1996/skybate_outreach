import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, errorMessage } from '../api/client';
import { Button, Field, inputClass } from '../components/ui';
import type { Page, Suppression } from '../types';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email.'),
  reason: z.enum(['manual', 'unsubscribe', 'hard_bounce', 'complaint']),
  notes: z.string().trim().max(500).optional(),
});

type FormValues = z.infer<typeof schema>;

export function SuppressionPage() {
  const [data, setData] = useState<Page<Suppression> | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [liftEmail, setLiftEmail] = useState<Record<number, string>>({});
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', reason: 'manual', notes: '' },
  });

  function load(query = search) {
    const params = new URLSearchParams({ page: '1', pageSize: '50' });
    if (query) params.set('search', query);
    api.get<Page<Suppression>>(`/api/suppression?${params.toString()}`)
      .then((response) => setData(response.data))
      .catch((reason) => setError(errorMessage(reason)));
  }

  useEffect(() => { load(''); }, []);

  return (
    <div className="max-w-4xl">
      <h2 className="font-serif text-4xl">Suppression</h2>
      <p className="mt-2 text-sm text-muted">Suppressed addresses are checked again before every send. Campaign actions cannot turn a suppression back on.</p>
      <form
        className="mt-6 grid gap-3 md:grid-cols-[1fr_12rem_auto]"
        onSubmit={(event) => { event.preventDefault(); load(); }}
      >
        <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search email" />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <form
        className="mt-6 grid gap-3 md:grid-cols-2"
        onSubmit={form.handleSubmit(async (values) => {
          setError('');
          try {
            await api.post('/api/suppression', values);
            form.reset({ email: '', reason: 'manual', notes: '' });
            load();
          } catch (reason) {
            setError(errorMessage(reason));
          }
        })}
      >
        <Field label="Email" error={form.formState.errors.email?.message}>
          <input className={inputClass} {...form.register('email')} />
        </Field>
        <Field label="Reason">
          <select className={inputClass} {...form.register('reason')}>
            <option value="manual">Manual</option>
            <option value="unsubscribe">Unsubscribe</option>
            <option value="hard_bounce">Hard bounce</option>
            <option value="complaint">Complaint</option>
          </select>
        </Field>
        <Field label="Notes">
          <input className={inputClass} {...form.register('notes')} />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Suppress address</Button>
        </div>
      </form>
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      <div className="mt-6 space-y-3">
        {data?.rows.map((row) => (
          <article key={row.id} className="bg-card p-4 shadow-card">
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{row.emailNormalized}</strong>
              <span className="text-sm text-muted">{row.reason} · {row.active ? 'active' : 'lifted'}</span>
            </div>
            {row.notes ? <p className="mt-2 text-sm text-muted">{row.notes}</p> : null}
            {row.active ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  className={`${inputClass} max-w-sm`}
                  placeholder="Type the email to lift"
                  value={liftEmail[row.id] ?? ''}
                  onChange={(event) => setLiftEmail((current) => ({ ...current, [row.id]: event.target.value }))}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    api.post(`/api/suppression/${row.id}/lift`, { confirmEmail: liftEmail[row.id] ?? '' })
                      .then(() => load())
                      .catch((reason) => setError(errorMessage(reason)));
                  }}
                >
                  Lift suppression
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

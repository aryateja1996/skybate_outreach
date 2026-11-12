import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Button, Field, inputClass } from '../components/ui';
import type { SchedulerDashboard, Template } from '../types';

const DAY_OPTIONS = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [7, 'Sunday'],
] as const;

const STATUS_LABEL = {
  disabled: 'Disabled',
  enabled: 'Enabled',
  paused: 'Paused',
  completed: 'Completed',
} as const;

function formatWhen(value: string | null, timeZone: string): string {
  if (!value) return 'None';
  return new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function SchedulerPage() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<SchedulerDashboard | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dailyLimit, setDailyLimit] = useState('20');
  const [executionTime, setExecutionTime] = useState('10:00');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [templateId, setTemplateId] = useState('');
  const [aiPersonalization, setAiPersonalization] = useState(false);
  const [startDate, setStartDate] = useState('');

  function applyDashboard(next: SchedulerDashboard) {
    setDashboard(next);
    setDailyLimit(String(next.settings.dailyLimit));
    setExecutionTime(next.settings.executionTime);
    setTimezone(next.settings.timezone);
    setWorkingDays(next.settings.workingDays);
    setTemplateId(next.settings.templateId ? String(next.settings.templateId) : '');
    setAiPersonalization(next.settings.aiPersonalization);
    setStartDate(next.settings.startDate ?? '');
  }

  function load() {
    api.get<SchedulerDashboard>('/api/scheduler')
      .then((response) => applyDashboard(response.data))
      .catch((reason) => setError(errorMessage(reason)));
    api.get<{ rows: Template[] }>('/api/templates')
      .then((response) => setTemplates(response.data.rows))
      .catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setError('');
    setNotice('');
    try {
      await api.put('/api/scheduler', {
        dailyLimit: Number(dailyLimit),
        executionTime,
        workingDays,
        timezone: timezone.trim(),
        templateId: templateId ? Number(templateId) : null,
        aiPersonalization,
        startDate: startDate || null,
      });
      setNotice('Schedule saved.');
      load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function act(path: string) {
    setError('');
    setNotice('');
    try {
      const response = await api.post(path);
      setNotice(response.data?.message ?? 'Scheduler updated.');
      load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (user && user.role !== 'admin') {
    return <p className="text-sm text-bad">Only an administrator can manage the daily scheduler.</p>;
  }

  const settings = dashboard?.settings;
  const zone = settings?.timezone || 'Asia/Kolkata';

  return (
    <div className="max-w-5xl">
      <h2 className="font-serif text-4xl">Daily scheduler</h2>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Upload the full prospect file once. On each working day the scheduler takes the next eligible contacts, up to the daily limit, and records a separate campaign. A dry-run moves past simulated contacts without marking them as reached. Those prospects stay eligible for a later live send unless an SMTP acceptance, suppression, or ambiguous live attempt already blocks them.
      </p>
      {dashboard?.completionMessage ? <div className="mt-4"><Banner tone="info">{dashboard.completionMessage}</Banner></div> : null}
      {error ? <p className="mt-4 text-sm text-bad">{error}</p> : null}
      {notice ? <p className="mt-4 text-sm text-tide">{notice}</p> : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Status', settings ? STATUS_LABEL[settings.status] : '—'],
          ['Daily limit', settings ? String(settings.dailyLimit) : '—'],
          ['Next execution', dashboard ? formatWhen(dashboard.nextRunAt, zone) : '—'],
          ['Remaining eligible', dashboard ? String(dashboard.remainingEligible) : '—'],
          ['Eligible contacts', dashboard ? String(dashboard.eligibleContacts) : '—'],
          ['Successfully contacted', dashboard ? String(dashboard.successfullyContacted) : '—'],
          ["Today's batches", dashboard ? String(dashboard.todayBatchCount) : '—'],
          ["Today's recipients", dashboard ? String(dashboard.todayRecipientCount) : '—'],
        ].map(([label, value]) => (
          <article key={label} className="bg-card p-4 shadow-card">
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-2 font-serif text-3xl">{value}</p>
          </article>
        ))}
      </div>

      {dashboard ? (
        <p className="mt-4 text-sm text-muted">
          {settings?.workingDays.map((day) => DAY_OPTIONS.find(([value]) => value === day)?.[1]).filter(Boolean).join(', ')}
          {' at '}{settings?.executionTime} {zone}. Today: {dashboard.today.simulated} simulated, {dashboard.today.accepted} accepted, {dashboard.today.delivered} delivered, {dashboard.today.bounced} bounced, {dashboard.today.complained} complained, {dashboard.today.failed} failed.
          {dashboard.lastSuccessAt ? ` Last success ${formatWhen(dashboard.lastSuccessAt, zone)}.` : ''}
          {dashboard.lastError ? ` Last error: ${dashboard.lastError}` : ''}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="button" onClick={() => void act('/api/scheduler/enable')}>Enable</Button>
        <Button type="button" variant="secondary" onClick={() => void act('/api/scheduler/pause')}>Pause</Button>
        <Button type="button" variant="secondary" onClick={() => void act('/api/scheduler/resume')}>Resume</Button>
        <Button type="button" variant="danger" onClick={() => void act('/api/scheduler/stop')}>Stop</Button>
        <Button type="button" onClick={() => void act('/api/scheduler/run')}>Run dry-run batch now</Button>
      </div>

      <form className="mt-8 grid gap-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="Daily limit">
          <input className={inputClass} value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Execution time">
          <input className={inputClass} type="time" value={executionTime} onChange={(event) => setExecutionTime(event.target.value)} />
        </Field>
        <Field label="Timezone">
          <input className={inputClass} value={timezone} onChange={(event) => setTimezone(event.target.value)} />
        </Field>
        <Field label="Start date">
          <input className={inputClass} type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </Field>
        <Field label="Email template">
          <select className={inputClass} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">Default template</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={aiPersonalization} onChange={(event) => setAiPersonalization(event.target.checked)} />
          Use AI personalization
        </label>
        <fieldset className="md:col-span-2">
          <legend className="mb-2 text-sm text-muted">Working days</legend>
          <div className="flex flex-wrap gap-3">
            {DAY_OPTIONS.map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={workingDays.includes(value)}
                  onChange={(event) => {
                    setWorkingDays((current) => event.target.checked ? [...current, value].sort() : current.filter((day) => day !== value));
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <Button type="submit">Save schedule</Button>
        </div>
      </form>

      <h3 className="mt-10 font-serif text-2xl">Execution history</h3>
      <div className="mt-4 space-y-3">
        {dashboard?.history.length ? dashboard.history.map((run) => (
          <article key={run.id} className="bg-card p-4 shadow-card text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{run.scheduledDate} · batch {run.batchNumber}</strong>
              <span className="text-muted">{run.status} · {run.trigger} · {run.selectedCount} contacts</span>
            </div>
            {run.campaignId ? <Link className="mt-2 inline-block text-copper" to={`/campaigns/${run.campaignId}`}>Open campaign {run.campaignId}</Link> : null}
            {run.errorMessage ? <p className="mt-2 text-bad">{run.errorMessage}</p> : null}
          </article>
        )) : <p className="text-sm text-muted">No scheduler batches yet.</p>}
      </div>
    </div>
  );
}

import type { FailureClass, RecipientStatus, SchedulerSettings } from '../types';

export function defaultSchedulerSettings(): SchedulerSettings {
  return {
    status: 'disabled',
    dailyLimit: DEFAULT_DAILY_LIMIT,
    executionTime: DEFAULT_EXECUTION_TIME,
    workingDays: [...DEFAULT_WORKING_DAYS],
    timezone: DEFAULT_TIMEZONE,
    templateId: null,
    aiPersonalization: false,
    startDate: null,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    lastSuccessAt: null,
    updatedBy: null,
  };
}

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_EXECUTION_TIME = '10:00';
export const DEFAULT_DAILY_LIMIT = 20;
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

const OPEN_STATUSES = new Set<RecipientStatus>(['pending', 'sending', 'retry_wait']);
const SMTP_ACCEPTED_STATUSES = new Set<RecipientStatus>(['accepted', 'delivered', 'bounced', 'complained']);

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  dateKey: string;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const bag = Object.fromEntries(formatted.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const hour = Number(bag.hour);
  const month = bag.month;
  const day = bag.day;
  return {
    year: Number(bag.year),
    month: Number(month),
    day: Number(day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(bag.minute),
    weekday: WEEKDAY_INDEX[bag.weekday] ?? 0,
    dateKey: `${bag.year}-${month}-${day}`,
  };
}

export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const seen = zonedParts(guess, timeZone);
  const got = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  return new Date(guess.getTime() + (wanted - got));
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function scheduledInstant(dateKey: string, executionTime: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = executionTime.split(':').map(Number);
  return zonedDateTimeToUtc(year, month, day, hour, minute, timeZone);
}

export function executionInstant(
  now: Date,
  settings: Pick<SchedulerSettings, 'executionTime' | 'timezone'>,
): Date {
  const parts = zonedParts(now, settings.timezone);
  return scheduledInstant(parts.dateKey, settings.executionTime, settings.timezone);
}

export function dayBounds(now: Date, timeZone: string): { start: Date; end: Date; dateKey: string } {
  const parts = zonedParts(now, timeZone);
  const start = zonedDateTimeToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone);
  const next = addCalendarDays(parts.year, parts.month, parts.day, 1);
  const end = zonedDateTimeToUtc(next.year, next.month, next.day, 0, 0, timeZone);
  return { start, end, dateKey: parts.dateKey };
}

export function nextRunAt(
  now: Date,
  settings: Pick<SchedulerSettings, 'executionTime' | 'workingDays' | 'timezone' | 'startDate'>,
  options?: { afterDate?: string },
): Date | null {
  if (settings.workingDays.length === 0) return null;
  const parts = zonedParts(now, settings.timezone);
  let cursor = { year: parts.year, month: parts.month, day: parts.day };
  for (let step = 0; step < 21; step += 1) {
    const dateKey = `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(cursor.day).padStart(2, '0')}`;
    const instant = scheduledInstant(dateKey, settings.executionTime, settings.timezone);
    const weekday = zonedParts(instant, settings.timezone).weekday;
    const starts = !settings.startDate || dateKey >= settings.startDate;
    const afterPrevious = !options?.afterDate || dateKey > options.afterDate;
    if (settings.workingDays.includes(weekday) && starts && afterPrevious && instant.getTime() > now.getTime()) {
      return instant;
    }
    cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1);
  }
  return null;
}

export function isScheduledMomentDue(
  now: Date,
  settings: Pick<SchedulerSettings, 'status' | 'executionTime' | 'workingDays' | 'timezone' | 'startDate'>,
  alreadyRan: boolean,
): boolean {
  if (settings.status !== 'enabled' || alreadyRan) return false;
  const parts = zonedParts(now, settings.timezone);
  if (!settings.workingDays.includes(parts.weekday)) return false;
  if (settings.startDate && parts.dateKey < settings.startDate) return false;
  const instant = scheduledInstant(parts.dateKey, settings.executionTime, settings.timezone);
  return now.getTime() >= instant.getTime();
}

export function validateSchedulerConfig(input: {
  dailyLimit: number;
  executionTime: string;
  workingDays: number[];
  timezone: string;
  startDate: string | null;
  maxDailyLimit: number;
}): string | null {
  if (!Number.isInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > input.maxDailyLimit) {
    return `Daily limit must be a whole number from 1 to ${input.maxDailyLimit}.`;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.executionTime)) {
    return 'Execution time must use 24-hour HH:MM.';
  }
  if (!isValidTimeZone(input.timezone)) return 'Timezone must be a valid IANA timezone.';
  const days = [...new Set(input.workingDays)];
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    return 'Choose at least one working day.';
  }
  if (input.startDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    return 'Start date must use YYYY-MM-DD.';
  }
  return null;
}

export type OutreachBlockReason = 'open' | 'simulated' | 'accepted' | 'ambiguous';

const BLOCK_RANK: Record<OutreachBlockReason, number> = {
  open: 4,
  ambiguous: 3,
  accepted: 2,
  simulated: 1,
};

export function outreachBlockReason(input: {
  status: RecipientStatus;
  failureClass: FailureClass;
  campaignDryRun: boolean;
  mode: 'dry_run' | 'live';
}): OutreachBlockReason | null {
  if (OPEN_STATUSES.has(input.status)) return 'open';
  if (SMTP_ACCEPTED_STATUSES.has(input.status)) return 'accepted';
  if (input.mode === 'dry_run' && input.status === 'simulated') return 'simulated';
  if (input.failureClass === 'ambiguous' && (input.mode === 'dry_run' || !input.campaignDryRun)) return 'ambiguous';
  return null;
}

export function strongerOutreachBlock(
  current: OutreachBlockReason | null,
  next: OutreachBlockReason,
): OutreachBlockReason {
  if (!current || BLOCK_RANK[next] > BLOCK_RANK[current]) return next;
  return current;
}

export function recipientBlocksScheduler(input: {
  status: RecipientStatus;
  failureClass: FailureClass;
  campaignDryRun: boolean;
  mode: 'dry_run' | 'live';
}): boolean {
  return outreachBlockReason(input) !== null;
}

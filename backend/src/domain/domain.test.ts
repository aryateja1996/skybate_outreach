import { describe, expect, it } from 'vitest';
import { validateAiDraft } from './aiDraft';
import { canTransition } from './campaignState';
import { DEFAULT_BODY } from './defaultTemplate';
import { isValidEmail, normalizeEmail } from './email';
import { sanitizeExportCell } from './exportSafety';
import { analyzeImportRows } from './importAnalyze';
import { personalize } from './personalize';
import { classifySendError, decideRetry } from './retryPolicy';
import { evaluateSendGuards } from './sendGuards';
import { eventIdempotencyKey, nextStatusForEvent, parseSesMessage, suppressionForEvent } from './sesEvents';
import { isSafeSnsSubscribeUrl } from '../services/sns';

const baseGuard = {
  mode: 'dry_run' as const,
  campaignStatus: 'approved' as const,
  hasApproval: true,
  recipientCount: 2,
  recipientLimit: 10,
  suppressedInCampaign: 0,
  ineligibleInCampaign: 0,
  sendRatePerSecond: 1,
  configuredMaxSendRate: 1,
  batchSize: 5,
  configuredMaxBatchSize: 5,
  sesHost: '',
  sesPort: 587,
  sesUser: '',
  sesPassword: '',
  sesFromEmail: 'sreekar.k@skybate.in',
  sesFromName: 'Sreekar Kondaveeti',
  senderEmail: 'sreekar.k@skybate.in',
  accountApproved: false,
  liveConfirmationPresent: false,
  sendingEnabled: false,
  dryRunFlag: true,
};

describe('email and personalization', () => {
  it('normalizes and rejects invalid addresses', () => {
    expect(normalizeEmail('  Mira@Example.com ')).toBe('mira@example.com');
    expect(isValidEmail('mira.patel@northwind.example')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  it('uses a neutral greeting when the contact name is missing', () => {
    const text = personalize(DEFAULT_BODY, { contactName: ' ', companyName: '' });
    expect(text.startsWith('Hello,')).toBe(true);
    expect(text).toContain('your organization');
    expect(text).not.toContain('{{');
    expect(text).not.toMatch(/\bPriya\b/);
  });

  it('keeps a provided name and company', () => {
    const text = personalize('Hi {{contact_name}},\n\n{{company_name}}', {
      contactName: 'Mira Patel',
      companyName: 'Northwind Analytics',
    });
    expect(text).toContain('Hi Mira Patel,');
    expect(text).toContain('Northwind Analytics');
  });
});

describe('import analysis', () => {
  it('flags duplicates, invalid emails, and missing names', () => {
    const result = analyzeImportRows({
      rows: [
        { rowNumber: 2, email: 'Mira@Example.com', contactName: 'Mira', companyName: 'Northwind', designation: '', website: '', source: '' },
        { rowNumber: 3, email: 'mira@example.com', contactName: 'Mira', companyName: 'Northwind', designation: '', website: '', source: '' },
        { rowNumber: 4, email: 'not-an-email', contactName: '', companyName: 'Contoso', designation: '', website: '', source: '' },
        { rowNumber: 5, email: '', contactName: 'No Email', companyName: 'Fabrikam', designation: '', website: '', source: '' },
        { rowNumber: 6, email: 'known@example.com', contactName: 'Known', companyName: 'Litware', designation: '', website: '', source: '' },
      ],
      existingEmails: new Set(['known@example.com']),
      suppressedEmails: new Set(),
    });
    expect(result.rows.map((row) => row.action)).toEqual([
      'insert',
      'skip_duplicate',
      'insert_invalid',
      'skip_missing_email',
      'skip_duplicate',
    ]);
    expect(result.summary.duplicateInFile).toBe(1);
    expect(result.summary.duplicateInDatabase).toBe(1);
    expect(result.summary.invalidEmail).toBe(1);
    expect(result.summary.missingName).toBe(1);
    expect(result.summary.missingEmail).toBe(1);
  });
});

describe('sending policy', () => {
  it('requires approval before a dry run can start', () => {
    const result = evaluateSendGuards({ ...baseGuard, campaignStatus: 'draft', hasApproval: false });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/approved/i);
  });

  it('blocks live sending when SES checks are incomplete', () => {
    const result = evaluateSendGuards({ ...baseGuard, mode: 'live' });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/credentials|confirmation|approved/i);
  });

  it('blocks suppressed recipients', () => {
    const result = evaluateSendGuards({ ...baseGuard, suppressedInCampaign: 2 });
    expect(result.ok).toBe(false);
  });

  it('does not retry permanent or ambiguous failures, and stops at the attempt limit', () => {
    expect(classifySendError({ responseCode: 550 })).toBe('permanent');
    expect(classifySendError({ code: 'ETIMEDOUT' })).toBe('ambiguous');
    expect(classifySendError({ responseCode: 450 })).toBe('transient');
    expect(decideRetry({ attempt: 1, maxAttempts: 3, classification: 'permanent', baseDelaySeconds: 30 }).action).toBe('fail');
    expect(decideRetry({ attempt: 1, maxAttempts: 3, classification: 'ambiguous', baseDelaySeconds: 30 }).action).toBe('fail');
    expect(decideRetry({ attempt: 1, maxAttempts: 3, classification: 'transient', baseDelaySeconds: 0 })).toEqual({ action: 'retry', delaySeconds: 0 });
    expect(decideRetry({ attempt: 3, maxAttempts: 3, classification: 'transient', baseDelaySeconds: 0 }).action).toBe('fail');
  });

  it('refuses to start a draft or send an unapproved campaign', () => {
    expect(canTransition('draft', 'start')).toBe(false);
    expect(canTransition('previewed', 'approve')).toBe(true);
    expect(canTransition('approved', 'start')).toBe(true);
    expect(canTransition('sending', 'pause')).toBe(true);
    expect(canTransition('paused', 'cancel')).toBe(true);
  });
});

describe('SES events and exports', () => {
  it('maps each SES notification onto recipient status without treating delay as delivery', () => {
    const base = {
      mail: { messageId: '<abc@example.com>', timestamp: '2026-01-01T00:00:00.000Z', destination: ['a@b.example'] },
    };
    const send = parseSesMessage({ eventType: 'Send', ...base });
    const delivery = parseSesMessage({ eventType: 'Delivery', ...base, delivery: { timestamp: '2026-01-01T00:00:01.000Z', recipients: ['a@b.example'] } });
    const permanent = parseSesMessage({ eventType: 'Bounce', ...base, bounce: { bounceType: 'Permanent', timestamp: '2026-01-01T00:00:02.000Z', bouncedRecipients: [{ emailAddress: 'a@b.example' }] } });
    const transient = parseSesMessage({ eventType: 'Bounce', ...base, bounce: { bounceType: 'Transient', timestamp: '2026-01-01T00:00:02.000Z', bouncedRecipients: [{ emailAddress: 'a@b.example' }] } });
    const complaint = parseSesMessage({ eventType: 'Complaint', ...base, complaint: { timestamp: '2026-01-01T00:00:03.000Z', complainedRecipients: [{ emailAddress: 'a@b.example' }] } });
    const reject = parseSesMessage({ eventType: 'Reject', ...base });
    const rendering = parseSesMessage({ eventType: 'Rendering Failure', ...base });
    const delay = parseSesMessage({
      eventType: 'DeliveryDelay',
      ...base,
      deliveryDelay: {
        delayType: 'MailboxFull',
        timestamp: '2026-01-01T00:00:04.000Z',
        delayedRecipients: [{ emailAddress: 'a@b.example', diagnosticCode: 'mailbox full' }],
      },
    });
    expect(send?.eventType).toBe('send');
    expect(nextStatusForEvent('pending', send!)).toBe('accepted');
    expect(delivery?.eventType).toBe('delivery');
    expect(nextStatusForEvent('accepted', delivery!)).toBe('delivered');
    expect(nextStatusForEvent('delivered', send!)).toBeNull();
    expect(permanent?.bounceType).toBe('Permanent');
    expect(nextStatusForEvent('delivered', permanent!)).toBe('bounced');
    expect(suppressionForEvent(permanent!)).toBe('hard_bounce');
    expect(nextStatusForEvent('accepted', transient!)).toBeNull();
    expect(suppressionForEvent(transient!)).toBeNull();
    expect(nextStatusForEvent('delivered', complaint!)).toBe('complained');
    expect(suppressionForEvent(complaint!)).toBe('complaint');
    expect(nextStatusForEvent('accepted', reject!)).toBe('failed');
    expect(nextStatusForEvent('accepted', rendering!)).toBe('failed');
    expect(delay?.eventType).toBe('delivery_delay');
    expect(delay?.delayType).toBe('MailboxFull');
    expect(nextStatusForEvent('accepted', delay!)).toBeNull();
    expect(suppressionForEvent(delay!)).toBeNull();
    expect(eventIdempotencyKey(delay!)).toBe(eventIdempotencyKey({ ...delay! }));
  });

  it('parses a delivery and does not downgrade it when a send event arrives later', () => {
    const delivery = parseSesMessage({
      eventType: 'Delivery',
      mail: { messageId: '<ABC@example.com>', timestamp: '2026-01-01T00:00:00.000Z', destination: ['a@b.example'] },
      delivery: { timestamp: '2026-01-01T00:00:01.000Z', recipients: ['a@b.example'] },
    });
    expect(delivery?.eventType).toBe('delivery');
    expect(nextStatusForEvent('accepted', delivery!)).toBe('delivered');
    const send = { ...delivery!, eventType: 'send' as const };
    expect(nextStatusForEvent('delivered', send)).toBeNull();
    expect(eventIdempotencyKey(delivery!)).toBe(eventIdempotencyKey({ ...delivery! }));
  });

  it('prefixes spreadsheet formulas during export', () => {
    expect(sanitizeExportCell('=HYPERLINK("http://evil.example")')).toBe(`'=HYPERLINK("http://evil.example")`);
    expect(sanitizeExportCell('Mira')).toBe('Mira');
  });

  it('rejects AI drafts that invent achievements', () => {
    const problem = validateAiDraft(
      'Partnership with {{company_name}}',
      'Hi {{contact_name}}, Skybate has placed 500 engineers for Fortune 100 clients and would like to partner with {{company_name}}. https://skybate.in',
      'sreekar.k@skybate.in',
    );
    expect(problem).toBe('fabricated_claim');
  });

  it('accepts only AWS SNS certificate and subscribe URLs', () => {
    expect(isSafeSnsSubscribeUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription')).toBe(true);
    expect(isSafeSnsSubscribeUrl('https://example.com/confirm')).toBe(false);
    expect(isSafeSnsSubscribeUrl('http://sns.us-east-1.amazonaws.com/confirm')).toBe(false);
  });
});

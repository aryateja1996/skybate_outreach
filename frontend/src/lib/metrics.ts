import type { SendingMode } from '../types';

export function modeLabel(mode: SendingMode): string {
  return mode === 'live' ? 'Live sending' : 'Dry run';
}

export function statusCaption(status: string): string {
  switch (status) {
    case 'simulated':
      return 'Simulated. No email was sent.';
    case 'accepted':
      return 'SES accepted the message. Inbox delivery is not confirmed.';
    case 'delivered':
      return 'Delivery confirmed by SES.';
    case 'bounced':
      return 'Bounced.';
    case 'complained':
      return 'Complaint recorded. The address is suppressed.';
    case 'suppressed':
      return 'Not sent. The address is suppressed.';
    case 'failed':
      return 'Sending failed and was not blindly retried.';
    case 'pending':
      return 'Waiting to send.';
    case 'cancelled':
      return 'Cancelled before send.';
    default:
      return status.replaceAll('_', ' ');
  }
}

export function metricNote(key: string, mode: SendingMode): string {
  if (key === 'simulatedResults') return 'Dry-run outcomes. These are not deliveries.';
  if (key === 'acceptedByProvider') return 'Provider accepted the submission. This is not inbox confirmation.';
  if (key === 'confirmedDeliveries') return 'Counted only after a SES delivery event.';
  if (key === 'duplicateContacts') return 'Duplicate rows skipped during import.';
  if (key === 'neverContacted') return 'Eligible addresses with no SMTP-accepted outreach.';
  if (key === 'previouslyContacted') return 'SMTP-accepted at least once. Suppressed addresses are counted separately.';
  if (key === 'failedSends') return 'SMTP failures. Simulated dry-run rows are not included.';
  if (mode === 'dry_run' && key === 'sendingAttempts') return 'Includes simulated attempts.';
  return '';
}

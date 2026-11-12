import type { CampaignStatus } from '../types';

export interface GuardInput {
  mode: 'dry_run' | 'live';
  campaignStatus: CampaignStatus;
  hasApproval: boolean;
  recipientCount: number;
  recipientLimit: number;
  suppressedInCampaign: number;
  ineligibleInCampaign: number;
  sendRatePerSecond: number;
  configuredMaxSendRate: number;
  batchSize: number;
  configuredMaxBatchSize: number;
  sesHost: string;
  sesPort: number;
  sesUser: string;
  sesPassword: string;
  sesFromEmail: string;
  sesFromName: string;
  senderEmail: string;
  accountApproved: boolean;
  liveConfirmationPresent: boolean;
  sendingEnabled: boolean;
  dryRunFlag: boolean;
}

export function evaluateSendGuards(input: GuardInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  if (input.campaignStatus !== 'approved' && input.campaignStatus !== 'paused') {
    failures.push('Campaign must be approved before sending can start.');
  }
  if (!input.hasApproval) {
    failures.push('Campaign approval is missing.');
  }
  if (input.recipientCount < 1) {
    failures.push('Campaign has no recipients.');
  }
  if (!Number.isInteger(input.recipientLimit) || input.recipientLimit < 1) {
    failures.push('Campaign is missing an explicit recipient limit.');
  }
  if (input.recipientCount > input.recipientLimit) {
    failures.push('Recipient count exceeds the campaign recipient limit.');
  }
  if (input.suppressedInCampaign > 0) {
    failures.push(`${input.suppressedInCampaign} recipient(s) are on the suppression list.`);
  }
  if (input.ineligibleInCampaign > 0) {
    failures.push(`${input.ineligibleInCampaign} recipient(s) are not eligible for outreach.`);
  }
  if (!(input.sendRatePerSecond > 0) || input.sendRatePerSecond > input.configuredMaxSendRate) {
    failures.push('Sending rate is outside the configured SES limit.');
  }
  if (input.batchSize < 1 || input.batchSize > input.configuredMaxBatchSize) {
    failures.push('Batch size is outside the configured limit.');
  }

  if (input.mode === 'live') {
    if (input.dryRunFlag) failures.push('Dry-run is still enabled.');
    if (!input.sendingEnabled) failures.push('Real sending is not enabled.');
    if (!input.liveConfirmationPresent) failures.push('Live sending confirmation is missing.');
    if (!input.sesHost || !input.sesPort || !input.sesUser || !input.sesPassword) {
      failures.push('SES SMTP credentials are incomplete.');
    }
    if (!input.sesFromEmail || !input.sesFromName) {
      failures.push('Sender identity is not configured.');
    }
    if (input.senderEmail.toLowerCase() !== input.sesFromEmail.toLowerCase()) {
      failures.push('Campaign sender address does not match the configured SES identity.');
    }
    if (!input.accountApproved) {
      failures.push('SES account is not marked approved for the intended recipients.');
    }
  }

  return { ok: failures.length === 0, failures };
}

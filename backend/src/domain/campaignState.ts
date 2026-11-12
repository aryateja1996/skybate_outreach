import type { CampaignStatus } from '../types';

export type CampaignAction = 'preview' | 'approve' | 'start' | 'pause' | 'cancel' | 'edit';

const ALLOWED: Record<CampaignStatus, CampaignAction[]> = {
  draft: ['preview', 'edit', 'cancel'],
  previewed: ['preview', 'edit', 'approve', 'cancel'],
  approved: ['start', 'cancel'],
  sending: ['pause', 'cancel'],
  paused: ['start', 'cancel'],
  completed: [],
  cancelled: [],
  failed: [],
};

export function canTransition(from: CampaignStatus, action: CampaignAction): boolean {
  return ALLOWED[from].includes(action);
}

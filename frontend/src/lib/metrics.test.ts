import { describe, expect, it } from 'vitest';
import { metricNote, modeLabel, statusCaption } from './metrics';

describe('outreach labels', () => {
  it('labels dry-run separately from live sending', () => {
    expect(modeLabel('dry_run')).toBe('Dry run');
    expect(modeLabel('live')).toBe('Live sending');
  });

  it('does not describe provider acceptance as confirmed delivery', () => {
    expect(statusCaption('accepted')).toMatch(/not confirmed/i);
    expect(statusCaption('delivered')).toMatch(/confirmed/i);
    expect(statusCaption('simulated')).toMatch(/no email was sent/i);
  });

  it('explains simulated and duplicate metrics', () => {
    expect(metricNote('simulatedResults', 'dry_run')).toMatch(/not deliveries/i);
    expect(metricNote('duplicateContacts', 'dry_run')).toMatch(/skipped/i);
    expect(metricNote('confirmedDeliveries', 'live')).toMatch(/delivery event/i);
  });
});

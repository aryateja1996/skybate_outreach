import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';
import { DEFAULT_BODY, DEFAULT_SUBJECT } from '../domain/defaultTemplate';
import { MemoryStore } from '../store/memory';
import { aiFailureDetails, generateDraft } from './ai';

const config = {
  nodeEnv: 'development',
  openAiApiKey: 'sk-proj-test-secret-value',
  openAiModel: 'gpt-4o-mini',
  sesFromEmail: 'sales@skybate.in',
} as AppConfig;

describe('OpenAI failure details', () => {
  it('classifies an exhausted credit balance without keeping the API key', () => {
    const error = Object.assign(new Error('429 No credits. Key sk-proj-test-secret-value was rejected.'), {
      status: 429,
      code: 'credit_balance_exhausted',
      type: 'insufficient_quota',
    });
    const details = aiFailureDetails(error, config.openAiApiKey);
    expect(details.errorCode).toBe('insufficient_quota');
    expect(details.message).not.toContain('sk-proj-test-secret-value');
    expect(details.message).toContain('[redacted]');
  });

  it('distinguishes authentication, model, and network failures', () => {
    expect(aiFailureDetails(Object.assign(new Error('bad key'), { status: 401 }), '').errorCode).toBe('authentication');
    expect(aiFailureDetails(Object.assign(new Error('missing model'), { status: 404 }), '').errorCode).toBe('invalid_model');
    expect(aiFailureDetails(Object.assign(new Error('connect ECONNREFUSED'), { name: 'APIConnectionError' }), '').errorCode).toBe('network');
  });
});

describe('draft generation fallback', () => {
  it('keeps the standard template when OpenAI rejects the request', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    const draft = await generateDraft({
      store: new MemoryStore(),
      client: {
        async complete() {
          throw Object.assign(new Error('429 You have no credits remaining. Key sk-proj-test-secret-value.'), {
            status: 429,
            code: 'credit_balance_exhausted',
            type: 'insufficient_quota',
          });
        },
      },
      config,
      purpose: 'Ask companies to share their vendor empanelment process.',
      style: 'professional',
      createdBy: null,
    });
    spy.mockRestore();
    expect(draft.source).toBe('fallback');
    expect(draft.subject).toBe(DEFAULT_SUBJECT);
    expect(draft.body).toBe(DEFAULT_BODY);
    expect(draft.notice).toContain('The AI service was unavailable');
    const logged = lines.join('\n');
    expect(logged).toContain('insufficient_quota');
    expect(logged).toContain('credit_balance_exhausted');
    expect(logged).not.toContain('sk-proj-test-secret-value');
  });
});

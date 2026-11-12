import OpenAI from 'openai';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { validateAiDraft } from '../domain/aiDraft';
import { DEFAULT_BODY, DEFAULT_SUBJECT, type TemplateStyle } from '../domain/defaultTemplate';
import { logError } from '../logger';
import type { Store } from '../store';

const draftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export interface AiClient {
  complete(input: { system: string; user: string }): Promise<string>;
}

export interface DraftResult {
  subject: string;
  body: string;
  source: 'ai' | 'fallback';
  notice: string;
}

const SYSTEM_PROMPT = `You draft outreach email for Skybate Technologies Pvt. Ltd.
Return only JSON with keys "subject" and "body".
Skybate is a Hyderabad-based IT staffing and recruitment company. The website is https://skybate.in.
The sender is Sreekar Kondaveeti, Director. The sender email may be mentioned only as the configured sender address.
Service areas that may be named: AI/ML, Data Engineering, Software Development, Cloud, DevOps, Mobile Application Development, and other technology roles.
Use {{contact_name}} in the greeting and {{company_name}} when referring to the recipient organization.
Do not invent recipient names, client names, placements, team size, years of experience, metrics, or project history.
Do not add any URL except https://skybate.in.
Do not claim the message was already sent.`;

export function createOpenAiClient(config: AppConfig): AiClient | null {
  if (!config.openAiApiKey) return null;
  const client = new OpenAI({ apiKey: config.openAiApiKey });
  return {
    async complete({ system, user }) {
      const response = await client.chat.completions.create({
        model: config.openAiModel,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      return response.choices[0]?.message?.content ?? '';
    },
  };
}

function redactSecret(message: string, apiKey: string): string {
  const withoutKey = apiKey ? message.split(apiKey).join('[redacted]') : message;
  return withoutKey
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

export function aiFailureDetails(error: unknown, apiKey: string): { errorCode: string; message: string } {
  const raw = error instanceof Error ? error.message : 'OpenAI request failed.';
  const message = redactSecret(raw, apiKey).slice(0, 500);
  const record = error && typeof error === 'object' ? error as { status?: unknown; code?: unknown; type?: unknown; name?: unknown } : {};
  const status = typeof record.status === 'number' ? record.status : undefined;
  const code = typeof record.code === 'string' ? record.code : '';
  const type = typeof record.type === 'string' ? record.type : '';
  const name = typeof record.name === 'string' ? record.name : '';
  const signature = `${code} ${type} ${message}`;
  let errorCode = 'request_failed';
  if (status === 401) errorCode = 'authentication';
  else if (status === 403) errorCode = 'permission_denied';
  else if (status === 404) errorCode = 'invalid_model';
  else if (status === 429 && /insufficient_quota|credit_balance|billing/i.test(signature)) errorCode = 'insufficient_quota';
  else if (status === 429) errorCode = 'rate_limit';
  else if (status === 400) errorCode = 'invalid_request';
  else if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' || /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(message)) {
    errorCode = 'network';
  }
  return { errorCode, message };
}

function fallback(notice: string): DraftResult {
  return {
    subject: DEFAULT_SUBJECT,
    body: DEFAULT_BODY,
    source: 'fallback',
    notice,
  };
}

export async function generateDraft(input: {
  store: Store;
  client: AiClient | null;
  config: AppConfig;
  purpose: string;
  style: TemplateStyle;
  createdBy: number | null;
}): Promise<DraftResult> {
  if (!input.client) {
    await input.store.logAiGeneration({
      status: 'fallback',
      model: null,
      errorCode: 'not_configured',
      createdBy: input.createdBy,
    });
    return fallback('The AI service is not configured. The standard Skybate template is shown instead and can be edited.');
  }

  try {
    const raw = await input.client.complete({
      system: SYSTEM_PROMPT,
      user: `Purpose: ${input.purpose}\nStyle: ${input.style}\nWrite a subject and body. Keep the body as plain text.`,
    });
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      await input.store.logAiGeneration({
        status: 'fallback',
        model: input.config.openAiModel,
        errorCode: 'invalid_shape',
        createdBy: input.createdBy,
      });
      return fallback('The AI response was not usable. The standard Skybate template is shown instead and can be edited.');
    }
    const problem = validateAiDraft(parsed.data.subject, parsed.data.body, input.config.sesFromEmail);
    if (problem) {
      await input.store.logAiGeneration({
        status: 'fallback',
        model: input.config.openAiModel,
        errorCode: problem,
        createdBy: input.createdBy,
      });
      return fallback('The AI draft failed validation. The standard Skybate template is shown instead and can be edited.');
    }
    await input.store.logAiGeneration({
      status: 'success',
      model: input.config.openAiModel,
      errorCode: null,
      createdBy: input.createdBy,
    });
    return {
      subject: parsed.data.subject.trim(),
      body: parsed.data.body.trim(),
      source: 'ai',
      notice: 'Review and edit this draft. Nothing is sent until a campaign is approved and started separately.',
    };
  } catch (error) {
    const details = aiFailureDetails(error, input.config.openAiApiKey);
    if (input.config.nodeEnv === 'development') {
      const record = error && typeof error === 'object' ? error as { status?: unknown; code?: unknown; type?: unknown } : {};
      logError('OpenAI draft generation failed.', {
        status: typeof record.status === 'number' ? record.status : undefined,
        providerCode: typeof record.code === 'string' ? record.code : undefined,
        providerType: typeof record.type === 'string' ? record.type : undefined,
        errorCode: details.errorCode,
        detail: details.message,
      });
    }
    await input.store.logAiGeneration({
      status: 'error',
      model: input.config.openAiModel,
      errorCode: details.errorCode,
      createdBy: input.createdBy,
    });
    return fallback('The AI service was unavailable. The standard Skybate template is shown instead and can be edited.');
  }
}

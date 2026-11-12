import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { AppError } from '../errors';
import { bootstrap } from '../services/bootstrap';
import type { MailTransport, OutboundMail } from '../services/mailer';
import type { VerifiedSns } from '../services/sns';
import { MemoryStore } from '../store/memory';

export class FakeMailer implements MailTransport {
  mode: 'dry_run' | 'live' = 'live';
  sent: OutboundMail[] = [];
  calls = 0;
  failTimes = 0;
  failWith: unknown = null;

  async verify(): Promise<void> {
    return undefined;
  }

  async send(message: OutboundMail): Promise<{ messageId: string }> {
    this.calls += 1;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw this.failWith ?? Object.assign(new Error('transport failed'), { responseCode: 450 });
    }
    this.sent.push(message);
    return { messageId: `<fake-${this.sent.length}@example.com>` };
  }
}

export async function buildTestApp(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_STORE: 'memory',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'correct-horse-battery',
    ADMIN_NAME: 'Test Admin',
    BCRYPT_ROUNDS: '4',
    DRY_RUN: 'true',
    SENDING_ENABLED: 'false',
    SES_FROM_EMAIL: 'sreekar.k@skybate.in',
    SES_FROM_NAME: 'Sreekar Kondaveeti',
    SES_SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:ses-events',
    MAX_RECIPIENTS_PER_CAMPAIGN: '25',
    SES_MAX_SEND_RATE: '1',
    SES_MAX_BATCH_SIZE: '5',
    MAX_SEND_ATTEMPTS: '3',
    CIRCUIT_BREAKER_THRESHOLD: '5',
    RETRY_BASE_DELAY_SECONDS: '0',
    PUBLIC_API_URL: 'http://localhost:4000',
    ...overrides,
  });
  const store = new MemoryStore();
  await bootstrap(store, config);
  const mailer = new FakeMailer();
  const app = createApp({
    store,
    config,
    mailer,
    aiClient: {
      async complete() {
        return JSON.stringify({
          subject: 'Vendor empanelment with {{company_name}}',
          body: 'Hi {{contact_name}},\n\nSkybate Technologies Pvt. Ltd. would like to partner with {{company_name}}. We have placed 500 engineers at Fortune 100 clients.\n\nhttps://skybate.in',
        });
      },
    },
    snsVerifier: async (body: unknown): Promise<VerifiedSns> => {
      const payload = body as { token?: string; kind?: string; event?: unknown; topicArn?: string };
      if (payload?.token !== 'valid') {
        throw new AppError(401, 'SNS notification could not be verified.', 'SNS_UNVERIFIED');
      }
      if (payload.kind === 'confirmation') {
        return {
          type: 'subscription_confirmation',
          topicArn: payload.topicArn ?? '',
          subscribeUrl: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
        };
      }
      return { type: 'notification', topicArn: payload.topicArn ?? '', message: payload.event };
    },
  });
  return { app, store, mailer, config };
}

export const liveEnv = {
  DRY_RUN: 'false',
  SENDING_ENABLED: 'true',
  LIVE_SENDING_CONFIRMATION: 'I_UNDERSTAND_THIS_SENDS_REAL_EMAIL',
  SES_ACCOUNT_APPROVED: 'true',
  SES_SMTP_HOST: 'email-smtp.us-east-1.amazonaws.com',
  SES_SMTP_PORT: '587',
  SES_SMTP_USER: 'test-smtp-user',
  SES_SMTP_PASSWORD: 'test-smtp-password',
};

export async function login(app: Express, email = 'admin@example.com', password = 'correct-horse-battery') {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({ email, password });
  return { agent, csrf: String(response.body.csrfToken ?? ''), status: response.status };
}

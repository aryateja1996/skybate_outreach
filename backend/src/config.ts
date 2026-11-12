import { z } from 'zod';

const boolFromString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATA_STORE: z.enum(['mysql', 'memory']).default('mysql'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('skybate_outreach'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: boolFromString('false'),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  TRUST_PROXY: boolFromString('false'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
  ADMIN_NAME: z.string().default('Skybate Administrator'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  DRY_RUN: boolFromString('true'),
  SENDING_ENABLED: boolFromString('false'),
  LIVE_SENDING_CONFIRMATION: z.string().default(''),
  SES_ACCOUNT_APPROVED: boolFromString('false'),
  SES_SMTP_HOST: z.string().default(''),
  SES_SMTP_PORT: z.coerce.number().int().positive().default(587),
  SES_SMTP_USER: z.string().default(''),
  SES_SMTP_PASSWORD: z.string().default(''),
  SES_FROM_EMAIL: z.string().default('sreekar.k@skybate.in'),
  SES_FROM_NAME: z.string().default('Sreekar Kondaveeti'),
  SES_SNS_TOPIC_ARN: z.string().default(''),
  SES_SNS_AUTO_CONFIRM: boolFromString('false'),
  SES_MAX_SEND_RATE: z.coerce.number().positive().default(1),
  SES_MAX_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(25),
  MAX_SEND_ATTEMPTS: z.coerce.number().int().positive().default(3),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  RETRY_BASE_DELAY_SECONDS: z.coerce.number().int().min(0).default(30),
  SEND_TICK_MS: z.coerce.number().int().positive().default(1000),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(6000),
});

export interface AppConfig {
  nodeEnv: string;
  port: number;
  dataStore: 'mysql' | 'memory';
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  dbConnectionLimit: number;
  sessionTtlHours: number;
  cookieSecure: boolean;
  cookieSameSite: 'strict' | 'lax' | 'none';
  trustProxy: boolean;
  corsOrigins: string[];
  publicAppUrl: string;
  publicApiUrl: string;
  adminEmail: string;
  adminPassword: string;
  adminName: string;
  bcryptRounds: number;
  dryRunFlag: boolean;
  sendingEnabled: boolean;
  liveConfirmationPresent: boolean;
  sesAccountApproved: boolean;
  sesHost: string;
  sesPort: number;
  sesUser: string;
  sesPassword: string;
  sesFromEmail: string;
  sesFromName: string;
  sesSnsTopicArn: string;
  sesSnsAutoConfirm: boolean;
  maxSendRate: number;
  maxBatchSize: number;
  maxRecipientsPerCampaign: number;
  maxSendAttempts: number;
  circuitBreakerThreshold: number;
  retryBaseDelaySeconds: number;
  sendTickMs: number;
  openAiApiKey: string;
  openAiModel: string;
  maxUploadBytes: number;
  maxImportRows: number;
  mode: 'dry_run' | 'live';
  dryRunReasons: string[];
}

const LIVE_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_REAL_EMAIL';

export function resolveSendMode(input: {
  dryRunFlag: boolean;
  sendingEnabled: boolean;
  liveConfirmationPresent: boolean;
  sesAccountApproved: boolean;
  sesHost: string;
  sesPort: number;
  sesUser: string;
  sesPassword: string;
  sesFromEmail: string;
  sesFromName: string;
}): { mode: 'dry_run' | 'live'; dryRunReasons: string[] } {
  const reasons: string[] = [];
  if (input.dryRunFlag) reasons.push('DRY_RUN is true.');
  if (!input.sendingEnabled) reasons.push('SENDING_ENABLED is not true.');
  if (!input.liveConfirmationPresent) {
    reasons.push('LIVE_SENDING_CONFIRMATION is not set to the required phrase.');
  }
  if (!input.sesHost || !input.sesPort || !input.sesUser || !input.sesPassword) {
    reasons.push('SES SMTP credentials are incomplete.');
  }
  if (!input.sesFromEmail || !input.sesFromName) reasons.push('Sender identity is not configured.');
  if (!input.sesAccountApproved) reasons.push('SES_ACCOUNT_APPROVED is not true.');
  if (reasons.length > 0) return { mode: 'dry_run', dryRunReasons: reasons };
  return { mode: 'live', dryRunReasons: [] };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.DATA_STORE === 'memory') {
    throw new Error('DATA_STORE=memory cannot be used when NODE_ENV=production.');
  }
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  }
  const liveConfirmationPresent = env.LIVE_SENDING_CONFIRMATION === LIVE_CONFIRMATION;
  const mode = resolveSendMode({
    dryRunFlag: env.DRY_RUN,
    sendingEnabled: env.SENDING_ENABLED,
    liveConfirmationPresent,
    sesAccountApproved: env.SES_ACCOUNT_APPROVED,
    sesHost: env.SES_SMTP_HOST,
    sesPort: env.SES_SMTP_PORT,
    sesUser: env.SES_SMTP_USER,
    sesPassword: env.SES_SMTP_PASSWORD,
    sesFromEmail: env.SES_FROM_EMAIL,
    sesFromName: env.SES_FROM_NAME,
  });

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataStore: env.DATA_STORE,
    dbHost: env.DB_HOST,
    dbPort: env.DB_PORT,
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASSWORD,
    dbName: env.DB_NAME,
    dbConnectionLimit: env.DB_CONNECTION_LIMIT,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    cookieSecure: env.COOKIE_SECURE,
    cookieSameSite: env.COOKIE_SAMESITE,
    trustProxy: env.TRUST_PROXY,
    corsOrigins: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    publicAppUrl: env.PUBLIC_APP_URL,
    publicApiUrl: env.PUBLIC_API_URL,
    adminEmail: env.ADMIN_EMAIL.trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD,
    adminName: env.ADMIN_NAME,
    bcryptRounds: env.NODE_ENV === 'test' ? Math.min(env.BCRYPT_ROUNDS, 4) : env.BCRYPT_ROUNDS,
    dryRunFlag: env.DRY_RUN,
    sendingEnabled: env.SENDING_ENABLED,
    liveConfirmationPresent,
    sesAccountApproved: env.SES_ACCOUNT_APPROVED,
    sesHost: env.SES_SMTP_HOST,
    sesPort: env.SES_SMTP_PORT,
    sesUser: env.SES_SMTP_USER,
    sesPassword: env.SES_SMTP_PASSWORD,
    sesFromEmail: env.SES_FROM_EMAIL.trim().toLowerCase(),
    sesFromName: env.SES_FROM_NAME,
    sesSnsTopicArn: env.SES_SNS_TOPIC_ARN,
    sesSnsAutoConfirm: env.SES_SNS_AUTO_CONFIRM,
    maxSendRate: env.SES_MAX_SEND_RATE,
    maxBatchSize: env.SES_MAX_BATCH_SIZE,
    maxRecipientsPerCampaign: env.MAX_RECIPIENTS_PER_CAMPAIGN,
    maxSendAttempts: env.MAX_SEND_ATTEMPTS,
    circuitBreakerThreshold: env.CIRCUIT_BREAKER_THRESHOLD,
    retryBaseDelaySeconds: env.RETRY_BASE_DELAY_SECONDS,
    sendTickMs: env.SEND_TICK_MS,
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    maxImportRows: env.MAX_IMPORT_ROWS,
    mode: mode.mode,
    dryRunReasons: mode.dryRunReasons,
  };
}

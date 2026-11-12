import { createVerify } from 'crypto';
import { AppError } from '../errors';

export type VerifiedSns =
  | { type: 'subscription_confirmation'; topicArn: string; subscribeUrl: string }
  | { type: 'notification'; topicArn: string; message: unknown };

const certCache = new Map<string, string>();

export function isSafeSnsSubscribeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname);
  } catch {
    return false;
  }
}

function signingCertUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError(401, 'SNS notification could not be verified.', 'SNS_UNVERIFIED');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(401, 'SNS notification could not be verified.', 'SNS_UNVERIFIED');
  }
  if (url.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname)) {
    throw new AppError(401, 'SNS signing certificate URL is not trusted.', 'SNS_UNVERIFIED');
  }
  return url.toString();
}

async function certificate(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new AppError(401, 'SNS signing certificate could not be retrieved.', 'SNS_UNVERIFIED');
  const pem = await response.text();
  if (!pem.includes('BEGIN CERTIFICATE')) {
    throw new AppError(401, 'SNS signing certificate was invalid.', 'SNS_UNVERIFIED');
  }
  certCache.set(url, pem);
  return pem;
}

function canonical(message: Record<string, unknown>): string {
  const type = String(message.Type ?? '');
  const fields =
    type === 'Notification'
      ? ['Message', 'MessageId', ...('Subject' in message && message.Subject != null ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return fields.map((field) => `${field}\n${String(message[field] ?? '')}\n`).join('');
}

export async function verifySnsEnvelope(body: unknown): Promise<VerifiedSns> {
  const message = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!message || typeof message.Type !== 'string' || typeof message.Signature !== 'string') {
    throw new AppError(401, 'SNS notification could not be verified.', 'SNS_UNVERIFIED');
  }
  const certUrl = signingCertUrl(message.SigningCertURL);
  const pem = await certificate(certUrl);
  const algorithm = message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const verifier = createVerify(algorithm);
  verifier.update(canonical(message), 'utf8');
  if (!verifier.verify(pem, message.Signature, 'base64')) {
    throw new AppError(401, 'SNS signature verification failed.', 'SNS_UNVERIFIED');
  }
  const topicArn = String(message.TopicArn ?? '');
  if (message.Type === 'SubscriptionConfirmation' || message.Type === 'UnsubscribeConfirmation') {
    return { type: 'subscription_confirmation', topicArn, subscribeUrl: String(message.SubscribeURL ?? '') };
  }
  if (message.Type !== 'Notification') {
    throw new AppError(401, 'Unsupported SNS message type.', 'SNS_UNVERIFIED');
  }
  const raw = String(message.Message ?? '');
  try {
    return { type: 'notification', topicArn, message: JSON.parse(raw) as unknown };
  } catch {
    throw new AppError(400, 'SES event payload was not valid JSON.', 'INVALID_SES_EVENT');
  }
}

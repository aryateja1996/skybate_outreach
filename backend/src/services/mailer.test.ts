import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';
import { logInfo } from '../logger';
import { createMailTransport, smtpConnectionOptions, verifySmtpConnection } from './mailer';

const mocks = vi.hoisted(() => {
  const verify = vi.fn(async () => true);
  const sendMail = vi.fn(async () => ({ messageId: 'should-not-send' }));
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ verify, sendMail, close }));
  return { verify, sendMail, close, createTransport };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: mocks.createTransport },
}));

const smtp = {
  sesHost: 'email-smtp.ap-southeast-2.amazonaws.com',
  sesPort: 587,
  sesUser: 'smtp-user-value',
  sesPassword: 'smtp-password-value',
};

describe('SMTP connection options', () => {
  beforeEach(() => {
    mocks.verify.mockClear();
    mocks.sendMail.mockClear();
    mocks.close.mockClear();
    mocks.createTransport.mockClear();
  });

  it('uses STARTTLS on port 587 and implicit TLS only on port 465', () => {
    expect(smtpConnectionOptions(smtp)).toMatchObject({
      host: 'email-smtp.ap-southeast-2.amazonaws.com',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: 'TLSv1.2' },
      logger: false,
      debug: false,
      auth: { user: 'smtp-user-value', pass: 'smtp-password-value' },
    });
    expect(smtpConnectionOptions({ ...smtp, sesPort: 465 })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  it('does not open SMTP while the mailer is in dry-run mode', async () => {
    const mailer = createMailTransport({ mode: 'dry_run', ...smtp, sesFromEmail: 'sales@skybate.in' } as AppConfig);
    await expect(mailer.verify()).rejects.toThrow(/does not open an SMTP connection/);
    await expect(mailer.send({} as never)).rejects.toThrow(/does not open an SMTP connection/);
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('verifies the connection without sending a message', async () => {
    await verifySmtpConnection(smtp);
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('closes the connection when verification fails', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('authentication failed'));
    await expect(verifySmtpConnection(smtp)).rejects.toThrow(/authentication failed/);
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('refuses to connect when credentials are missing', async () => {
    await expect(verifySmtpConnection({ ...smtp, sesPassword: '' })).rejects.toThrow(/incomplete/);
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
});

describe('credential logging', () => {
  it('redacts SMTP usernames and passwords', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    logInfo('status', {
      sesUser: 'smtp-user-value',
      sesPassword: 'smtp-password-value',
      SES_SMTP_PASSWORD: 'smtp-password-value',
      senderEmail: 'sales@skybate.in',
    });
    spy.mockRestore();
    const text = lines.join('\n');
    expect(text).not.toContain('smtp-user-value');
    expect(text).not.toContain('smtp-password-value');
    expect(text).toContain('[redacted]');
    expect(text).toContain('sales@skybate.in');
  });
});

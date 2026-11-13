import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { AppConfig } from '../config';
import { AppError } from '../errors';

export interface OutboundMail {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
}

export interface MailTransport {
  readonly mode: 'dry_run' | 'live';
  send(message: OutboundMail): Promise<{ messageId: string }>;
  verify(): Promise<void>;
}

type SmtpSettings = Pick<AppConfig, 'sesHost' | 'sesPort' | 'sesUser' | 'sesPassword'>;

export function smtpConnectionOptions(config: SmtpSettings): SMTPTransport.Options {
  return {
    host: config.sesHost,
    port: config.sesPort,
    secure: config.sesPort === 465,
    requireTLS: config.sesPort !== 465,
    auth: {
      user: config.sesUser,
      pass: config.sesPassword,
    },
    tls: { minVersion: 'TLSv1.2' },
    logger: false,
    debug: false,
  };
}

/** Opens SMTP, negotiates STARTTLS on port 587, and authenticates. Does not send a message. */
export async function verifySmtpConnection(config: SmtpSettings): Promise<void> {
  if (!config.sesHost || !config.sesPort || !config.sesUser || !config.sesPassword) {
    throw new Error('SES SMTP credentials are incomplete.');
  }
  const transporter = nodemailer.createTransport(smtpConnectionOptions(config));
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

export function createMailTransport(config: AppConfig): MailTransport {
  if (config.mode !== 'live') {
    return {
      mode: 'dry_run',
      async send() {
        throw new Error('Dry-run mode does not open an SMTP connection.');
      },
      async verify() {
        throw new Error('Dry-run mode does not open an SMTP connection.');
      },
    };
  }

  const transporter = nodemailer.createTransport(smtpConnectionOptions(config));

  return {
    mode: 'live',
    async verify() {
      await transporter.verify();
    },
    async send(message) {
      if (message.fromEmail.toLowerCase() !== config.sesFromEmail.toLowerCase()) {
        throw new AppError(400, 'Sender address does not match the configured SES identity.', 'SENDER_MISMATCH');
      }
      const info = await transporter.sendMail({
        from: `"${message.fromName}" <${message.fromEmail}>`,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: {
          'X-SES-CONFIGURATION-SET': 'skybate-outreach-tracking',
          'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      return { messageId: info.messageId };
    },
  };
}

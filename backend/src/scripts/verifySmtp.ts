import 'dotenv/config';
import { loadConfig } from '../config';
import { verifySmtpConnection } from '../services/mailer';

function redact(message: string, secrets: string[]): string {
  return secrets.reduce((output, secret) => (secret ? output.split(secret).join('[redacted]') : output), message);
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(JSON.stringify({
    host: config.sesHost,
    port: config.sesPort,
    starttls: config.sesPort !== 465,
    usernamePresent: config.sesUser.length > 0,
    passwordPresent: config.sesPassword.length > 0,
    sender: config.sesFromEmail,
    dryRun: config.dryRunFlag,
    sendingEnabled: config.sendingEnabled,
    accountApproved: config.sesAccountApproved,
    mode: config.mode,
    action: 'verify-only',
    messageSent: false,
  }));

  try {
    await verifySmtpConnection(config);
    console.log(JSON.stringify({ connected: true, messageSent: false }));
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'SMTP verification failed.';
    console.error(JSON.stringify({
      connected: false,
      messageSent: false,
      error: redact(raw, [config.sesUser, config.sesPassword]),
    }));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'SMTP verification failed.';
  console.error(JSON.stringify({ connected: false, messageSent: false, error: message }));
  process.exitCode = 1;
});

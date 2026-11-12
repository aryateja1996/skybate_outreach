import bcrypt from 'bcryptjs';
import type { AppConfig } from '../config';
import { DEFAULT_BODY, DEFAULT_SUBJECT, DEFAULT_TEMPLATE_NAME } from '../domain/defaultTemplate';
import { logInfo } from '../logger';
import type { Store } from '../store';

export function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export async function bootstrap(store: Store, config: AppConfig): Promise<void> {
  if ((await store.countUsers()) === 0) {
    if (!config.adminEmail || !config.adminPassword) {
      logInfo('No users exist and ADMIN_EMAIL or ADMIN_PASSWORD is empty. Sign-in is unavailable until an administrator is configured.');
    } else {
      await store.createUser({
        email: config.adminEmail,
        passwordHash: await hashPassword(config.adminPassword, config.bcryptRounds),
        displayName: config.adminName,
        role: 'admin',
      });
      logInfo('Created the initial administrator from environment configuration.');
    }
  }

  const templates = await store.listTemplates();
  if (templates.length === 0) {
    await store.createTemplate({
      name: DEFAULT_TEMPLATE_NAME,
      style: 'professional',
      subject: DEFAULT_SUBJECT,
      body: DEFAULT_BODY,
      isDefault: true,
      aiGenerated: false,
      createdBy: null,
    });
  }
}

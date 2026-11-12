import 'dotenv/config';
import { createApp } from './app';
import { loadConfig } from './config';
import { logError, logInfo } from './logger';
import { createOpenAiClient } from './services/ai';
import { bootstrap } from './services/bootstrap';
import { createMailTransport } from './services/mailer';
import { recoverScheduler, schedulerTick } from './services/scheduler';
import { recoverOnStartup, runSendTick } from './services/sending';
import { verifySnsEnvelope } from './services/sns';
import { createStore } from './store';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config);
  await store.ping();
  await bootstrap(store, config);
  await recoverOnStartup(store);
  await recoverScheduler(store, new Date(), config.mode);
  const mailer = createMailTransport(config);
  const aiClient = createOpenAiClient(config);
  const app = createApp({
    store,
    config,
    mailer,
    aiClient,
    snsVerifier: verifySnsEnvelope,
  });
  const server = app.listen(config.port, () => {
    logInfo('Outreach API listening.', { port: config.port, mode: config.mode });
  });
  const timer = setInterval(() => {
    runSendTick({ store, config, mailer }).catch((error: unknown) => {
      logError('Sending tick failed.', { name: error instanceof Error ? error.name : 'Error' });
    });
    schedulerTick({ store, config, mailer, aiClient }).catch((error: unknown) => {
      logError('Scheduler tick failed.', { name: error instanceof Error ? error.name : 'Error' });
    });
  }, config.sendTickMs);
  timer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  logError('Server failed to start.', {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'Unknown startup failure',
  });
  process.exit(1);
});

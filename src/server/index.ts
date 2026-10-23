import { DATA_DIR, env, extendPath } from './config.js';
import { buildApp } from './app.js';
import { activity } from './lib/activity.js';
import { errMsg } from './lib/errors.js';
import { loadDb, saveDb, settings } from './store.js';
import { markInterrupted, pollOnce } from './services/deploy.js';
import { registerDeployNotifications } from './services/notify.js';
import { startWebhookServer } from './services/webhooks.js';
import { detectMetricsMode } from './services/caddy.js';
import { startAlertLoop } from './monitoring/alerts.js';
import { startExporter } from './monitoring/exporter.js';
import { registerMonitoringHooks, writeConfigs } from './monitoring/service.js';

process.on('unhandledRejection', (e) => activity.error(`unhandledRejection: ${errMsg(e)}`));

async function main(): Promise<void> {
  extendPath();
  loadDb();
  await saveDb();
  markInterrupted();

  registerDeployNotifications();
  registerMonitoringHooks();
  startWebhookServer();
  startExporter();
  startAlertLoop();
  setInterval(() => void pollOnce().catch((e) => activity.error(`poll: ${errMsg(e)}`)), 15_000);

  void detectMetricsMode().then((m) => activity.info(`Caddy metrics: ${m}`));
  if (settings().monitoring.enabled) await writeConfigs().catch((e) => activity.warn(`Config monitoring: ${errMsg(e)}`));

  const app = await buildApp();
  await app.listen({ host: env.host, port: env.port });
  console.log(`\n  Homeport jalan di http://${env.host}:${env.port}\n  Data: ${DATA_DIR}${env.password ? '  (password aktif)' : ''}\n`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.host) && !env.password) {
    console.warn('  ⚠  Dashboard terbuka ke jaringan tanpa password! Set TM_PASSWORD.\n');
  }

  const shutdown = async () => { await app.close(); await saveDb(); process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

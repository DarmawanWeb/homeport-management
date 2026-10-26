import { buildApp } from './app.js';
import { adoptEnvPassword } from './auth/index.js';
import { loadAuth, prepareSetupCode, saveAuth, wasMigrated } from './auth/store.js';
import { DATA_DIR, env, extendPath } from './config.js';
import { activity } from './lib/activity.js';
import { errMsg } from './lib/errors.js';
import { startAlertLoop } from './monitoring/alerts.js';
import { startExporter } from './monitoring/exporter.js';
import { registerMonitoringHooks, upgradeLayout, writeConfigs } from './monitoring/service.js';
import { FLAVOR, FLAVOR_LABEL } from './platform.js';
import { detectMetricsMode } from './services/caddy.js';
import { markInterrupted, pollOnce } from './services/deploy.js';
import { registerDeployNotifications } from './services/notify.js';
import { startWebhookServer } from './services/webhooks.js';
import { loadDb, saveDb, settings } from './store.js';

process.on('unhandledRejection', (e) => activity.error(`unhandledRejection: ${errMsg(e)}`));

async function main(): Promise<void> {
  extendPath();
  loadDb();
  await saveDb();
  if (loadAuth().reset) activity.warn('Dashboard password and sessions were reset. Set a new password on this machine.');
  if (wasMigrated()) {
    await saveAuth();
    activity.info('Your dashboard password now belongs to the account "admin". Rename it on the Access page.');
  }
  await adoptEnvPassword();
  markInterrupted();

  registerDeployNotifications();
  registerMonitoringHooks();
  startWebhookServer();
  startExporter();
  startAlertLoop();
  setInterval(() => void pollOnce().catch((e) => activity.error(`poll: ${errMsg(e)}`)), 15_000);

  void detectMetricsMode().then((m) => activity.info(`Caddy metrics: ${m}`));
  if (settings().monitoring.enabled) {
    await writeConfigs().catch((e) => activity.warn(`Monitoring config: ${errMsg(e)}`));
    void upgradeLayout().catch((e) => activity.warn(`Monitoring upgrade: ${errMsg(e)}`));
  }

  const app = await buildApp();
  await app.listen({ host: env.host, port: env.port });
  console.log(`\n  Homeport is running at http://${env.host}:${env.port} (${FLAVOR_LABEL[FLAVOR]})\n  Data: ${DATA_DIR}\n`);
  const code = prepareSetupCode();
  if (code) {
    console.log('  No dashboard password yet. Open the dashboard and set one.');
    console.log(`  From another computer, enter this setup code:  ${code}\n`);
  }

  const shutdown = async () => {
    await app.close();
    await saveDb();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

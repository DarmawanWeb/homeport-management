import os from 'node:os';
import { activity } from '../lib/activity.js';
import { badRequest, errMsg } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { settings } from '../store.js';

export type Level = 'success' | 'error' | 'warning' | 'info';

export interface Notification {
  title: string;
  body: string;
  level: Level;
  url?: string;
}

const COLORS: Record<Level, number> = { success: 0x3ecf8e, error: 0xf2555a, warning: 0xf5c04a, info: 0x5aa9f2 };
const ICONS: Record<Level, string> = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

async function discord(url: string, n: Notification): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Homeport',
      embeds: [
        {
          title: n.title,
          description: n.body.slice(0, 4000),
          color: COLORS[n.level],
          url: n.url,
          footer: { text: os.hostname() },
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function telegram(token: string, chatId: string, n: Notification): Promise<void> {
  const text = `${ICONS[n.level]} <b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body).slice(0, 3500)}${n.url ? `\n${escapeHtml(n.url)}` : ''}\n<i>${escapeHtml(os.hostname())}</i>`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export const configured = () => {
  const n = settings().notify;
  return !!n.discordWebhook || (!!n.telegramBotToken && !!n.telegramChatId);
};

/** Send to every configured channel. Failures are logged, never thrown. */
export async function send(n: Notification): Promise<void> {
  const cfg = settings().notify;
  const jobs: Promise<void>[] = [];
  if (cfg.discordWebhook) jobs.push(discord(cfg.discordWebhook, n));
  if (cfg.telegramBotToken && cfg.telegramChatId) jobs.push(telegram(cfg.telegramBotToken, cfg.telegramChatId, n));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') activity.warn(`Notification failed: ${errMsg(r.reason)}`);
}

export async function sendTest(): Promise<void> {
  if (!configured()) throw badRequest('No notification channel is set up yet (Discord or Telegram)');
  const cfg = settings().notify;
  const errors: string[] = [];
  const n: Notification = { title: 'Homeport test notification', body: 'If you can read this, notifications are working.', level: 'info' };
  if (cfg.discordWebhook) await discord(cfg.discordWebhook, n).catch((e) => errors.push(errMsg(e)));
  if (cfg.telegramBotToken && cfg.telegramChatId)
    await telegram(cfg.telegramBotToken, cfg.telegramChatId, n).catch((e) => errors.push(errMsg(e)));
  if (errors.length) throw badRequest(errors.join('\n'));
}

export function registerDeployNotifications(): void {
  events.on('deploy:finished', (d, app) => {
    const cfg = settings().notify;
    const short = (d.commit ?? '').slice(0, 7);
    const who = d.pushedBy ? ` by ${d.pushedBy}` : '';
    if (d.status === 'success' && cfg.onDeploySuccess) {
      void send({
        level: 'success',
        title: `${app.name} is live`,
        body: `${short} ${d.msg ?? ''}\n${d.trigger}${who} · ${Math.round((d.duration ?? 0) / 1000)}s`,
      });
    }
    if (d.status === 'failed' && cfg.onDeployFailed) {
      void send({
        level: d.rolledBackTo ? 'warning' : 'error',
        title: d.rolledBackTo ? `${app.name}: deploy failed, rolled back` : `${app.name}: deploy failed`,
        body: `${short} ${d.msg ?? ''}${who}\n${d.error ?? ''}${d.rolledBackTo ? `\nRunning ${d.rolledBackTo.slice(0, 7)} again` : ''}`,
      });
    }
  });
}

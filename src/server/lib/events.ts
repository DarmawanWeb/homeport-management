import { EventEmitter } from 'node:events';
import type { App, Deploy } from '../../shared/types.js';

export interface HomeportEvents {
  'deploy:finished': [deploy: Deploy, app: App];
  'webhook:received': [appName: string, result: 'deployed' | 'ignored' | 'bad_signature' | 'ping'];
  'config:changed': [];
}

class TypedEmitter extends EventEmitter {
  override emit<K extends keyof HomeportEvents>(event: K, ...args: HomeportEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HomeportEvents>(event: K, listener: (...args: HomeportEvents[K]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
}

/** In-process event bus that decouples deploys from metrics and notifications. */
export const events = new TypedEmitter();

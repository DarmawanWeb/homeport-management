import { z } from 'zod';

export const RE_HOST = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const RE_TUNNEL = /^[A-Za-z0-9_-]{1,64}$/;
export const RE_PM2NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const RE_UPHOST = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/;
export const RE_APPNAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
export const RE_REPO = /^(https:\/\/[^\s'"`]+|file:\/\/[^\s'"`]+|git@[^\s:'"`]+:[^\s'"`]+|ssh:\/\/[^\s'"`]+)$/;
export const RE_BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;
export const RE_ENVKEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RE_SHA = /^[0-9a-f]{7,40}$/;
export const RE_BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

export const port = z.coerce.number().int().min(1, 'Port must be between 1 and 65535').max(65535, 'Port must be between 1 and 65535');
export const hostname = z.string().trim().toLowerCase().regex(RE_HOST, 'Invalid hostname');
export const tunnelName = z.string().trim().regex(RE_TUNNEL, 'Tunnel names use letters, digits, dashes and underscores');
export const optionalTunnel = z
  .string()
  .trim()
  .refine((v) => v === '' || RE_TUNNEL.test(v), 'Invalid tunnel name');
export const pm2Name = z.string().trim().regex(RE_PM2NAME, 'Invalid pm2 process name');

export function bracesBalanced(t: string): boolean {
  let depth = 0;
  for (const c of t) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

export const caddySnippet = z
  .string()
  .default('')
  .transform((s) => s.replace(/\r/g, ''))
  .refine(bracesBalanced, 'Unbalanced curly braces');

/** Parse `KEY=VALUE` lines (or accept an object) into a validated env map. */
export const envMap = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .default({})
  .transform((input, ctx) => {
    const out: Record<string, string> = {};
    if (typeof input === 'string') {
      input
        .replace(/\r/g, '')
        .split('\n')
        .forEach((line, i) => {
          const l = line.trim();
          if (!l || l.startsWith('#')) return;
          const eq = l.indexOf('=');
          if (eq < 1) {
            ctx.addIssue({ code: 'custom', message: `Environment line ${i + 1} must look like KEY=VALUE` });
            return;
          }
          let v = l.slice(eq + 1).trim();
          if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
          out[
            l
              .slice(0, eq)
              .trim()
              .replace(/^export\s+/, '')
          ] = v;
        });
    } else {
      for (const [k, v] of Object.entries(input)) out[k] = String(v ?? '');
    }
    for (const k of Object.keys(out)) {
      if (!RE_ENVKEY.test(k)) ctx.addIssue({ code: 'custom', message: `Invalid environment variable name: ${k}` });
    }
    delete out.PORT;
    return out;
  });

import { useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Globe2, KeyRound, Laptop, LogOut, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { SessionView } from '../../../src/shared/types';
import { Badge, Button, CopyField, Empty, Field, Light, Loading, Modal, Notice, PageHead, Panel } from '../components/ui';
import { del, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago } from '../lib/format';
import { useAuth, usePublicAccess, useSessions, useTunnels } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';
import { StrengthMeter, strength } from './Auth';

export function Access() {
  const { data: auth } = useAuth();
  if (!auth) return <Loading />;
  return (
    <div className="page">
      <PageHead
        title="Access and security"
        description="Who can open this dashboard, from where, and how they prove it is them."
        actions={
          auth.totpEnabled ? (
            <Badge tone="ok" light>
              Two-factor on
            </Badge>
          ) : (
            <Badge tone="warn" light>
              Two-factor off
            </Badge>
          )
        }
      />
      <PublicAccess totpEnabled={auth.totpEnabled} />
      <div className="cols">
        <TwoFactor enabled={auth.totpEnabled} />
        <ChangePassword />
      </div>
      <Sessions />
    </div>
  );
}

// ---------------------------------------------------------------- public access

function PublicAccess({ totpEnabled }: { totpEnabled: boolean }) {
  const { data } = usePublicAccess();
  const { data: tunnels } = useTunnels();
  const qc = useQueryClient();
  const report = useReport();
  const dialog = useDialog();
  const [host, setHost] = useState('');
  const [tunnel, setTunnel] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['auth'] });
  const publish = async () => {
    if (!host.trim()) throw new Error('Enter a hostname, for example deploy.example.com');
    const r = await post('/api/auth/public', { hostname: host.trim(), tunnel });
    report(r, `Dashboard published at https://${host.trim()}`);
    setHost('');
    await refresh();
  };
  const unpublish = (id: string, hostname: string) =>
    dialog.open(
      <Modal
        title={`Take the dashboard off ${hostname}?`}
        submitLabel="Unpublish"
        danger
        onSubmit={async () => {
          report(await del(`/api/auth/public/${id}?dns=1`), `${hostname} no longer serves the dashboard`);
          dialog.close();
          await refresh();
        }}
      >
        <p>The domain and its DNS record are removed. The dashboard stays available on this machine at 127.0.0.1.</p>
      </Modal>,
    );

  if (!data) return <Loading />;
  const live = data.sites;
  const tunnelNames = tunnels?.tunnels.map((t) => t.name) ?? [];

  return (
    <Panel
      title="Public dashboard"
      description="Open Homeport from anywhere, like a hosted platform, through your Cloudflare tunnel. No ports are opened on your router."
    >
      <div className="public-access">
        <div className="public-state">
          {live.length ? (
            live.map((s) => (
              <div key={s.id} className="public-row">
                <Light tone={s.enabled ? 'ok' : 'warn'} label={s.enabled ? 'Published' : 'Turned off'} />
                <div className="grow">
                  <a href={`https://${s.hostname}`} target="_blank" rel="noreferrer" className="public-host">
                    {s.hostname} <ExternalLink />
                  </a>
                  <div className="sub">via tunnel {s.tunnel || 'none'}</div>
                </div>
                <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => unpublish(s.id, s.hostname)}>
                  Unpublish
                </Button>
              </div>
            ))
          ) : (
            <div className="public-row muted">
              <Light label="Private" />
              <div className="grow">
                <strong>Only this machine</strong>
                <div className="sub">Reachable at http://127.0.0.1:{data.dashboardPort}</div>
              </div>
            </div>
          )}
        </div>

        {!totpEnabled && (
          <Notice icon={<ShieldAlert />} tone="err">
            Turn on two-factor sign-in below before or right after publishing. Anyone who guesses the password can run commands on this
            machine.
          </Notice>
        )}

        <div className="form-row public-form">
          <Field label="Hostname" hint="A subdomain of a zone in your Cloudflare account. Its DNS record is created for you.">
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="deploy.example.com" />
          </Field>
          <Field label="Tunnel" hint={tunnelNames.length ? 'Any tunnel on this machine works.' : 'Create one on the Tunnels page first.'}>
            <select value={tunnel} onChange={(e) => setTunnel(e.target.value)}>
              <option value="">{data.defaultTunnel ? `Default (${data.defaultTunnel})` : 'Choose a tunnel'}</option>
              {tunnelNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <div className="public-go">
            <Button variant="primary" icon={<Globe2 />} onClick={publish}>
              Publish
            </Button>
          </div>
        </div>
        <p className="fine">
          Sign-ins over the public hostname use a secure cookie, are rate limited per address, and lock for everyone except this machine if
          many fail at once. For an extra gate in front, add a Cloudflare Access policy to the hostname.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- two-factor

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Homeport recovery codes (${location.host})\n\n${text}\n`], { type: 'text/plain' }));
    a.download = 'homeport-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="stack">
      <p>Each code signs you in once if your phone is gone. They are not shown again, so keep them somewhere safe.</p>
      <ol className="codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="btn-row">
        <Button icon={<Download />} onClick={download}>
          Download
        </Button>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(text);
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function EnableTotp({ secret, qrSvg, onEnabled }: { secret: string; qrSvg: string; onEnabled: (codes: string[]) => void }) {
  const [code, setCode] = useState('');
  return (
    <Modal
      title="Turn on two-factor sign-in"
      submitLabel="Verify and turn on"
      onSubmit={async () => {
        const r = await post<{ recoveryCodes: string[] }>('/api/auth/totp/enable', { code });
        onEnabled(r.recoveryCodes);
      }}
    >
      <div className="totp-setup">
        {/* QR code SVG generated by the server from the secret above; contains no script. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted server-generated SVG */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div className="stack">
          <p>Scan this with 1Password, Google Authenticator, Authy or any TOTP app. Or type the key in by hand:</p>
          <CopyField value={secret.replace(/(.{4})/g, '$1 ').trim()} code />
          <Field label="Code from the app">
            <input
              className="code otp"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              required
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function PasswordPrompt({ title, action, onDone }: { title: string; action: string; onDone: (password: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title={title} submitLabel={action} onSubmit={() => onDone(pw)}>
      <Field label="Current password">
        {/* biome-ignore lint/a11y/noAutofocus: single-field confirmation */}
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus required />
      </Field>
    </Modal>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const dialog = useDialog();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth'] });

  const showCodes = (codes: string[]) =>
    dialog.open(
      <Modal title="Save your recovery codes" submitLabel="I saved them">
        <RecoveryCodes codes={codes} />
      </Modal>,
    );

  const begin = async () => {
    const r = await post<{ secret: string; qrSvg: string }>('/api/auth/totp/begin');
    dialog.open(
      <EnableTotp
        secret={r.secret}
        qrSvg={r.qrSvg}
        onEnabled={(codes) => {
          toast('Two-factor sign-in is on', 'ok');
          void refresh();
          showCodes(codes);
        }}
      />,
    );
  };
  const disable = () =>
    dialog.open(
      <PasswordPrompt
        title="Turn off two-factor sign-in?"
        action="Turn off"
        onDone={async (password) => {
          await post('/api/auth/totp/disable', { password });
          dialog.close();
          toast('Two-factor sign-in is off', 'warn');
          await refresh();
        }}
      />,
    );
  const regenerate = () =>
    dialog.open(
      <PasswordPrompt
        title="Make new recovery codes?"
        action="Make new codes"
        onDone={async (password) => {
          const r = await post<{ recoveryCodes: string[] }>('/api/auth/totp/recovery', { password });
          showCodes(r.recoveryCodes);
        }}
      />,
    );

  return (
    <Panel title="Two-factor sign-in" description="A 6-digit code from your phone, on top of the password.">
      <div className="stack">
        <div className="factor">
          <span className={`factor-icon${enabled ? ' on' : ''}`}>{enabled ? <ShieldCheck /> : <Smartphone />}</span>
          <div>
            <strong>{enabled ? 'Authenticator app is set up' : 'Not set up'}</strong>
            <p className="sub">
              {enabled
                ? 'Every sign-in asks for a code. Old codes cannot be reused.'
                : 'Recommended as soon as the dashboard has a public hostname.'}
            </p>
          </div>
        </div>
        <div className="btn-row">
          {enabled ? (
            <>
              <Button onClick={regenerate}>New recovery codes</Button>
              <Button variant="danger" onClick={disable}>
                Turn off
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={<ShieldCheck />} onClick={begin}>
              Set up authenticator
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- password

function ChangePassword() {
  const toast = useToast();
  const qc = useQueryClient();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const save = async () => {
    if (next !== next2) throw new Error('The new passwords do not match');
    await post('/api/auth/password', { current: cur, next });
    setCur('');
    setNext('');
    setNext2('');
    toast('Password changed. Every other device was signed out.', 'ok');
    await qc.invalidateQueries({ queryKey: ['auth'] });
  };
  return (
    <Panel title="Password" description="Changing it signs out every other device.">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <Field label="Current password">
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password">
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        {next && <StrengthMeter value={next} />}
        <Field label="Repeat new password">
          <input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="btn-row">
          <Button variant="primary" icon={<KeyRound />} onClick={save} disabled={!cur || strength(next).score === 0}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------- sessions

function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const { data } = useSessions();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  const revoke = async (s: SessionView) => {
    await del(`/api/auth/sessions/${s.id}`);
    toast(`${describeAgent(s.userAgent)} signed out`, 'ok');
    await refresh();
  };
  const revokeOthers = async () => {
    const r = await post<{ revoked: number }>('/api/auth/sessions/revoke-others');
    toast(`Signed out ${r.revoked} other device${r.revoked === 1 ? '' : 's'}`, 'ok');
    await refresh();
  };
  const signOut = async () => {
    await post('/api/auth/logout');
    location.reload();
  };
  const others = (data?.length ?? 0) - 1;

  return (
    <Panel
      title="Signed-in devices"
      description="Sessions last 30 days from last use. The cookie is HTTP-only and only the hash of its token is stored."
      flush
      actions={
        <>
          {others > 0 && (
            <Button size="sm" onClick={revokeOthers}>
              Sign out other devices
            </Button>
          )}
          <Button size="sm" icon={<LogOut />} onClick={signOut}>
            Sign out
          </Button>
        </>
      }
    >
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="No sessions">This machine is using the dashboard without a password.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th className="hide-sm">From</th>
              <th className="hide-sm">Signed in</th>
              <th>Last active</th>
              <th className="right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="device">
                    {s.via === 'local' ? <Laptop /> : <Globe2 />}
                    <div>
                      <strong>{describeAgent(s.userAgent)}</strong>
                      {s.current && (
                        <Badge tone="sea" light>
                          This device
                        </Badge>
                      )}
                      <div className="sub show-sm">{s.via === 'local' ? 'This machine' : s.ip}</div>
                    </div>
                  </div>
                </td>
                <td className="hide-sm">
                  <span className="mono">{s.via === 'local' ? 'This machine' : s.ip}</span>
                </td>
                <td className="hide-sm nowrap">{ago(s.createdAt)}</td>
                <td className="nowrap">{s.current ? 'Now' : ago(s.lastSeenAt)}</td>
                <td className="right">
                  {!s.current && (
                    <Button size="sm" variant="ghost" onClick={() => revoke(s)}>
                      Sign out
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

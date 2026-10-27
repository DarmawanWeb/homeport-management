import { useQueryClient } from '@tanstack/react-query';
import {
  Download,
  ExternalLink,
  Globe2,
  KeyRound,
  Laptop,
  LogOut,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserPlus,
  Wifi,
} from 'lucide-react';
import { useState } from 'react';
import type { SessionView, TailscaleDTO, UserView } from '../../../src/shared/types';
import { Badge, Button, CopyField, Empty, Field, Light, Loading, Modal, Notice, PageHead, Panel } from '../components/ui';
import { del, post, put } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago } from '../lib/format';
import { useAuth, useNetwork, usePublicAccess, useSessions, useTailscale, useTunnels, useUsers } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';
import { StrengthMeter, strength } from './Auth';

export function Access() {
  const { data: auth } = useAuth();
  if (!auth) return <Loading />;
  const isAdmin = auth.user?.role !== 'viewer';
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
      {isAdmin && <LocalNetwork />}
      {isAdmin && <PrivateTailscale />}
      {isAdmin && <PublicAccess totpEnabled={auth.totpEnabled} />}
      {isAdmin && <Users />}
      <YourAccount username={auth.user?.username ?? ''} role={auth.user?.role ?? 'admin'} />
      <div className="cols">
        <TwoFactor enabled={auth.totpEnabled} />
        <ChangePassword />
      </div>
      <Sessions />
    </div>
  );
}

// ---------------------------------------------------------------- local network

const onThisMachine = () => ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

/** Wait for Homeport to come back after restarting itself, then reload the page. */
async function waitForRestart(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (res.ok) {
        location.reload();
        return;
      }
    } catch {
      /* still restarting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function LocalNetwork() {
  const { data } = useNetwork();
  const dialog = useDialog();
  const toast = useToast();
  const [restarting, setRestarting] = useState(false);
  if (!data) return <Loading />;

  const apply = async (lan: boolean) => {
    await post('/api/auth/network', { lan });
    setRestarting(true);
    dialog.close();
    toast(lan ? 'Opening the dashboard to your network. Homeport is restarting…' : 'Limiting the dashboard to this machine…', 'info', 8000);
    if (lan || onThisMachine()) await waitForRestart();
  };
  const limit = () =>
    dialog.open(
      <Modal title="Limit the dashboard to this machine?" submitLabel="Limit and restart" danger onSubmit={() => apply(false)}>
        <p>
          {onThisMachine()
            ? 'Other devices on your network will no longer reach the dashboard.'
            : 'You are using it from another device right now, so this page will stop working. You would need the Mac itself, an SSH tunnel or a public hostname to get back in.'}
        </p>
      </Modal>,
    );

  return (
    <Panel
      title="Local network"
      description="Open the dashboard from a laptop or phone on the same Wi-Fi or LAN, for a Mac without a screen or keyboard."
      actions={
        data.canChange &&
        (data.lan ? (
          <Button onClick={limit} disabled={restarting}>
            Limit to this machine
          </Button>
        ) : (
          <Button variant="primary" icon={<Wifi />} onClick={() => apply(true)} disabled={restarting}>
            Allow devices on this network
          </Button>
        ))
      }
    >
      <div className="public-access">
        <div className="public-state">
          {data.lan ? (
            data.urls.length ? (
              data.urls.map((u) => (
                <div key={u} className="public-row">
                  <Light tone="ok" label="Reachable" />
                  <div className="grow">
                    <a href={u} className="public-host">
                      {u.replace(/^http:\/\//, '')} <ExternalLink />
                    </a>
                    <div className="sub">{/\.local:/.test(u) ? 'Bonjour name, works on Macs, iPhones and most PCs' : 'IP address'}</div>
                  </div>
                  <CopyButton value={u} />
                </div>
              ))
            ) : (
              <div className="public-row">
                <Light tone="warn" label="No network" />
                <div className="grow">
                  <strong>Listening on {data.bind}, but no network address was found</strong>
                </div>
              </div>
            )
          ) : (
            <div className="public-row muted">
              <Light label="Private" />
              <div className="grow">
                <strong>Only this machine</strong>
                <div className="sub">
                  Reachable at http://127.0.0.1:{data.port}
                  {data.urls[0] ? `. Once allowed, other devices use ${data.urls[0].replace(/^http:\/\//, '')}` : ''}
                </div>
              </div>
            </div>
          )}
        </div>
        {data.lan && data.firewall === 'on' && (
          <Notice icon={<ShieldAlert />}>
            The macOS firewall is on and may block other devices, and there is no screen to click Allow. Run this once over SSH:{' '}
            <code>{data.firewallFix}</code>
          </Notice>
        )}
        {!data.canChange && (
          <p className="fine">
            Homeport is not running under pm2 here, so it cannot restart itself. Set <code>HOST=0.0.0.0</code> and restart it.
          </p>
        )}
        <p className="fine">
          Devices on the network see the sign-in page and need your password (and two-factor code if it is on). Nothing is exposed to the
          internet by this; for that, use a public hostname below.
        </p>
      </div>
    </Panel>
  );
}

function CopyButton({ value }: { value: string }) {
  const toast = useToast();
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        toast('Copied', 'ok', 1500);
      }}
    >
      Copy
    </Button>
  );
}

// ---------------------------------------------------------------- Tailscale

function PrivateTailscale() {
  const { data } = useTailscale();
  const qc = useQueryClient();
  const toast = useToast();
  if (!data) return null;
  const set = async (on: boolean) => {
    const r = await post<TailscaleDTO>('/api/auth/tailscale', { on });
    qc.setQueryData(['auth', 'tailscale'], r);
    toast(on ? `Homeport is on your tailnet at ${r.serving}` : 'No longer served on Tailscale', 'ok');
  };
  return (
    <Panel
      title="Private access with Tailscale"
      description="The safest way in from anywhere: an HTTPS address that only your own devices on Tailscale can open. Nothing is exposed to the internet."
      actions={
        data.running &&
        (data.serving ? (
          <Button onClick={() => set(false)}>Stop serving</Button>
        ) : (
          <Button variant="primary" icon={<ShieldCheck />} onClick={() => set(true)}>
            Serve on my tailnet
          </Button>
        ))
      }
    >
      <div className="public-access">
        <div className="public-state">
          {!data.installed ? (
            <div className="public-row muted">
              <Light label="Not installed" />
              <div className="grow">
                <strong>Tailscale is not installed on this machine</strong>
                <div className="sub">
                  Install it (<code>brew install --cask tailscale</code> or tailscale.com/download), sign in, and install it on your phone
                  and laptop with the same account. Then come back here.
                </div>
              </div>
            </div>
          ) : !data.running ? (
            <div className="public-row muted">
              <Light tone="warn" label={data.state} />
              <div className="grow">
                <strong>Tailscale is installed but not connected ({data.state})</strong>
                <div className="sub">Open Tailscale on this machine and sign in, or run tailscale up.</div>
              </div>
            </div>
          ) : data.serving ? (
            <div className="public-row">
              <Light tone="ok" label="Serving" />
              <div className="grow">
                <a href={data.serving} target="_blank" rel="noreferrer" className="public-host">
                  {data.serving.replace(/^https:\/\//, '')} <ExternalLink />
                </a>
                <div className="sub">HTTPS on {data.tailnet ?? 'your tailnet'}. Devices outside it cannot even reach the sign-in page.</div>
              </div>
              <CopyButton value={data.serving} />
            </div>
          ) : (
            <div className="public-row muted">
              <Light label="Connected" />
              <div className="grow">
                <strong>Connected as {data.dnsName}</strong>
                <div className="sub">
                  {data.ip ? `Tailscale address ${data.ip}. ` : ''}Press Serve to give the dashboard a private HTTPS address.
                </div>
              </div>
            </div>
          )}
        </div>
        <p className="fine">
          Homeport's sign-in and two-factor still apply on top. Prefer this over a public hostname for managing the machine; keep public
          hostnames for the apps your visitors use.
        </p>
      </div>
    </Panel>
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

// ---------------------------------------------------------------- accounts

/** A strong random password to hand to someone: 24 characters in four groups. */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{6}/g)!.join('-');
}

const ROLE_HELP = {
  admin: 'Everything: deploy, change domains and settings, manage people.',
  viewer: 'Look only: apps, deploys, logs and metrics. Secrets are hidden.',
};

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function UserForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
  const [pw, setPw] = useState(generatePassword);
  const report = useToast();
  return (
    <Modal
      title="Add a person"
      submitLabel="Add"
      onSubmit={async () => {
        await post('/api/auth/users', { username, role, password: pw });
        report(`${username} can sign in now. Send them the password over a private channel.`, 'ok', 8000);
        onDone();
      }}
    >
      <div className="form">
        <Field label="Username">
          {/* biome-ignore lint/a11y/noAutofocus: first field of the dialog */}
          <input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="off" autoFocus required />
        </Field>
        <fieldset className="role-pick">
          <legend>Role</legend>
          {(['viewer', 'admin'] as const).map((r) => (
            <label key={r} className={role === r ? 'on' : ''}>
              <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
              <strong>{r === 'admin' ? 'Admin' : 'Viewer'}</strong>
              <span>{ROLE_HELP[r]}</span>
            </label>
          ))}
        </fieldset>
        <Field label="Password" hint="Generated for you. They can change it after signing in.">
          <div className="input-group">
            <input className="code" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            <Button onClick={() => setPw(generatePassword())}>New</Button>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(pw);
              }}
            >
              Copy
            </Button>
          </div>
        </Field>
        <StrengthMeter value={pw} />
      </div>
    </Modal>
  );
}

function SetPasswordFor({ user, onDone }: { user: UserView; onDone: () => void }) {
  const [pw, setPw] = useState(generatePassword);
  const toast = useToast();
  return (
    <Modal
      title={`New password for ${user.username}`}
      submitLabel="Set password"
      onSubmit={async () => {
        await post(`/api/auth/users/${user.id}/password`, { password: pw });
        toast(`${user.username} was signed out everywhere and needs the new password`, 'ok', 8000);
        onDone();
      }}
    >
      <Field label="Password" hint="They are signed out on every device.">
        <CopyField value={pw} code />
      </Field>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <Button onClick={() => setPw(generatePassword())}>Generate another</Button>
      </div>
    </Modal>
  );
}

function Users() {
  const { data } = useUsers();
  const dialog = useDialog();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth'] });
  const done = () => {
    dialog.close();
    void refresh();
  };
  const setRole = async (u: UserView, role: 'admin' | 'viewer') => {
    await put(`/api/auth/users/${u.id}`, { role });
    toast(`${u.username} is now ${role === 'admin' ? 'an admin' : 'a viewer'}`, 'ok');
    await refresh();
  };
  const reset2fa = (u: UserView) =>
    dialog.open(
      <Modal
        title={`Turn off two-factor for ${u.username}?`}
        submitLabel="Turn off"
        danger
        onSubmit={async () => {
          await post(`/api/auth/users/${u.id}/reset-2fa`);
          toast(`${u.username} can sign in with just the password and set up two-factor again`, 'ok', 8000);
          done();
        }}
      >
        <p>For when someone lost their phone and their recovery codes. Ask them to set it up again right after signing in.</p>
      </Modal>,
    );
  const remove = (u: UserView) =>
    dialog.open(
      <Modal
        title={`Delete ${u.username}?`}
        submitLabel="Delete"
        danger
        onSubmit={async () => {
          await del(`/api/auth/users/${u.id}`);
          toast(`${u.username} was deleted and signed out everywhere`, 'ok');
          done();
        }}
      >
        <p>They are signed out on every device and can no longer sign in.</p>
      </Modal>,
    );

  return (
    <Panel
      title="People"
      description="Everyone who can sign in. Admins can change things; viewers can only look."
      flush
      actions={
        <Button variant="primary" size="sm" icon={<UserPlus />} onClick={() => dialog.open(<UserForm onDone={done} />)}>
          Add person
        </Button>
      }
    >
      {!data ? (
        <Loading />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th className="hide-sm">Two-factor</th>
              <th className="hide-sm">Last sign-in</th>
              <th className="right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="device">
                    <Avatar name={u.username} />
                    <div>
                      <strong>{u.username}</strong>
                      {u.you && (
                        <Badge tone="sea" light>
                          You
                        </Badge>
                      )}
                      <div className="sub">
                        {u.sessions} device{u.sessions === 1 ? '' : 's'} signed in
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge tone={u.role === 'admin' ? 'sea' : undefined}>{u.role === 'admin' ? 'Admin' : 'Viewer'}</Badge>
                </td>
                <td className="hide-sm">
                  {u.totpEnabled ? (
                    <Badge tone="ok" light>
                      On
                    </Badge>
                  ) : (
                    <Badge tone="warn" light>
                      Off
                    </Badge>
                  )}
                </td>
                <td className="hide-sm nowrap">{u.lastSignInAt ? ago(u.lastSignInAt) : 'Never'}</td>
                <td className="right">
                  <div className="btn-row end">
                    {!u.you && (
                      <Button size="sm" variant="ghost" onClick={() => setRole(u, u.role === 'admin' ? 'viewer' : 'admin')}>
                        {u.role === 'admin' ? 'Make viewer' : 'Make admin'}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => dialog.open(<SetPasswordFor user={u} onDone={done} />)}>
                      Password
                    </Button>
                    {u.totpEnabled && !u.you && (
                      <Button size="sm" variant="ghost" onClick={() => reset2fa(u)}>
                        Reset 2FA
                      </Button>
                    )}
                    {!u.you && (
                      <Button size="sm" variant="ghost" icon={<Trash2 />} iconOnly onClick={() => remove(u)}>
                        Delete {u.username}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function YourAccount({ username, role }: { username: string; role: 'admin' | 'viewer' }) {
  const [name, setName] = useState(username);
  const toast = useToast();
  const qc = useQueryClient();
  const save = async () => {
    await put('/api/auth/me', { username: name });
    toast(`You are now ${name.trim().toLowerCase()}`, 'ok');
    try {
      localStorage.setItem('hp_username', name.trim().toLowerCase());
    } catch {
      /* private mode */
    }
    await qc.invalidateQueries({ queryKey: ['auth'] });
  };
  return (
    <Panel title="Your account" description={ROLE_HELP[role]}>
      <div className="account-row">
        <Avatar name={username} />
        <Field label="Username">
          <div className="input-group">
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoComplete="username" spellCheck={false} />
            <Button onClick={save} disabled={!name || name === username}>
              Rename
            </Button>
          </div>
        </Field>
        <Badge tone={role === 'admin' ? 'sea' : undefined}>{role === 'admin' ? 'Admin' : 'Viewer'}</Badge>
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

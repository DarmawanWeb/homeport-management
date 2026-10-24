import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck, Smartphone, TerminalSquare } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/Shell';
import { Loading } from '../components/ui';
import { ApiError, post, UNAUTHORIZED_EVENT } from '../lib/api';
import { useAuth } from '../lib/queries';

/** Keeps the dashboard behind the right screen: first-run setup, sign-in, or "set it up on the Mac". */
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, refetch, error } = useAuth();
  const qc = useQueryClient();

  useEffect(() => {
    const onLost = () => void refetch();
    window.addEventListener(UNAUTHORIZED_EVENT, onLost);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onLost);
  }, [refetch]);

  const done = async () => {
    // Drop anything fetched while signed out, then load the dashboard fresh.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    await refetch();
  };

  if (error && !data)
    return (
      <AuthLayout>
        <h1>Homeport is not answering</h1>
        <p className="auth-lede">The dashboard server could not be reached. Check that it is running with pm2 ls on the Mac.</p>
      </AuthLayout>
    );
  if (!data) return <Loading />;
  if (!data.passwordSet) return data.local ? <SetupScreen onDone={done} /> : <LockedScreen />;
  if (!data.authenticated) return <LoginScreen onDone={done} />;
  return <>{children}</>;
}

// ---------------------------------------------------------------- layout

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-chart" aria-hidden="true">
        <ChartArt />
        <div className="auth-brand">
          <BrandMark />
          <span>Homeport</span>
        </div>
        <div className="auth-pitch">
          <p className="auth-kicker">Self-hosted deploys</p>
          <p className="auth-tag">
            Push to GitHub.
            <br />
            It runs on the Mac under your desk.
          </p>
        </div>
        <ul className="auth-facts">
          <li>Rollback on failed deploys</li>
          <li>Domains through Cloudflare Tunnel</li>
          <li>Prometheus and Grafana built in</li>
        </ul>
      </aside>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}

/** Depth contours and a compass rose, drawn rather than imported. */
function ChartArt() {
  const rings = [70, 120, 175, 235, 300, 370, 445];
  return (
    <svg className="auth-art" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="currentColor" strokeOpacity=".07" />
        </pattern>
      </defs>
      <rect width="600" height="800" fill="url(#grid)" />
      <g fill="none" stroke="currentColor">
        {rings.map((r, i) => (
          <path
            key={r}
            strokeOpacity={0.09 + i * 0.012}
            strokeDasharray={i % 3 === 2 ? '4 6' : undefined}
            d={`M ${470 - r} 610 C ${470 - r} ${610 - r * 1.15}, ${470 + r * 0.9} ${610 - r * 1.05}, ${470 + r} ${600 - r * 0.2} S ${470 + r * 0.4} ${610 + r * 0.95}, ${470 - r} 610 Z`}
          />
        ))}
      </g>
      <g transform="translate(470 610)" stroke="currentColor" fill="none" strokeOpacity=".35">
        <circle r="54" />
        <circle r="44" strokeDasharray="2 4" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <path key={a} transform={`rotate(${a})`} d={a % 90 === 0 ? 'M0 -70 L6 -8 L0 0 L-6 -8 Z' : 'M0 -44 L3 -6 L0 0 L-3 -6 Z'} />
        ))}
      </g>
      <g fill="currentColor" fillOpacity=".4" fontFamily="var(--font-code)" fontSize="11">
        <text x="70" y="640">
          12
        </text>
        <text x="210" y="520">
          18
        </text>
        <text x="330" y="420">
          24
        </text>
        <text x="120" y="300">
          31
        </text>
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- password strength

export function strength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (classes >= 3) score++;
  if (pw.length >= 20 || (pw.length >= 12 && classes === 4)) score++;
  if (pw.length < 10) score = 0;
  return { score: score as 0 | 1 | 2 | 3 | 4, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

export function StrengthMeter({ value }: { value: string }) {
  const s = strength(value);
  return (
    <div className="strength" data-score={value ? s.score : undefined}>
      <div className="strength-bars">
        {[1, 2, 3, 4].map((i) => (
          <i key={i} data-on={value && s.score >= i ? '' : undefined} />
        ))}
      </div>
      <span>{value ? s.label : 'At least 10 characters. A few unrelated words work well.'}</span>
    </div>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, setErr, submit };
}

const ErrorLine = ({ children }: { children: string }) =>
  children ? (
    <p className="auth-error" role="alert">
      {children}
    </p>
  ) : null;

// ---------------------------------------------------------------- screens

function SetupScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, err, submit } = useSubmit(async () => {
    if (pw !== pw2) throw new Error('The two passwords do not match');
    await post('/api/auth/setup', { password: pw });
    await onDone();
  });
  return (
    <AuthLayout>
      <span className="auth-icon">
        <LockKeyhole />
      </span>
      <h1>Set a dashboard password</h1>
      <p className="auth-lede">
        Homeport can run any command on this Mac, so it needs a password before it goes anywhere near the internet. You only do this once,
        here on the Mac.
      </p>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>New password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
        </label>
        <StrengthMeter value={pw} />
        <label className="field">
          <span>Repeat it</span>
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
        </label>
        <ErrorLine>{err}</ErrorLine>
        <button className="btn primary lg" type="submit" disabled={busy || strength(pw).score === 0}>
          {busy ? <span className="spin" /> : <ShieldCheck />}
          Save password and continue
        </button>
      </form>
      <p className="auth-foot">
        Forgot it later? Run <code>npm run reset-password</code> in the Homeport folder on the Mac.
      </p>
    </AuthLayout>
  );
}

function LoginScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [recovery, setRecovery] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const { busy, err, setErr, submit } = useSubmit(async () => {
    try {
      await post('/api/auth/login', { password: pw, code: step === 'code' ? code : undefined });
      await onDone();
    } catch (x) {
      if (x instanceof ApiError && x.data.totpRequired) {
        setStep('code');
        setTimeout(() => codeRef.current?.focus(), 0);
        return;
      }
      if (step === 'code') setCode('');
      throw x;
    }
  });

  // Submit as soon as six digits are in: that is what authenticator users expect.
  const onCode = (v: string) => {
    setErr('');
    const next = recovery ? v : v.replace(/\D/g, '').slice(0, 6);
    setCode(next);
    if (!recovery && next.length === 6) setTimeout(() => codeRef.current?.form?.requestSubmit(), 0);
  };

  return (
    <AuthLayout>
      <span className="auth-icon">{step === 'password' ? <KeyRound /> : <Smartphone />}</span>
      <h1>{step === 'password' ? 'Sign in' : 'Two-factor code'}</h1>
      <p className="auth-lede">
        {step === 'password'
          ? `Welcome back to ${location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? 'Homeport' : location.hostname}.`
          : recovery
            ? 'Enter one of the recovery codes you saved. Each one works once.'
            : 'Open your authenticator app and enter the 6-digit code for Homeport.'}
      </p>
      <form className="form" onSubmit={submit}>
        {step === 'password' ? (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setErr('');
              }}
              autoComplete="current-password"
              required
              // biome-ignore lint/a11y/noAutofocus: the only field on a sign-in screen
              autoFocus
            />
          </label>
        ) : (
          <label className="field">
            <span>{recovery ? 'Recovery code' : 'Code'}</span>
            <input
              ref={codeRef}
              className={recovery ? 'code' : 'code otp'}
              value={code}
              onChange={(e) => onCode(e.target.value)}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={recovery ? 'abcd-efgh' : '000000'}
              required
            />
          </label>
        )}
        <ErrorLine>{err}</ErrorLine>
        <button className="btn primary lg" type="submit" disabled={busy}>
          {busy ? <span className="spin" /> : <ArrowRight />}
          {step === 'password' ? 'Continue' : 'Verify and sign in'}
        </button>
        {step === 'code' && (
          <div className="auth-links">
            <button
              type="button"
              className="link"
              onClick={() => {
                setRecovery(!recovery);
                setCode('');
                setErr('');
              }}
            >
              {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setStep('password');
                setCode('');
                setErr('');
              }}
            >
              Back
            </button>
          </div>
        )}
      </form>
    </AuthLayout>
  );
}

function LockedScreen() {
  return (
    <AuthLayout>
      <span className="auth-icon">
        <TerminalSquare />
      </span>
      <h1>Finish setup on the Mac</h1>
      <p className="auth-lede">
        This dashboard has no password yet, so it only opens on the Mac itself. Open <code>http://127.0.0.1:7070</code> there and set one,
        then come back to this page.
      </p>
      <button className="btn lg" type="button" onClick={() => location.reload()}>
        I have set it, reload
      </button>
    </AuthLayout>
  );
}

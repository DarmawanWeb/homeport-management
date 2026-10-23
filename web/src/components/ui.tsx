import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useToast } from '../lib/toast';
import { useDialog } from '../lib/dialog';
import type { DeployStatus } from '../../../src/shared/types';

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm';
  /** Async handlers get a spinner and error toast automatically. */
  onClick?: () => unknown;
};

export function Button({ variant, size, onClick, children, className = '', disabled, type = 'button', ...rest }: BtnProps) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const handle = async () => {
    if (!onClick) return;
    const r = onClick();
    if (!(r instanceof Promise)) return;
    setBusy(true);
    try { await r; } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <button {...rest} type={type} disabled={disabled || busy} onClick={onClick ? handle : undefined}
      className={`btn ${variant ?? ''} ${size ?? ''} ${className}`}>
      {busy ? <span className="spin" /> : children}
    </button>
  );
}

export const Dot = ({ state, title }: { state?: 'ok' | 'err' | 'warn' | 'run' | ''; title?: string }) => <span className={`dot ${state ?? ''}`} title={title} />;

export const Pill = ({ state, children, title }: { state?: 'ok' | 'err' | 'warn' | 'run' | ''; children: ReactNode; title?: string }) => (
  <span className="pill" title={title}><Dot state={state} />{children}</span>
);

export const Tag = ({ tone, children, title }: { tone?: 'ok' | 'err' | 'warn' | 'run' | 'acc'; children: ReactNode; title?: string }) => (
  <span className={`tag ${tone ?? ''}`} title={title}>{children}</span>
);

const STATUS: Record<DeployStatus, [tone: 'ok' | 'err' | 'run' | undefined, label: string]> = {
  success: ['ok', 'berhasil'], failed: ['err', 'gagal'], running: ['run', 'berjalan'], queued: ['run', 'antri'],
  skipped: [undefined, 'dilewati'], interrupted: ['err', 'terputus'],
};
export const StatusTag = ({ status }: { status: DeployStatus }) => <Tag tone={STATUS[status][0]}>{STATUS[status][1]}</Tag>;

export const Banner = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="banner"><span className="grow">{children}</span>{action}</div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Toolbar({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="toolbar">
      <h2>{title}{count != null && <span className="sub"> ({count})</span>}</h2>
      {children}
    </div>
  );
}

export function Field({ label, hint, children, span }: { label: string; hint?: ReactNode; children: ReactNode; span?: number }) {
  return (
    <div className="field" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{children}</label>
  );
}

export function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return <div className="bar"><span style={{ width: `${pct.toFixed(1)}%` }} className={pct > 90 ? 'hot' : pct > 75 ? 'warm' : ''} /></div>;
}

/** Standard modal layout: header, scrollable body, footer actions. */
export function Modal({ title, children, footer, onSubmit }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onSubmit?: () => Promise<unknown> | void }) {
  const { close } = useDialog();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSubmit) return close();
    setBusy(true);
    try { await onSubmit(); } catch (err) { toast((err as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className={busy ? 'busy' : ''}>
      <div className="dlg-h"><h3>{title}</h3><button type="button" className="btn sm ghost" onClick={close} aria-label="Tutup">✕</button></div>
      <div className="dlg-b">{children}</div>
      <div className="dlg-f">{footer ?? <button type="button" className="btn" onClick={close}>Tutup</button>}</div>
    </form>
  );
}

export function SubmitButton({ children, variant = 'primary' }: { children: ReactNode; variant?: 'primary' | 'danger' }) {
  return <button type="submit" className={`btn ${variant}`}>{children}</button>;
}

export function CancelButton() {
  const { close } = useDialog();
  return <button type="button" className="btn" onClick={close}>Batal</button>;
}

export function CopyField({ value, mono }: { value: string; mono?: boolean }) {
  const toast = useToast();
  return (
    <div className="copy">
      <input readOnly value={value} className={mono ? 'mono' : ''} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn sm" onClick={() => { void navigator.clipboard.writeText(value); toast('Disalin', 'ok', 1500); }}>Salin</button>
    </div>
  );
}

/** Confirm dialog for destructive actions. */
export function Confirm({ title, children, confirmLabel = 'Hapus', onConfirm }: { title: string; children: ReactNode; confirmLabel?: string; onConfirm: () => Promise<unknown> }) {
  return (
    <Modal title={title} onSubmit={onConfirm} footer={<><CancelButton /><SubmitButton variant="danger">{confirmLabel}</SubmitButton></>}>
      {children}
    </Modal>
  );
}

import { X } from 'lucide-react';
import { type ButtonHTMLAttributes, type FormEvent, type ReactNode, useState } from 'react';
import type { DeployStatus } from '../../../src/shared/types';
import { useDialog } from '../lib/dialog';
import { useToast } from '../lib/toast';

// ---------------------------------------------------------------- buttons

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  variant?: 'primary' | 'danger' | 'ghost' | 'danger solid';
  size?: 'sm';
  icon?: ReactNode;
  iconOnly?: boolean;
  /** Async handlers get a spinner and an error toast automatically. */
  onClick?: () => unknown;
};

export function Button({
  variant,
  size,
  icon,
  iconOnly,
  onClick,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const handle = async () => {
    const r = onClick?.();
    if (!(r instanceof Promise)) return;
    setBusy(true);
    try {
      await r;
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const cls = ['btn', variant, size, iconOnly && 'icon', className].filter(Boolean).join(' ');
  return (
    <button {...rest} type={type} className={cls} disabled={disabled || busy} onClick={onClick ? handle : undefined}>
      {busy ? <span className="spin" /> : icon}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
    </button>
  );
}

// ---------------------------------------------------------------- status

export type Tone = 'ok' | 'err' | 'warn' | 'run' | 'sea' | undefined;

export const Light = ({ tone, label }: { tone?: Tone; label?: string }) =>
  label ? (
    <span className={`light ${tone ?? ''}`} role="img" aria-label={label} title={label} />
  ) : (
    <span className={`light ${tone ?? ''}`} aria-hidden="true" />
  );

export const Badge = ({ tone, children, light }: { tone?: Tone; children: ReactNode; light?: boolean }) => (
  <span className={`badge ${tone ?? ''}`}>
    {light && <Light tone={tone} />}
    {children}
  </span>
);

const DEPLOY: Record<DeployStatus, [Tone, string]> = {
  success: ['ok', 'Deployed'],
  failed: ['err', 'Failed'],
  running: ['run', 'Deploying'],
  queued: ['run', 'Queued'],
  skipped: [undefined, 'Superseded'],
  interrupted: ['err', 'Interrupted'],
};
export const DeployBadge = ({ status, rolledBack }: { status: DeployStatus; rolledBack?: boolean }) =>
  rolledBack ? <Badge tone="warn">Rolled back</Badge> : <Badge tone={DEPLOY[status][0]}>{DEPLOY[status][1]}</Badge>;

// ---------------------------------------------------------------- layout pieces

export function PageHead({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {back}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions btn-row">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  flush,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="actions btn-row">{actions}</div>}
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export const Loading = () => (
  <div className="empty">
    <span className="spin" />
  </div>
);

export function Notice({ icon, children, action, tone }: { icon?: ReactNode; children: ReactNode; action?: ReactNode; tone?: 'err' }) {
  return (
    <div className={`notice${tone ? ` ${tone}` : ''}`}>
      {icon}
      <span className="grow">{children}</span>
      {action}
    </div>
  );
}

export function Meter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    // Decorative: the number next to it carries the value for screen readers.
    <div className="meter" aria-hidden="true">
      <span style={{ width: `${pct.toFixed(1)}%` }} className={pct > 90 ? 'hot' : pct > 75 ? 'warm' : ''} />
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset className="seg">
      <legend className="sr-only">{label}</legend>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------- forms

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className={`field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {children}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function CopyField({ value, code }: { value: string; code?: boolean }) {
  const toast = useToast();
  return (
    <div className="input-group">
      <input readOnly value={value} className={code ? 'code' : ''} onFocus={(e) => e.target.select()} aria-label="Value to copy" />
      <button
        type="button"
        className="btn"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast('Copied', 'ok', 1500);
        }}
      >
        Copy
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- modals

/** Standard modal: header, scrolling body, footer actions. `onSubmit` makes it a form. */
export function Modal({
  title,
  children,
  footer,
  onSubmit,
  submitLabel,
  danger,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => unknown;
  submitLabel?: string;
  danger?: boolean;
}) {
  const { close } = useDialog();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSubmit) return close();
    setBusy(true);
    try {
      await onSubmit();
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="btn ghost icon" onClick={close} aria-label="Close">
          <X />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      <div className="modal-foot">
        {footer ??
          (onSubmit ? (
            <>
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy}>
                {busy && <span className="spin" />}
                {submitLabel ?? 'Save'}
              </button>
            </>
          ) : (
            <button type="submit" className={`btn${submitLabel ? ' primary' : ''}`}>
              {submitLabel ?? 'Close'}
            </button>
          ))}
      </div>
    </form>
  );
}

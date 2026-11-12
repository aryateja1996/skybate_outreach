import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const styles = {
    primary: 'bg-rail text-paper hover:bg-ink',
    secondary: 'bg-card text-ink border border-line hover:border-ink',
    danger: 'bg-bad text-white hover:bg-ink',
    ghost: 'bg-transparent text-ink hover:bg-line/60',
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-sm text-bad">{error}</span> : null}
    </label>
  );
}

export const inputClass = 'w-full border border-line bg-card px-3 py-2 text-sm text-ink';

export function Banner({ tone, children }: { tone: 'warn' | 'info' | 'bad'; children: ReactNode }) {
  const styles = {
    warn: 'border-warn/30 bg-[#f8efd8] text-warn',
    info: 'border-tide/20 bg-[#e7f0f5] text-tide',
    bad: 'border-bad/20 bg-[#f8e8e6] text-bad',
  }[tone];
  return <div className={`border px-4 py-3 text-sm leading-6 ${styles}`}>{children}</div>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-lg bg-card p-6 shadow-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className="font-serif text-2xl">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</p>;
}

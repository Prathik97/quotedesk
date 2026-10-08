// Small shared pieces. Plain elements with visible focus; labels on every control.
import { Database } from 'lucide-react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { StoredRun } from '@/lib/api-types';

export function StoredLabel({ stored, className }: { stored: StoredRun | null | undefined; className?: string }) {
  if (!stored) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
      <Database size={12} aria-hidden />
      {stored.label}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'default' | 'ghost' | 'danger'; small?: boolean };

export function Btn({ variant = 'default', small, className, ...p }: BtnProps) {
  return (
    <button
      type="button"
      {...p}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variant === 'primary' && 'border-accent bg-accent text-accent-foreground hover:bg-teal-800',
        variant === 'default' && 'border-border bg-card text-foreground hover:bg-muted',
        variant === 'ghost' && 'border-transparent bg-transparent text-foreground hover:bg-muted',
        variant === 'danger' && 'border-red-300 bg-card text-status-conflict hover:bg-red-50',
        className,
      )}
    />
  );
}

export function Chip({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'border-border bg-muted text-ink-2',
        tone === 'good' && 'border-green-200 bg-green-50 text-status-confirmed',
        tone === 'warn' && 'border-amber-200 bg-amber-50 text-status-assumed',
        tone === 'bad' && 'border-red-200 bg-red-50 text-status-conflict',
        tone === 'accent' && 'border-teal-200 bg-teal-50 text-accent',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PageTitle({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {sub ? <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-status-conflict">
      <p>{message}</p>
      {onRetry ? (
        <Btn small className="mt-2" onClick={onRetry}>
          Try again
        </Btn>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Loading {what}
    </p>
  );
}

export function Card({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('rounded-lg border border-border bg-card', className)}>
      {children}
    </div>
  );
}

export function pipelineTone(p: string): 'good' | 'warn' | 'neutral' | 'accent' {
  return p === 'Ready' ? 'good' : p === 'Needs review' ? 'warn' : p === 'Extracted' ? 'accent' : 'neutral';
}

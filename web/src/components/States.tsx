import { AlertTriangle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Skeleton as UiSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Button } from './Button';

/** A neutral block that stands in for content of the same size while it loads. */
export function Skeleton({ className }: { className?: string }) {
  return <UiSkeleton aria-hidden="true" className={cn('h-4 w-full', className)} />;
}

/** Wraps skeletons so assistive tech hears one "Loading" instead of nothing. */
export function Loading({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div aria-busy="true" className={className}>
      <span className="sr-only">Loading {label}</span>
      {children}
    </div>
  );
}

export function SkeletonRows({ rows = 5, className = 'h-11' }: { rows?: number; className?: string }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={className} />
      ))}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  /** A lucide icon that hints at what belongs here. */
  icon?: LucideIcon;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** What a list shows when it has nothing: what would be here, and the next step. */
export function EmptyState({ title, icon: Icon, children, action, className }: EmptyStateProps) {
  return (
    <div className={cn('bg-grid flex flex-col items-start gap-3 rounded-xl border border-dashed p-6 sm:p-8', className)}>
      {Icon && (
        <span className="flex size-9 items-center justify-center rounded-lg border bg-card shadow-card">
          <Icon className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        </span>
      )}
      <p className="text-[0.9375rem] font-semibold tracking-tight">{title}</p>
      {children && <div className="grid max-w-prose gap-3 text-sm text-pretty text-muted-foreground">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}

/** Plain-language summary of a failed request. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'It does not exist on this instance, or it has been removed.';
    if (error.status === 401) return 'Your session has ended. Sign in and try again.';
    if (error.status === 403) return 'Your account is not allowed to do this.';
    if (error.status === 429) return 'Too many requests. Wait a moment and try again.';
    const fields = error.problem?.errors?.map((entry) => entry.message).filter(Boolean) ?? [];
    if (fields.length > 0) return fields.join(' ');
    if (error.status >= 500) return error.problem?.detail ?? 'The server ran into a problem. This is not your fault.';
    return error.message;
  }
  return 'The server could not be reached. Check your connection, or the instance may be down.';
}

interface ErrorStateProps {
  /** What failed, e.g. "Couldn't load projects". */
  title: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title, error, onRetry, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-6', className)}>
      <span className="flex size-9 items-center justify-center rounded-lg border border-destructive/30 bg-card">
        <AlertTriangle className="size-4 text-destructive" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <p className="text-[0.9375rem] font-semibold tracking-tight">{title}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{describeError(error)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

interface NoticeProps {
  /** `strong` is for things that need attention; `plain` is informational. */
  tone?: 'plain' | 'strong';
  title?: string;
  icon?: LucideIcon;
  children: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}

export function Notice({ tone = 'plain', title, icon: Icon, children, role, className }: NoticeProps) {
  return (
    <div
      role={role}
      className={cn(
        'flex gap-3 rounded-lg border p-3.5 text-sm',
        tone === 'strong' ? 'border-foreground/25 bg-muted/60' : 'bg-muted/30',
        className,
      )}
    >
      {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />}
      <div className="grid min-w-0 flex-1 gap-1.5">
        {title && <p className="font-semibold">{title}</p>}
        <div className="min-w-0 text-muted-foreground [&>*+*]:mt-2 [&_code]:text-foreground [&_strong]:text-foreground">{children}</div>
      </div>
    </div>
  );
}

interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  label?: string;
}

export function LoadMore({ hasMore, loading, onLoad, label = 'Load more' }: LoadMoreProps) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center pt-6">
      <Button onClick={onLoad} busy={loading} busyLabel="Loading…">
        {label}
      </Button>
    </div>
  );
}

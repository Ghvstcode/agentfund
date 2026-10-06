import type { CSSProperties, ReactNode } from 'react';
import { ApiError } from '../api/client';
import { Button } from './Button';

interface SkeletonProps {
  width?: string;
  height?: string;
}

/** A neutral block that stands in for content of the same size while it loads. */
export function Skeleton({ width = '100%', height = '1em' }: SkeletonProps) {
  return <span className="skeleton" style={{ width, height } as CSSProperties} aria-hidden="true" />;
}

/** Wraps skeletons so assistive tech hears one "Loading" instead of nothing. */
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="loading" aria-busy="true">
      <span className="sr-only">Loading {label}</span>
      {children}
    </div>
  );
}

export function SkeletonRows({ rows = 5, height = '2.75rem' }: { rows?: number; height?: string }) {
  return (
    <div className="skeleton-rows">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} />
      ))}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {children && <div className="state__body">{children}</div>}
      {action && <div className="state__action">{action}</div>}
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
}

export function ErrorState({ title, error, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      <p className="state__body">{describeError(error)}</p>
      {onRetry && (
        <div className="state__action">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

interface NoticeProps {
  /** `strong` draws a full-contrast border for things that need attention. */
  tone?: 'plain' | 'strong';
  title?: string;
  children: ReactNode;
  role?: 'alert' | 'status';
}

export function Notice({ tone = 'plain', title, children, role }: NoticeProps) {
  return (
    <div className={`notice notice--${tone}`} role={role}>
      {title && <p className="notice__title">{title}</p>}
      <div className="notice__body">{children}</div>
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
    <div className="load-more">
      <Button onClick={onLoad} busy={loading} busyLabel="Loading…">
        {label}
      </Button>
    </div>
  );
}

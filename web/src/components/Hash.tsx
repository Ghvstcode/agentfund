import { Check, Copy } from 'lucide-react';
import { shortHash } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCopy } from './CopyButton';

interface HashProps {
  /** Full value; this is what lands on the clipboard and in the tooltip. */
  value: string;
  /** What the value is, e.g. "commit" or "key fingerprint". */
  label: string;
  /** Characters of the hash body to show. */
  length?: number;
  className?: string;
}

/** A short hash chip that copies its full value on click. */
export function Hash({ value, label, length = 7, className }: HashProps) {
  const { copied, copy } = useCopy(value);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      title={`${value} (click to copy)`}
      aria-label={`Copy ${label} ${shortHash(value, 12)}`}
      onClick={() => void copy()}
      className={cn(
        'num group/hash inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-1.5 text-xs text-foreground transition-colors hover:bg-muted',
        className,
      )}
    >
      <span aria-hidden="true" className="truncate">
        {shortHash(value, length)}
      </span>
      <Icon
        className={cn('size-3 shrink-0 text-muted-foreground transition-opacity', !copied && 'opacity-60 group-hover/hash:opacity-100')}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

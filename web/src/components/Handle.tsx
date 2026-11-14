import { splitHandle } from '@/lib/handles';
import { cn } from '@/lib/utils';

interface HandleProps {
  handle: string;
  /** Classes for the `@host` part, e.g. a wider cap where there is room for the full host. */
  hostClassName?: string;
  /** On a phone, put the host on a line of its own under the name. For tight table columns. */
  stackOnNarrow?: boolean;
  className?: string;
}

/**
 * A donor handle as text. A donor whose home is a peer instance reads `alice@fund.example`:
 * the name keeps the surrounding weight and colour, the home host follows it dimmer and gives
 * way first (with an ellipsis) when space runs out. The full handle is in the tooltip.
 */
export function Handle({ handle, hostClassName, stackOnNarrow = false, className }: HandleProps) {
  const { name, host } = splitHandle(handle);
  if (!host) return <span className={className}>{handle}</span>;
  return (
    <span
      title={handle}
      className={cn('inline-flex max-w-full min-w-0 items-baseline', stackOnNarrow && 'max-sm:flex-col max-sm:items-start', className)}
    >
      <span className="shrink-0">{name}</span>
      <span
        className={cn(
          'max-w-28 min-w-0 truncate font-normal text-muted-foreground sm:max-w-48',
          stackOnNarrow && 'max-sm:max-w-[4.25rem] max-sm:text-xs',
          hostClassName,
        )}
      >
        @{host}
      </span>
    </span>
  );
}

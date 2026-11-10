import { cn } from '@/lib/utils';

/**
 * The AgentFund mark: five tokens on a triangular lattice. The empty bottom-centre slot is the
 * counter of the A; only the top token is green, because a token counts only after CI passes.
 * The other four take the text colour, so the mark inverts with the theme.
 */
export function Mark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('size-5 shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <circle cx="50" cy="21.13" r="15.4" className="fill-pass" />
      <circle cx="33.33" cy="50" r="15.4" fill="currentColor" />
      <circle cx="66.67" cy="50" r="15.4" fill="currentColor" />
      <circle cx="16.67" cy="78.87" r="15.4" fill="currentColor" />
      <circle cx="83.33" cy="78.87" r="15.4" fill="currentColor" />
    </svg>
  );
}

export type TokenState = 'pledged' | 'running' | 'reported' | 'delivered' | 'merged';

/** One token in a ledger state, the shape every chart and legend on the home page is made of. */
export function TokenDot({ state, className }: { state: TokenState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        state === 'pledged' && 'border-[1.5px] border-input',
        state === 'running' && 'border-2 border-pass',
        state === 'reported' && 'bg-muted-foreground',
        state === 'delivered' && 'bg-pass',
        state === 'merged' && 'bg-foreground',
        className,
      )}
    />
  );
}

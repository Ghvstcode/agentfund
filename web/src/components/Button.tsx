import { Loader2 } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { Button as UiButton, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'quiet' | 'live';
type Size = 'sm' | 'md' | 'lg';

interface Appearance {
  variant?: Variant;
  size?: Size;
}

const VARIANTS = { primary: 'default', secondary: 'outline', quiet: 'ghost', live: 'default' } as const;
const SIZES = { sm: 'sm', md: 'default', lg: 'lg' } as const;

/** `lg` is the one tall button (primary calls to action); `live` is the accent-filled CTA. */
function extras({ variant = 'secondary', size = 'md' }: Appearance, className?: string) {
  return cn(
    size === 'lg' && 'h-10 px-4 text-sm font-semibold',
    variant === 'live' &&
      'bg-live text-live-foreground shadow-[0_0_0_1px_color-mix(in_oklab,var(--live)_60%,transparent),0_8px_24px_-8px_var(--live)] hover:bg-live/90',
    className,
  );
}

interface ButtonProps extends Omit<ComponentProps<typeof UiButton>, 'variant' | 'size'>, Appearance {
  /** Shows a spinner and `busyLabel`, and blocks clicks, while an action is in progress. */
  busy?: boolean;
  busyLabel?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', busy = false, busyLabel, children, className, ...rest }: ButtonProps) {
  return (
    <UiButton
      // `asChild` hands the props to a link, where a button type would be wrong.
      type={rest.asChild ? undefined : 'button'}
      {...rest}
      variant={VARIANTS[variant]}
      size={SIZES[size]}
      className={extras({ variant, size }, className)}
      aria-disabled={busy || undefined}
      onClick={busy ? (event) => event.preventDefault() : rest.onClick}
    >
      {rest.asChild ? (
        // Slot needs exactly one child element to merge into.
        children
      ) : (
        <>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {busy ? (busyLabel ?? children) : children}
        </>
      )}
    </UiButton>
  );
}

/** A router link that looks like a button. */
export function ButtonLink({ variant = 'secondary', size = 'md', className, ...rest }: LinkProps & Appearance) {
  return (
    <Link
      {...rest}
      className={cn(buttonVariants({ variant: VARIANTS[variant], size: SIZES[size] }), extras({ variant, size }, className))}
    />
  );
}

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

type Variant = 'primary' | 'secondary' | 'quiet';
type Size = 'md' | 'sm' | 'lg';

interface Appearance {
  variant?: Variant;
  size?: Size;
}

function className({ variant = 'secondary', size = 'md' }: Appearance, extra?: string): string {
  return ['button', `button--${variant}`, `button--${size}`, extra].filter(Boolean).join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Appearance {
  /** Shows `busyLabel` and blocks further clicks while an action is in progress. */
  busy?: boolean;
  busyLabel?: ReactNode;
}

export function Button({ variant, size, busy = false, busyLabel, children, className: extra, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={className({ variant, size }, extra)}
      aria-disabled={busy || undefined}
      onClick={busy ? (event) => event.preventDefault() : rest.onClick}
    >
      {busy ? (busyLabel ?? children) : children}
    </button>
  );
}

/** A router link that looks like a button. */
export function ButtonLink({ variant, size, className: extra, ...rest }: LinkProps & Appearance) {
  return <Link {...rest} className={className({ variant, size }, extra)} />;
}

import { cn } from '@/lib/utils';

interface HandleAvatarProps {
  handle: string;
  /** Tailwind size class, e.g. `size-5`. */
  className?: string;
}

/** The handle's initial on a quiet disc. Decorative: the handle is always next to it. */
export function HandleAvatar({ handle, className }: HandleAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'num inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] leading-none font-semibold text-foreground',
        className,
      )}
    >
      {handle.charAt(0)}
    </span>
  );
}

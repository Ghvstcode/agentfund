import { cn } from '@/lib/utils';

/** Small stable hash of a string. */
function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  return value >>> 0;
}

/** Deterministic monochrome gradient for a handle: same handle, same avatar, no network. */
export function avatarGradient(handle: string): string {
  const seed = hash(handle);
  const angle = seed % 360;
  const from = 22 + ((seed >>> 8) % 22);
  const to = 58 + ((seed >>> 16) % 30);
  return `linear-gradient(${angle}deg, hsl(240 4% ${from}%), hsl(240 5% ${to}%))`;
}

interface HandleAvatarProps {
  handle: string;
  /** Tailwind size class, e.g. `size-5`. */
  className?: string;
}

/** Initial-on-gradient avatar generated from the handle. Decorative: the handle is always next to it. */
export function HandleAvatar({ handle, className }: HandleAvatarProps) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundImage: avatarGradient(handle) }}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[0.625rem] leading-none font-semibold text-white uppercase ring-1 ring-black/10 ring-inset dark:ring-white/15',
        className,
      )}
    >
      {handle.charAt(0)}
    </span>
  );
}

import { HandleAvatar } from './HandleAvatar';

/** The pill that opens the account menu; also what shows while the menu code loads. */
export function UserPill({ handle, ...button }: { handle: string } & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={`Account menu for ${handle}`}
      {...button}
      className="flex h-8 items-center gap-2 rounded-full border bg-card py-0.5 pr-2.5 pl-0.5 text-sm font-medium shadow-card transition-colors hover:bg-muted"
    >
      <HandleAvatar handle={handle} className="size-6 text-xs" />
      <span className="max-w-24 truncate">{handle}</span>
    </button>
  );
}

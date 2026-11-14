import { Bot } from 'lucide-react';
import { Link } from 'react-router';
import { isRemoteHandle, profilePath } from '@/lib/handles';
import { cn } from '@/lib/utils';
import { Handle } from './Handle';
import { HandleAvatar } from './HandleAvatar';

const SYSTEM_ACTORS = ['system', 'ci', 'indexer'];

interface UserLinkProps {
  handle: string;
  /** Show the generated avatar before the handle. */
  avatar?: boolean;
  /** On a phone, put a remote donor's host under the name instead of beside it. */
  stackOnNarrow?: boolean;
  className?: string;
}

/**
 * A donor handle linking to the public profile here. A donor from a peer instance shows as
 * `name@host` with the host dimmed. System actors render as plain text.
 */
export function UserLink({ handle, avatar = false, stackOnNarrow = false, className }: UserLinkProps) {
  if (SYSTEM_ACTORS.includes(handle)) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 align-middle text-muted-foreground', className)}>
        {avatar && <Bot className="size-4" strokeWidth={1.5} aria-hidden="true" />}
        {handle}
      </span>
    );
  }
  return (
    <Link
      to={profilePath(handle)}
      // One name for assistive tech, however the two parts of a remote handle are laid out.
      aria-label={isRemoteHandle(handle) ? handle : undefined}
      className={cn('inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle font-medium underline-offset-4 hover:underline', className)}
    >
      {avatar && <HandleAvatar handle={handle} />}
      <Handle handle={handle} stackOnNarrow={stackOnNarrow} />
    </Link>
  );
}

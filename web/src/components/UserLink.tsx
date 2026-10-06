import { Bot } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { HandleAvatar } from './HandleAvatar';

const SYSTEM_ACTORS = ['system', 'ci', 'indexer'];

interface UserLinkProps {
  handle: string;
  /** Show the generated avatar before the handle. */
  avatar?: boolean;
  className?: string;
}

/** A donor handle linking to the public profile. System actors render as plain text. */
export function UserLink({ handle, avatar = false, className }: UserLinkProps) {
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
      to={`/u/${handle}`}
      className={cn('inline-flex items-center gap-1.5 align-middle font-medium underline-offset-4 hover:underline', className)}
    >
      {avatar && <HandleAvatar handle={handle} />}
      {handle}
    </Link>
  );
}

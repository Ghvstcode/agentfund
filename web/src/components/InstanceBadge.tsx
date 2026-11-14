import { Globe } from 'lucide-react';
import type { PeerRef } from '@/api/types';
import { cn } from '@/lib/utils';

/** The host of another instance, as a chip the size of a status chip. Marks anything that lives somewhere else. */
export function InstanceBadge({ instance, className }: { instance: PeerRef; className?: string }) {
  return (
    <span
      title={`${instance.name} · ${instance.base_url}`}
      className={cn(
        'inline-flex h-5 max-w-full min-w-0 items-center gap-1 border px-1.5 text-[0.6875rem] text-foreground',
        className,
      )}
    >
      <Globe className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <span className="num truncate">{instance.host}</span>
    </span>
  );
}

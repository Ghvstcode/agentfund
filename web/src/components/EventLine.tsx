import {
  CircleCheck,
  CircleX,
  FileCode2,
  FileText,
  FolderGit2,
  GitMerge,
  HandCoins,
  type LucideIcon,
  Play,
  RotateCcw,
  TimerOff,
  Undo2,
} from 'lucide-react';
import { Link } from 'react-router';
import type { AuditEvent } from '@/api/types';
import { eventTokens, eventVerb, isDeliveryEvent, manifestId } from '@/lib/events';
import { cn } from '@/lib/utils';
import { Num } from './Num';
import { Time } from './Time';
import { UserLink } from './UserLink';

const ICONS: Record<string, LucideIcon> = {
  'task.claimed': Play,
  'report.received': FileText,
  'report.late': FileText,
  'task.delivered': CircleCheck,
  'task.merged': GitMerge,
  'task.reopened': RotateCcw,
  'pledge.created': HandCoins,
  'claim.released': Undo2,
  'claim.expired': TimerOff,
};

/** Icon for an audit action; whole families share one when no exact match exists. */
export function eventIcon(event: AuditEvent): LucideIcon {
  if (event.action === 'ci.result') return event.payload?.conclusion === 'success' ? CircleCheck : CircleX;
  if (event.action.startsWith('manifest.')) return FileCode2;
  if (event.action.startsWith('project.')) return FolderGit2;
  return ICONS[event.action] ?? FileText;
}

interface EventLineProps {
  event: AuditEvent;
  /** Leave the project out when the surrounding page is already about it. */
  showProject?: boolean;
  /** Play the entrance animation: for events that just arrived over the live stream. */
  fresh?: boolean;
}

/** One audit event as a sentence: who did what to which task, with tokens and time. */
export function EventLine({ event, showProject = true, fresh = false }: EventLineProps) {
  const tokens = eventTokens(event);
  const delivery = isDeliveryEvent(event);
  const Icon = eventIcon(event);
  return (
    <div className={cn('flex gap-3 py-3', fresh && 'animate-enter')}>
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card',
          delivery ? 'border-live/30 text-live' : 'text-muted-foreground',
        )}
      >
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm leading-snug [overflow-wrap:anywhere]">
          {event.actor ? <UserLink handle={event.actor} /> : <span className="text-muted-foreground">someone</span>}{' '}
          <span className="text-muted-foreground">{eventVerb(event.action)}</span>{' '}
          {event.task_id && event.project ? (
            <Link to={`/${event.project}/tasks/${manifestId(event.task_id)}`} className="num text-[0.8125rem] underline-offset-4 hover:underline">
              {manifestId(event.task_id)}
            </Link>
          ) : (
            !showProject && <span className="text-muted-foreground">the project</span>
          )}
          {showProject && event.project && (
            <>
              <span className="text-muted-foreground">{event.task_id ? ' in ' : ''}</span>
              <Link to={`/${event.project}`} className="font-medium underline-offset-4 hover:underline">
                {event.project}
              </Link>
            </>
          )}
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {tokens !== null && <Num value={tokens} className={cn(delivery && 'font-medium text-foreground')} />}
          <Time value={event.at} />
        </p>
      </div>
    </div>
  );
}

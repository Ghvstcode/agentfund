import { Link } from 'react-router';
import type { AuditEvent } from '../api/types';
import { eventTokens, eventVerb, isDeliveryEvent, manifestId } from '../lib/events';
import { Num } from './Num';
import { Time } from './Time';
import { UserLink } from './UserLink';

interface EventLineProps {
  event: AuditEvent;
  /** Leave the project out when the surrounding page is already about it. */
  showProject?: boolean;
}

/** One audit event as a sentence: who did what to which task, with tokens and time. */
export function EventLine({ event, showProject = true }: EventLineProps) {
  const tokens = eventTokens(event);
  return (
    <div className="event-line" data-delivery={isDeliveryEvent(event) || undefined}>
      <p className="event-line__text">
        {event.actor ? <UserLink handle={event.actor} /> : <span className="actor">someone</span>}{' '}
        {eventVerb(event.action)}{' '}
        {event.task_id && event.project ? (
          <Link to={`/${event.project}/tasks/${manifestId(event.task_id)}`} className="mono">
            {manifestId(event.task_id)}
          </Link>
        ) : (
          !showProject && 'the project'
        )}
        {showProject && event.project && (
          <>
            {event.task_id ? ' in ' : ''}
            <Link to={`/${event.project}`}>{event.project}</Link>
          </>
        )}
      </p>
      <p className="event-line__meta">
        {tokens !== null && <Num value={tokens} />}
        <Time value={event.at} />
      </p>
    </div>
  );
}

import type { AuditEvent } from '../api/types';

const VERBS: Record<string, string> = {
  'project.created': 'registered',
  'project.repinned': 're-pinned',
  'project.paused': 'paused',
  'project.resumed': 'resumed',
  'project.index_failed': 'failed to index',
  'manifest.added': 'added the manifest for',
  'manifest.changed': 'changed the manifest for',
  'manifest.removed': 'removed the manifest for',
  'pledge.created': 'pledged to',
  'task.claimed': 'claimed',
  'claim.released': 'released',
  'claim.expired': 'let the lease expire on',
  'report.received': 'reported a run on',
  'report.late': 'reported late on',
  'ci.result': 'recorded a CI result for',
  'task.delivered': 'confirmed delivery of',
  'task.merged': 'recorded the merge of',
  'task.reopened': 'reopened',
};

/** Past-tense phrase for an audit action; unknown actions fall back to the raw dotted verb. */
export function eventVerb(action: string): string {
  return VERBS[action] ?? action;
}

/** The manifest id part of `<slug>:<manifest id>`. */
export function manifestId(taskRef: string): string {
  return taskRef.slice(taskRef.indexOf(':') + 1);
}

/** Token amount carried by an event, when its payload has one. Payloads are free-form. */
export function eventTokens(event: AuditEvent): number | null {
  const tokens = event.payload?.tokens;
  return typeof tokens === 'number' ? tokens : null;
}

/** Events that move a counter the visitor cares about; used to highlight the feed. */
export function isDeliveryEvent(event: AuditEvent): boolean {
  return event.action === 'task.delivered' || event.action === 'task.merged';
}

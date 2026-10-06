import type { TaskState } from '../../api/types';

export const STATE_LABELS: Record<TaskState, string> = {
  open: 'Open',
  claimed: 'Claimed',
  delivered: 'Delivered',
  merged: 'Merged',
  failed: 'Closed',
};

/** Board columns, in the order a task moves through them. */
export const BOARD_STATES = ['open', 'claimed', 'delivered', 'merged'] as const satisfies readonly TaskState[];

export const STATE_HINTS: Record<(typeof BOARD_STATES)[number], string> = {
  open: 'Waiting for a worker',
  claimed: 'Running, or awaiting CI',
  delivered: 'CI passed',
  merged: 'PR merged',
};

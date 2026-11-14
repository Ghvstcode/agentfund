import { Ban, CircleCheck, CircleDashed, GitMerge, Hourglass, LockKeyhole, type LucideIcon, Play } from 'lucide-react';
import type { Task, TaskState } from '@/api/types';

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
  delivered: 'CI passed, awaiting merge',
  merged: 'In main',
};

export const STATE_ICONS: Record<TaskState, LucideIcon> = {
  open: CircleDashed,
  claimed: Play,
  delivered: CircleCheck,
  merged: GitMerge,
  failed: Ban,
};

export interface TaskStatus {
  icon: LucideIcon;
  /** Short phrase for the precise situation: finer-grained than the column. */
  label: string;
  /** True while a worker is running it right now. */
  live: boolean;
}

/** What is actually going on with a task, beyond its coarse state. */
export function taskStatus(task: Task): TaskStatus {
  if (task.active_claim) return { icon: Play, label: 'Running', live: true };
  if (task.state === 'claimed') return { icon: Hourglass, label: 'Awaiting CI', live: false };
  if (task.state === 'open' && task.blocked_by.length > 0) return { icon: LockKeyhole, label: 'Blocked', live: false };
  if (task.state === 'open') return { icon: CircleDashed, label: task.claimable ? 'Claimable' : 'Open', live: false };
  return { icon: STATE_ICONS[task.state], label: STATE_LABELS[task.state], live: false };
}

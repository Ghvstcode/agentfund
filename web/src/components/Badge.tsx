import type { ReactNode } from 'react';

interface BadgeProps {
  /** `live` is the accent tone: only for things happening right now. */
  tone?: 'plain' | 'strong' | 'live';
  children: ReactNode;
}

export function Badge({ tone = 'plain', children }: BadgeProps) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

import { useEffect, useRef, useState } from 'react';
import { api, unwrap } from '../api/client';
import { useMeta } from '../api/queries';
import type { AuditEvent, StreamTotals } from '../api/types';
import { apiUrl } from '../config';
import { type LiveStatus, startLiveStream } from '../lib/live-stream';

async function pollInstance(): Promise<StreamTotals> {
  const stats = await unwrap(api.GET('/v1/stats'));
  return { scope: 'instance', totals: stats.totals };
}

async function pollProject(slug: string): Promise<StreamTotals> {
  const project = await unwrap(api.GET('/v1/projects/{slug}', { params: { path: { slug } } }));
  return {
    scope: 'project',
    project: slug,
    totals: project.totals,
    token_goal: project.token_goal,
    tasks: project.tasks,
  };
}

export interface Live {
  /** Latest totals frame, or null until the first one arrives. */
  frame: StreamTotals | null;
  status: LiveStatus;
}

/**
 * Live totals for the instance, or for one project when `project` is given. `onEvent`
 * receives every audit event in scope as it happens.
 */
export function useLive(project?: string, onEvent?: (event: AuditEvent) => void): Live {
  // Until /v1/meta answers, assume SSE works; a wrong guess only costs one failed attempt.
  const sse = useMeta().data?.capabilities.sse ?? true;
  const [state, setState] = useState<Live & { scope: string | undefined }>({
    frame: null,
    status: 'connecting',
    scope: project,
  });
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const query = project ? `?project=${encodeURIComponent(project)}` : '';
    return startLiveStream({
      url: apiUrl(`/v1/stream${query}`),
      sse,
      poll: () => (project ? pollProject(project) : pollInstance()),
      onTotals: (frame) => setState((previous) => ({ ...previous, frame, scope: project })),
      onEvent: (event) => handler.current?.(event),
      onStatus: (status) => setState((previous) => ({ ...previous, status, scope: project })),
    });
  }, [project, sse]);

  // A frame from the previous project must not be shown while the new stream connects.
  return state.scope === project ? state : { frame: null, status: 'connecting' };
}

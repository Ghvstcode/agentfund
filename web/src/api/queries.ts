import {
  type InfiniteData,
  QueryClient,
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSession } from '../hooks/useSession';
import { api, ApiError, unwrap } from './client';
import type { paths } from './schema';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Client errors are answers, not outages; only retry what might succeed.
        retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
        retryDelay: 600,
      },
    },
  });
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const nextCursor = (page: { next_cursor: string | null }) => page.next_cursor ?? undefined;

/** Flatten the pages of a cursor-paginated list. */
export function flatItems<T>(query: UseInfiniteQueryResult<InfiniteData<Page<T>>>): T[] {
  return query.data?.pages.flatMap((page) => page.items) ?? [];
}

export type ProjectFilters = Omit<NonNullable<paths['/v1/projects']['get']['parameters']['query']>, 'cursor'>;

export const queryKeys = {
  meta: ['meta'] as const,
  stats: ['stats'] as const,
  me: (token: string | null) => ['me', token] as const,
  projects: (filters: ProjectFilters) => ['projects', filters] as const,
  project: (slug: string) => ['project', slug] as const,
  tasks: (slug: string) => ['project', slug, 'tasks'] as const,
  task: (slug: string, manifestId: string) => ['project', slug, 'task', manifestId] as const,
  // Outside the `project` prefix on purpose: live events must not refetch a secret.
  webhook: (slug: string) => ['webhook', slug] as const,
  ledger: (slug: string) => ['project', slug, 'ledger'] as const,
  projectEvents: (slug: string) => ['project', slug, 'events'] as const,
  events: ['events'] as const,
  deliveryEvents: ['events', 'deliveries'] as const,
  donors: ['donors'] as const,
  donor: (handle: string) => ['donor', handle] as const,
  apiKeys: ['me', 'api-keys'] as const,
  myClaims: ['me', 'claims'] as const,
  adminUsers: (q: string) => ['admin', 'users', q] as const,
  adminProjects: ['admin', 'projects'] as const,
  instance: ['admin', 'instance'] as const,
};

export function useMeta() {
  return useQuery({
    queryKey: queryKeys.meta,
    queryFn: () => unwrap(api.GET('/v1/meta')),
    staleTime: Infinity,
  });
}

export function useStats() {
  return useQuery({ queryKey: queryKeys.stats, queryFn: () => unwrap(api.GET('/v1/stats')) });
}

/** The signed-in user, or `data: undefined` when there is no session. */
export function useMe() {
  const token = useSession();
  return useQuery({
    queryKey: queryKeys.me(token),
    queryFn: () => unwrap(api.GET('/v1/me')),
    enabled: token !== null,
    staleTime: 60_000,
  });
}

export function useProjects(filters: ProjectFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.projects(filters),
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/v1/projects', { params: { query: { ...filters, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled,
  });
}

export function useProject(slug: string) {
  return useQuery({
    queryKey: queryKeys.project(slug),
    queryFn: () => unwrap(api.GET('/v1/projects/{slug}', { params: { path: { slug } } })),
  });
}

/** Every task of a project. The board needs the full set, so remaining pages load eagerly. */
export function useTasks(slug: string) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.tasks(slug),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/projects/{slug}/tasks', {
          params: { path: { slug }, query: { limit: 100, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    // The stream carries project totals, not per-claim progress, so poll while a claim runs.
    refetchInterval: (current) =>
      current.state.data?.pages.some((page) => page.items.some((task) => task.active_claim)) ? 4000 : false,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return query;
}

/** One task by its `<slug>:<manifest id>` reference; polls while a claim is running on it. */
export function useTask(slug: string, manifestId: string) {
  return useQuery({
    queryKey: queryKeys.task(slug, manifestId),
    queryFn: () => unwrap(api.GET('/v1/tasks/{task_id}', { params: { path: { task_id: `${slug}:${manifestId}` } } })),
    refetchInterval: (current) => (current.state.data?.active_claim ? 4000 : false),
  });
}

export function useLedger(slug: string, enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: queryKeys.ledger(slug),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/projects/{slug}/ledger', {
          params: { path: { slug }, query: { limit: 100, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    staleTime: 60_000,
  });
}

export function useProjectEvents(slug: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.projectEvents(slug),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/projects/{slug}/events', {
          params: { path: { slug }, query: { limit: 50, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useEvents(limit = 12) {
  return useInfiniteQuery({
    queryKey: queryKeys.events,
    queryFn: ({ pageParam }) => unwrap(api.GET('/v1/events', { params: { query: { limit, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

/**
 * Recent instance-wide deliveries, for the home page chart. There is no time-series endpoint,
 * so this reads the newest audit events and keeps the ones that carry delivered tokens.
 */
export function useDeliveryEvents() {
  return useQuery({
    queryKey: queryKeys.deliveryEvents,
    queryFn: async () => {
      const page = await unwrap(api.GET('/v1/events', { params: { query: { limit: 100 } } }));
      return page.items.flatMap((event) => {
        const tokens = event.payload?.tokens;
        return event.action === 'task.delivered' && typeof tokens === 'number' ? [{ at: event.at, tokens }] : [];
      });
    },
    staleTime: 60_000,
  });
}

export function useDonors() {
  return useInfiniteQuery({
    queryKey: queryKeys.donors,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/v1/donors', { params: { query: { limit: 50, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useDonor(handle: string) {
  return useQuery({
    queryKey: queryKeys.donor(handle),
    queryFn: () => unwrap(api.GET('/v1/donors/{handle}', { params: { path: { handle } } })),
  });
}

export function useApiKeys() {
  return useQuery({ queryKey: queryKeys.apiKeys, queryFn: () => unwrap(api.GET('/v1/me/api-keys')) });
}

export function useMyClaims() {
  return useQuery({
    queryKey: queryKeys.myClaims,
    queryFn: () => unwrap(api.GET('/v1/me/claims', { params: { query: { limit: 20 } } })),
  });
}

export function useAdminUsers(q: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.adminUsers(q),
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/v1/admin/users', { params: { query: { q: q || undefined, limit: 50, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useAdminProjects() {
  return useInfiniteQuery({
    queryKey: queryKeys.adminProjects,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/v1/admin/projects', { params: { query: { limit: 50, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useInstanceConfig() {
  return useQuery({ queryKey: queryKeys.instance, queryFn: () => unwrap(api.GET('/v1/admin/instance')) });
}

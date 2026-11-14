import { Activity as ActivityIcon, ArrowRight, FolderGit2, Search, SearchX, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  flatItems,
  type ProjectFilters,
  useDeliveryEvents,
  useEvents,
  useFederatedProjects,
  useFederationEnabled,
  usePeers,
  useProjects,
  useStats,
} from '@/api/queries';
import type { AuditEvent, FederatedProject } from '@/api/types';
import { Button, ButtonLink } from '@/components/Button';
import { EventLine } from '@/components/EventLine';
import { FederatedBackDialog } from '@/components/FederatedBackDialog';
import { FederatedProjectCard, FederatedProjectCardSkeleton } from '@/components/FederatedProjectCard';
import { SelectField, SwitchField } from '@/components/Field';
import { InFlight } from '@/components/InFlight';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Num } from '@/components/Num';
import { ProjectCard, ProjectCardSkeleton } from '@/components/ProjectCard';
import { Sparkline } from '@/components/Sparkline';
import { Stat } from '@/components/Stat';
import { EmptyState, ErrorState, Loading, LoadMore, Skeleton, SkeletonRows } from '@/components/States';
import { TokenCounter } from '@/components/TokenCounter';
import { Input } from '@/components/ui/input';
import { CLI_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useLive } from '@/hooks/useLive';
import { formatCompact } from '@/lib/format';
import { cumulative, dailySeries } from '@/lib/series';

const SORTS = [
  { value: 'trending', label: 'Trending' },
  { value: 'active', label: 'Recently active' },
  { value: 'recent', label: 'Newest' },
  { value: 'delivered', label: 'Most delivered' },
] as const;

type Sort = (typeof SORTS)[number]['value'];
const FEED_LENGTH = 10;
const PAGE_SIZE = 12;
const FEDERATED_PAGE_SIZE = 6;
const CHART_DAYS = 14;

function useFilters() {
  const [params, setParams] = useSearchParams();
  const sort = SORTS.find((option) => option.value === params.get('sort'))?.value ?? 'trending';
  const filters = {
    q: params.get('q') ?? '',
    language: params.get('language') ?? '',
    status: params.get('status') === 'paused' ? ('paused' as const) : ('active' as const),
    needsDonors: params.get('needs_donors') === 'true',
    sort,
  };
  const set = useCallback(
    (change: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(change)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const active = Boolean(filters.q || filters.language || filters.needsDonors || filters.status !== 'active');
  return { filters, set, active, clear: () => setParams({}, { replace: true }) };
}

/** The side panel of the hero: recent delivery as a chart, and the instance in four figures. */
function Pulse({ totals }: { totals: { pledged: number; merged: number } | undefined }) {
  const stats = useStats();
  const deliveries = useDeliveryEvents();
  const series = dailySeries(deliveries.data ?? [], CHART_DAYS);
  const recent = series.reduce((sum, value) => sum + value, 0);
  const figure = (value: number | undefined, unit = 'tokens') =>
    value === undefined ? <Skeleton className="h-5 w-12" /> : <Num value={value} unit={unit} />;

  return (
    <aside aria-label="Instance at a glance" className="surface rise grid content-start gap-5 p-5" style={{ '--i': 2 } as React.CSSProperties}>
      <div className="grid gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="label">Delivered, last {CHART_DAYS} days</h2>
          <span className="num text-sm font-medium">{deliveries.data ? formatCompact(recent) : ' '}</span>
        </div>
        <Sparkline
          values={cumulative(series)}
          className="h-20 text-foreground"
          label={`Delivery over the last ${CHART_DAYS} days: ${formatCompact(recent)} tokens`}
        />
      </div>
      {stats.isError ? (
        <ErrorState title="Couldn't load instance totals" error={stats.error} onRetry={() => void stats.refetch()} className="p-4" />
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 border-t pt-5">
          <Stat label="Pledged" value={figure(totals?.pledged)} />
          <Stat label="Merged" value={figure(totals?.merged)} />
          <Stat label="Projects" value={figure(stats.data?.projects, '')} />
          <Stat label="Donors" value={figure(stats.data?.donors, '')} />
        </dl>
      )}
    </aside>
  );
}

function Hero({ onEvent }: { onEvent: (event: AuditEvent) => void }) {
  const stats = useStats();
  const live = useLive(undefined, onEvent);
  const totals = live.frame?.totals ?? stats.data?.totals;

  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden border-b">
      <div
        aria-hidden="true"
        className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_90%_at_20%_0%,black,transparent)]"
      />
      <div className="container-page relative grid gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-end lg:py-16">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <LiveIndicator status={live.status} />
            <h1 id="hero-title" className="text-sm font-medium text-muted-foreground">
              Tokens delivered to open source
            </h1>
          </div>
          <p className="mt-5 -ml-[0.04em]">
            <TokenCounter value={totals?.delivered} label="tokens delivered" size="hero" placeholderDigits={8} />
          </p>
          <InFlight tokens={totals?.in_flight} className="mt-4" />
          <p className="rise mt-8 max-w-xl text-lg leading-snug text-pretty text-muted-foreground" style={{ '--i': 1 } as React.CSSProperties}>
            <span className="font-medium text-foreground">Fund open source with inference.</span> Donors run signed
            tasks on their own machines, under their own Claude Code subscription. A token counts only after CI passes
            on the pull request it produced.
          </p>
          <div className="rise mt-6 flex flex-wrap gap-2.5" style={{ '--i': 2 } as React.CSSProperties}>
            <Button asChild variant="primary" size="lg">
              <a href="#projects">
                <Zap className="fill-current" strokeWidth={0} aria-hidden="true" />
                Back a project
              </a>
            </Button>
            <ButtonLink to="/maintain/new" size="lg">
              List your project
              <ArrowRight strokeWidth={1.5} aria-hidden="true" />
            </ButtonLink>
          </div>
        </div>
        <Pulse totals={totals} />
      </div>
    </section>
  );
}

function Toolbar({ languages }: { languages: string[] }) {
  const { filters, set } = useFilters();
  const [search, setSearch] = useState(filters.q);

  // Keep typing responsive: the URL (and so the request) follows a moment behind the input.
  useEffect(() => {
    if (search === filters.q) return;
    const timer = setTimeout(() => set({ q: search || null }), 250);
    return () => clearTimeout(timer);
  }, [search, filters.q, set]);

  return (
    <form
      role="search"
      aria-label="Filter projects"
      onSubmit={(event) => event.preventDefault()}
      className="flex flex-wrap items-center gap-2"
    >
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        <Input
          type="search"
          data-slash-focus
          aria-label="Search projects"
          aria-keyshortcuts="/"
          placeholder="Search projects"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={200}
          className="h-9 pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 font-medium text-muted-foreground">
          /
        </kbd>
      </div>
      <SelectField
        label="Language"
        hideLabel
        value={filters.language}
        onChange={(event) => set({ language: event.target.value || null })}
        className="min-w-36"
      >
        <option value="">Any language</option>
        {languages.map((language) => (
          <option key={language} value={language}>
            {language}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Status"
        hideLabel
        value={filters.status}
        onChange={(event) => set({ status: event.target.value === 'paused' ? 'paused' : null })}
      >
        <option value="active">Active</option>
        <option value="paused">Paused</option>
      </SelectField>
      <SelectField
        label="Sort by"
        hideLabel
        value={filters.sort}
        onChange={(event) => set({ sort: event.target.value === 'trending' ? null : event.target.value })}
        className="min-w-40"
      >
        {SORTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <SwitchField label="Needs donors" checked={filters.needsDonors} onCheckedChange={(checked) => set({ needs_donors: checked ? 'true' : null })} />
    </form>
  );
}

/** Languages seen in any result so far. The API has no facet list, so this grows as you browse. */
function useKnownLanguages(seen: (string | null | undefined)[], selected: string): string[] {
  const [known, setKnown] = useState<string[]>([]);
  const missing = [...new Set([...seen, selected])]
    .filter((language): language is string => Boolean(language) && !known.includes(language ?? ''))
    .sort()
    .join('\n');
  useEffect(() => {
    if (missing) setKnown((current) => [...new Set([...current, ...missing.split('\n')])].sort());
  }, [missing]);
  return known;
}

function Projects() {
  const { filters, active, clear } = useFilters();
  const query: ProjectFilters = {
    q: filters.q || undefined,
    language: filters.language || undefined,
    status: filters.status,
    needs_donors: filters.needsDonors || undefined,
    sort: filters.sort as Sort,
    limit: PAGE_SIZE,
  };
  const projects = useProjects(query);
  const items = flatItems(projects);
  const languages = useKnownLanguages(items.map((project) => project.language), filters.language);
  const grid = 'grid gap-4 sm:grid-cols-2';

  return (
    <section id="projects" aria-labelledby="projects-title" className="grid min-w-0 scroll-mt-20 content-start gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="projects-title" className="text-lg font-semibold tracking-tight">
          Projects
        </h2>
        <p className="text-xs text-muted-foreground">Trending ranks by tokens delivered in the last 7 days.</p>
      </div>
      <Toolbar languages={languages} />
      {projects.isPending ? (
        <Loading label="projects" className={grid}>
          {Array.from({ length: 4 }, (_, index) => (
            <ProjectCardSkeleton key={index} />
          ))}
        </Loading>
      ) : projects.isError ? (
        <ErrorState title="Couldn't load projects" error={projects.error} onRetry={() => void projects.refetch()} />
      ) : items.length === 0 && active ? (
        <EmptyState icon={SearchX} title="No projects match these filters" action={<Button onClick={clear}>Clear filters</Button>}>
          <p>Try a broader search, or drop a filter.</p>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No projects yet"
          action={
            <ButtonLink to="/maintain/new" variant="primary">
              Register the first project
            </ButtonLink>
          }
        >
          <p>
            This instance is running and waiting for its first project. A project is any repository that carries an{' '}
            <code className="text-foreground">agentfund.yaml</code> and a signed list of task manifests.
          </p>
          <ol className="grid gap-2">
            {[
              'Write tasks as small YAML manifests: a prompt, the files it may touch, and a command that verifies it.',
              <>
                Sign them with <code className="text-foreground">{CLI_NAME} sign</code> and push.
              </>,
              'Register the repository here. Donors approve your key once and their workers take it from there.',
            ].map((step, index) => (
              <li key={index} className="flex gap-3">
                <span className="num flex size-5 shrink-0 items-center justify-center rounded-full border bg-card text-[0.6875rem] text-foreground">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </EmptyState>
      ) : (
        <>
          <div className={items.length === 1 ? 'grid gap-4' : grid}>
            {items.map((project) => (
              <ProjectCard key={project.slug} project={project} />
            ))}
          </div>
          <LoadMore
            hasMore={projects.hasNextPage}
            loading={projects.isFetchingNextPage}
            onLoad={() => void projects.fetchNextPage()}
            label="Load more projects"
          />
        </>
      )}
    </section>
  );
}

/**
 * Projects hosted on peer instances, under the local list. Absent unless federation is on and
 * at least one peer has projects to list, so a fresh instance shows no empty box. The search
 * box and the language filter above apply here too; status, sort and "needs donors" do not,
 * because the peers rank and gate their own projects.
 */
function FederatedProjects() {
  const { filters } = useFilters();
  const enabled = useFederationEnabled();
  const peers = usePeers();
  const [peer, setPeer] = useState('');
  const [backing, setBacking] = useState<FederatedProject | null>(null);
  const sources = (peers.data?.items ?? []).filter((item) => item.status === 'active' && item.discover && item.projects > 0);
  const selected = sources.some((item) => item.host === peer) ? peer : '';
  const projects = useFederatedProjects(
    { q: filters.q || undefined, language: filters.language || undefined, peer: selected || undefined, limit: FEDERATED_PAGE_SIZE },
    enabled && sources.length > 0,
  );
  const items = flatItems(projects);
  const grid = 'grid gap-4 sm:grid-cols-2';

  if (!enabled || peers.isPending || (!peers.isError && sources.length === 0)) return null;

  return (
    <section id="other-instances" aria-labelledby="other-instances-title" className="grid min-w-0 scroll-mt-20 content-start gap-4 border-t pt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="other-instances-title" className="text-lg font-semibold tracking-tight">
            On other instances
          </h2>
          <p className="max-w-prose text-xs text-pretty text-muted-foreground">
            Projects hosted by instances this one peers with. They open on their home instance, and the figures are
            that instance's own, as of its last sync.
          </p>
        </div>
        {sources.length > 1 && (
          <SelectField label="Instance" hideLabel value={selected} onChange={(event) => setPeer(event.target.value)} className="min-w-44">
            <option value="">Any instance</option>
            {sources.map((item) => (
              <option key={item.host} value={item.host}>
                {item.host}
              </option>
            ))}
          </SelectField>
        )}
      </div>
      {peers.isError ? (
        <ErrorState title="Couldn't load projects on other instances" error={peers.error} onRetry={() => void peers.refetch()} />
      ) : projects.isPending ? (
        <Loading label="projects on other instances" className={grid}>
          {Array.from({ length: 2 }, (_, index) => (
            <FederatedProjectCardSkeleton key={index} />
          ))}
        </Loading>
      ) : projects.isError ? (
        <ErrorState title="Couldn't load projects on other instances" error={projects.error} onRetry={() => void projects.refetch()} />
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-4 text-sm text-muted-foreground">
          {filters.q ? `No project on ${selected || 'another instance'} matches “${filters.q}”.` : `No project on ${selected || 'another instance'} matches these filters.`}
        </p>
      ) : (
        <>
          <div className={items.length === 1 ? 'grid gap-4' : grid}>
            {items.map((project) => (
              <FederatedProjectCard key={project.id} project={project} onBack={() => setBacking(project)} />
            ))}
          </div>
          <LoadMore
            hasMore={projects.hasNextPage}
            loading={projects.isFetchingNextPage}
            onLoad={() => void projects.fetchNextPage()}
            label="Load more from other instances"
          />
        </>
      )}
      {backing && <FederatedBackDialog project={backing} onClose={() => setBacking(null)} />}
    </section>
  );
}

function Activity({ liveEvents }: { liveEvents: AuditEvent[] }) {
  const events = useEvents(FEED_LENGTH);
  const fetched = flatItems(events);
  const known = new Set(fetched.map((event) => event.id));
  const fresh = liveEvents.filter((event) => !known.has(event.id));
  const items = [...fresh, ...fetched].slice(0, FEED_LENGTH);

  return (
    <aside aria-labelledby="activity-title" className="grid min-w-0 content-start gap-4 lg:sticky lg:top-20">
      <h2 id="activity-title" className="text-lg font-semibold tracking-tight">
        Activity
      </h2>
      {events.isPending ? (
        <Loading label="recent activity">
          <SkeletonRows rows={6} className="h-12" />
        </Loading>
      ) : events.isError ? (
        <ErrorState title="Couldn't load activity" error={events.error} onRetry={() => void events.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="Nothing has happened yet">
          <p>Claims, deliveries and merges appear here the moment they are recorded.</p>
        </EmptyState>
      ) : (
        <ol className="surface divide-y px-4">
          {items.map((event) => (
            <li key={event.id}>
              <EventLine event={event} fresh={fresh.includes(event)} />
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

export default function Discover() {
  useDocumentTitle(undefined);
  const [liveEvents, setLiveEvents] = useState<AuditEvent[]>([]);
  const onEvent = useCallback(
    (event: AuditEvent) => setLiveEvents((current) => [event, ...current].slice(0, FEED_LENGTH)),
    [],
  );

  return (
    <>
      <Hero onEvent={onEvent} />
      <div className="container-page grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="grid min-w-0 content-start gap-10">
          <Projects />
          <FederatedProjects />
        </div>
        <Activity liveEvents={liveEvents} />
      </div>
    </>
  );
}

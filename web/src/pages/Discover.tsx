import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { flatItems, type ProjectFilters, useEvents, useProjects, useStats } from '../api/queries';
import type { AuditEvent } from '../api/types';
import { Button, ButtonLink } from '../components/Button';
import { EventLine } from '../components/EventLine';
import { Checkbox, SelectField, TextField } from '../components/Field';
import { LiveIndicator } from '../components/LiveIndicator';
import { Num } from '../components/Num';
import { ProjectCard, ProjectCardSkeleton } from '../components/ProjectCard';
import { EmptyState, ErrorState, Loading, LoadMore, Skeleton, SkeletonRows } from '../components/States';
import { StatList } from '../components/StatList';
import { TokenCounter } from '../components/TokenCounter';
import { CLI_NAME } from '../config';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useLive } from '../hooks/useLive';

const SORTS = [
  { value: 'trending', label: 'Trending (7-day delivery)' },
  { value: 'active', label: 'Recently active' },
  { value: 'recent', label: 'Newest' },
  { value: 'delivered', label: 'Most delivered' },
] as const;

type Sort = (typeof SORTS)[number]['value'];
const FEED_LENGTH = 12;
const PAGE_SIZE = 12;

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

function Hero({ onEvent }: { onEvent: (event: AuditEvent) => void }) {
  const stats = useStats();
  const live = useLive(undefined, onEvent);
  const totals = live.frame?.totals ?? stats.data?.totals;
  const count = (value: number | undefined) =>
    value === undefined ? <Skeleton width="3ch" /> : <Num value={value} unit="" />;

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__label">
        <h1 id="hero-title" className="eyebrow">
          Tokens delivered
        </h1>
        <LiveIndicator status={live.status} />
      </div>
      <p className="hero__counter">
        <TokenCounter value={totals?.delivered} label="tokens delivered" size="hero" placeholderDigits={8} />
      </p>
      <p className="in-flight" data-active={totals && totals.in_flight > 0 ? true : undefined}>
        {totals && totals.in_flight > 0 ? (
          <>
            <span className="live-dot" aria-hidden="true" />
            <span>Running now</span>
            <TokenCounter value={totals.in_flight} label="tokens in flight" size="md" tone="accent" />
          </>
        ) : (
          <span className="muted">{totals ? 'No worker is running right now.' : ' '}</span>
        )}
      </p>
      <p className="hero__lede">
        Donors run signed tasks for open-source projects on their own machines, under their own Claude Code
        subscription. A token counts as delivered only after CI passes on the pull request it produced.
      </p>
      {stats.isError ? (
        <ErrorState title="Couldn't load instance totals" error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <StatList
          stats={[
            { label: 'Pledged', value: totals ? <Num value={totals.pledged} /> : <Skeleton width="5ch" /> },
            { label: 'Merged', value: totals ? <Num value={totals.merged} /> : <Skeleton width="5ch" /> },
            { label: 'Projects', value: count(stats.data?.projects) },
            { label: 'Donors', value: count(stats.data?.donors) },
            { label: 'Tasks merged', value: count(stats.data?.tasks_merged) },
          ]}
        />
      )}
    </section>
  );
}

function Filters({ languages }: { languages: string[] }) {
  const { filters, set } = useFilters();
  const [search, setSearch] = useState(filters.q);

  // Keep typing responsive: the URL (and so the request) follows a moment behind the input.
  useEffect(() => {
    if (search === filters.q) return;
    const timer = setTimeout(() => set({ q: search || null }), 250);
    return () => clearTimeout(timer);
  }, [search, filters.q, set]);

  return (
    <form className="filters" role="search" aria-label="Filter projects" onSubmit={(event) => event.preventDefault()}>
      <TextField
        label="Search projects"
        hideLabel
        type="search"
        placeholder="Search projects"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        maxLength={200}
      />
      <SelectField label="Language" hideLabel value={filters.language} onChange={(event) => set({ language: event.target.value || null })}>
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
      >
        {SORTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <Checkbox
        label="Needs donors"
        checked={filters.needsDonors}
        onChange={(event) => set({ needs_donors: event.target.checked ? 'true' : null })}
      />
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

  return (
    <section className="discover__projects" aria-labelledby="projects-title">
      <div className="section-header">
        <h2 id="projects-title">Projects</h2>
      </div>
      <Filters languages={languages} />
      {projects.isPending ? (
        <Loading label="projects">
          <div className="project-grid">
            {Array.from({ length: 4 }, (_, index) => (
              <ProjectCardSkeleton key={index} />
            ))}
          </div>
        </Loading>
      ) : projects.isError ? (
        <ErrorState title="Couldn't load projects" error={projects.error} onRetry={() => void projects.refetch()} />
      ) : items.length === 0 && active ? (
        <EmptyState title="No projects match these filters" action={<Button onClick={clear}>Clear filters</Button>}>
          <p>Try a broader search, or drop a filter.</p>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          title="No projects yet"
          action={
            <ButtonLink to="/maintain/new" variant="primary">
              Register the first project
            </ButtonLink>
          }
        >
          <p>
            This instance is running and waiting for its first project. A project is any repository that carries an{' '}
            <code>agentfund.yaml</code> and a signed list of task manifests.
          </p>
          <ol className="steps">
            <li>Write tasks as small YAML manifests: a prompt, the files it may touch, and a command that verifies it.</li>
            <li>
              Sign them with <code>{CLI_NAME} sign</code> and push.
            </li>
            <li>Register the repository here. Donors approve your key once and their workers take it from there.</li>
          </ol>
        </EmptyState>
      ) : (
        <>
          <div className="project-grid" data-count={items.length === 1 ? 'one' : undefined}>
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

function Activity({ liveEvents }: { liveEvents: AuditEvent[] }) {
  const events = useEvents(FEED_LENGTH);
  const fetched = flatItems(events);
  const known = new Set(fetched.map((event) => event.id));
  const items = [...liveEvents.filter((event) => !known.has(event.id)), ...fetched].slice(0, FEED_LENGTH);

  return (
    <aside className="discover__activity" aria-labelledby="activity-title">
      <div className="section-header">
        <h2 id="activity-title">Recent activity</h2>
      </div>
      {events.isPending ? (
        <Loading label="recent activity">
          <SkeletonRows rows={6} height="3rem" />
        </Loading>
      ) : events.isError ? (
        <ErrorState title="Couldn't load activity" error={events.error} onRetry={() => void events.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing has happened yet">
          <p>Claims, deliveries and merges appear here the moment they are recorded.</p>
        </EmptyState>
      ) : (
        <ol className="event-list">
          {items.map((event) => (
            <li key={event.id}>
              <EventLine event={event} />
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
    <div className="page discover">
      <Hero onEvent={onEvent} />
      <div className="discover__body">
        <Projects />
        <Activity liveEvents={liveEvents} />
      </div>
    </div>
  );
}

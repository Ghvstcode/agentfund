import { ArrowUpRight, FolderGit2, Search, SearchX } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { flatItems, type ProjectFilters, useMeta, useProjects, useStats } from '@/api/queries';
import type { Project, Totals } from '@/api/types';
import { Button, ButtonLink } from '@/components/Button';
import { CopyButton } from '@/components/CopyButton';
import { SelectField } from '@/components/Field';
import { TokenDot, type TokenState } from '@/components/Mark';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, LoadMore, Skeleton } from '@/components/States';
import { TokenCounter } from '@/components/TokenCounter';
import { TokenPyramid } from '@/components/TokenPyramid';
import { Input } from '@/components/ui/input';
import { APP_NAME, CLI_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useLive } from '@/hooks/useLive';
import { docLinks } from '@/lib/commands';
import { formatCompact } from '@/lib/format';
import { cn } from '@/lib/utils';

/** The project index's tabs, each a real query the API answers. */
const TABS = [
  { value: 'trending', label: 'Trending' },
  { value: 'needs', label: 'Needs donors' },
  { value: 'delivered', label: 'Most delivered' },
  { value: 'recent', label: 'New' },
] as const;

type Tab = (typeof TABS)[number]['value'];
const PAGE_SIZE = 10;
const TAG_CHIPS = 10;

function useFilters() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((option) => option.value === params.get('tab'))?.value ?? 'trending';
  const filters = {
    q: params.get('q') ?? '',
    language: params.get('language') ?? '',
    tag: params.get('tag') ?? '',
    tab,
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
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );
  const active = Boolean(filters.q || filters.language || filters.tag || filters.tab !== 'trending');
  return { filters, set, active, clear: () => setParams({}, { replace: true, preventScrollReset: true }) };
}

/** Values seen in any result so far, most frequent first. The API has no facet list, so this grows as you browse. */
function useKnownValues(seen: (string | null | undefined)[], selected: string, limit = Infinity): string[] {
  const [known, setKnown] = useState<Record<string, number>>({});
  const tally: Record<string, number> = {};
  for (const value of seen) if (value) tally[value] = (tally[value] ?? 0) + 1;
  const key = JSON.stringify(Object.entries(tally).sort());
  useEffect(() => {
    const fresh: Record<string, number> = Object.fromEntries(JSON.parse(key) as [string, number][]);
    setKnown((current) => {
      const next = { ...current };
      for (const [value, count] of Object.entries(fresh)) next[value] = Math.max(next[value] ?? 0, count);
      return Object.keys(next).some((value) => next[value] !== current[value]) ? next : current;
    });
  }, [key]);
  const ranked = Object.keys(known).sort((a, b) => (known[b] ?? 0) - (known[a] ?? 0) || a.localeCompare(b)).slice(0, limit);
  return selected && !ranked.includes(selected) ? [...ranked, selected] : ranked;
}

function Legend({ items }: { items: [TokenState, string][] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      {items.map(([state, label]) => (
        <li key={state} className="flex items-center gap-1.5">
          <TokenDot state={state} className="size-2" />
          {label}
        </li>
      ))}
    </ul>
  );
}

function Hero({ totals, live }: { totals: Totals | undefined; live: boolean }) {
  const meta = useMeta();
  const docs = docLinks(meta.data);
  const name = meta.data?.name ?? APP_NAME;
  const here = name === APP_NAME ? `this ${APP_NAME} instance` : name;

  return (
    <section aria-labelledby="hero-title" className="container-page grid items-center gap-12 py-14 lg:grid-cols-[minmax(0,1fr)_25rem] lg:py-24">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-muted-foreground">
          <span className={cn('size-2 rounded-full bg-pass', live && 'live-dot bg-pass')} aria-hidden="true" />
          <span className="text-foreground">
            <TokenCounter value={totals?.delivered} label="tokens delivered" size="sm" placeholderDigits={6} />
          </span>
          <span className="num">tokens delivered · open source, research and in-house tools</span>
        </p>
        <h1
          id="hero-title"
          className="mt-7 text-[clamp(3rem,8.6vw,6.25rem)] leading-[0.94] font-semibold tracking-[-0.055em] text-balance"
        >
          Fund software <br className="hidden sm:block" />
          in tokens.
        </h1>
        <p className="mt-8 max-w-[40rem] text-lg leading-relaxed text-pretty text-muted-foreground sm:text-xl sm:leading-relaxed">
          Back any project by lending your agent. Maintainers sign small tasks; your agent runs them on your machine,
          under your caps. A token counts only once CI passes.{' '}
          <span className="font-medium text-foreground">Use {here}, or run your own inside your company.</span>
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button asChild variant="primary" size="lg" className="rounded-none px-5">
            <a href="#projects">Find a project to back</a>
          </Button>
          <a href={docs.quickstart} className="flex items-center gap-1 text-[0.9375rem] font-medium hover:underline">
            Read the docs <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </a>
        </div>
      </div>
      <figure className="mx-auto grid w-full max-w-64 justify-items-center gap-5 sm:max-w-sm lg:max-w-none">
        <TokenPyramid />
        <figcaption>
          <Legend items={[['delivered', 'Delivered'], ['merged', 'Merged'], ['reported', 'Reported'], ['pledged', 'Pledged']]} />
        </figcaption>
      </figure>
    </section>
  );
}

function StatStrip({ totals }: { totals: Totals | undefined }) {
  const stats = useStats();
  const figure = (value: number | undefined, className?: string) =>
    value === undefined ? <Skeleton className="h-10 w-28" /> : <Num value={value} className={cn('text-[2.5rem] leading-none font-medium tracking-[-0.04em]', className)} />;
  const cells = [
    { label: 'Delivered', value: figure(totals?.delivered, 'text-live'), note: 'CI passed. The only number that ranks.' },
    {
      label: 'Merged',
      value: figure(totals?.merged),
      note: stats.data ? `In main, across ${stats.data.tasks_merged.toLocaleString('en')} merged tasks.` : ' ',
    },
    {
      label: 'Pledged',
      value: figure(totals?.pledged),
      note: stats.data ? `Stated intent from ${stats.data.donors.toLocaleString('en')} donors.` : ' ',
    },
    { label: 'Dollars moved', value: <span className="num text-[2.5rem] leading-none font-medium tracking-[-0.04em]">0</span>, note: 'A scoreboard, not a bank.' },
  ];

  if (stats.isError) {
    return (
      <div className="container-page">
        <ErrorState title="Couldn't load instance totals" error={stats.error} onRetry={() => void stats.refetch()} />
      </div>
    );
  }
  return (
    <section aria-label="Instance totals" className="container-page">
      <dl className="grid border-t border-t-foreground sm:grid-cols-2 lg:grid-cols-4 lg:border-b">
        {cells.map((cell, index) => (
          <div
            key={cell.label}
            className={cn(
              'grid content-start gap-2.5 border-b py-6 sm:py-7 lg:border-b-0',
              index % 2 === 1 && 'sm:border-l sm:pl-6',
              index > 0 && 'lg:border-l lg:pl-6',
            )}
          >
            <dt className="text-xs font-semibold tracking-[0.12em] uppercase">{cell.label}</dt>
            <dd>{cell.value}</dd>
            <dd className="text-[0.8125rem] text-muted-foreground">{cell.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ProjectStatus({ project }: { project: Project }) {
  const chip = 'inline-flex h-5 items-center px-1.5 text-[0.6875rem] font-medium whitespace-nowrap';
  if (project.totals.in_flight > 0) {
    return (
      <span className={cn(chip, 'gap-1.5 bg-pass-tint text-live')}>
        <span className="live-dot size-1.5" aria-hidden="true" /> Running now
      </span>
    );
  }
  if (project.token_goal > 0 && project.totals.delivered >= project.token_goal) return <span className={cn(chip, 'bg-pass font-semibold text-black')}>Funded</span>;
  if (project.status === 'paused') return <span className={cn(chip, 'border text-muted-foreground')}>Paused</span>;
  if ((project.tasks.claimable ?? 0) > 0) return <span className={cn(chip, 'border border-foreground')}>Needs donors</span>;
  return null;
}

const ROW_GRID = 'md:grid md:grid-cols-[2.5rem_minmax(0,1fr)_6.5rem_15rem_5rem_4.5rem_4.5rem] md:items-center md:gap-6';

function ProjectRow({ project, rank }: { project: Project; rank: number }) {
  const { totals, token_goal: goal } = project;
  const percent = goal > 0 ? Math.round((totals.delivered / goal) * 100) : 0;
  return (
    <li className={cn('group relative grid gap-3 border-b py-5 transition-colors hover:bg-muted/40', ROW_GRID)}>
      <span className="num hidden text-[0.8125rem] text-muted-foreground md:block">{String(rank).padStart(2, '0')}</span>
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="text-base font-semibold tracking-tight">
            {/* The whole row is the link target; the name carries the accessible name. */}
            <Link to={`/${project.slug}`} className="after:absolute after:inset-0 focus-visible:outline-none">
              {project.name}
            </Link>
          </h3>
          <span className="num text-xs text-muted-foreground">{project.maintainer.handle}</span>
          <ProjectStatus project={project} />
        </div>
        <p className="truncate text-[0.8125rem] text-muted-foreground">{project.description}</p>
        {(project.tags?.length ?? 0) > 0 && (
          <ul aria-label="Tags" className="flex flex-wrap gap-1 pt-1">
            {project.tags?.slice(0, 4).map((tag) => (
              <li key={tag} className="num bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                {tag}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="hidden text-[0.8125rem] md:block">{project.language ?? '—'}</span>
      <div className="grid gap-2">
        <div className="h-1 w-full bg-muted" aria-hidden="true">
          <div className="h-1 bg-pass" style={{ width: `${Math.min(percent, 100)}%` }} />
        </div>
        <div className="flex justify-between gap-3 text-xs">
          <span>
            <Num value={totals.delivered} /> <span className="num text-muted-foreground">of {goal > 0 ? formatCompact(goal) : '—'}</span>
          </span>
          <span className="num font-semibold">{goal > 0 ? `${percent}%` : ''}</span>
        </div>
      </div>
      <div className="flex justify-between text-xs md:contents">
        <span className="text-muted-foreground md:hidden">Last 7 days</span>
        <span className={cn('num md:text-right md:text-[0.8125rem]', project.velocity_7d > 0 ? 'text-live' : 'text-muted-foreground')}>
          {project.velocity_7d > 0 ? `+${formatCompact(project.velocity_7d)}` : '—'}
        </span>
      </div>
      <div className="flex justify-between text-xs md:contents">
        <span className="text-muted-foreground md:hidden">Donors</span>
        <span className="num md:text-right md:text-[0.8125rem]">{project.donors}</span>
      </div>
      <span aria-hidden="true" className="hidden h-8 items-center justify-center border border-foreground text-[0.8125rem] font-medium transition-colors group-hover:bg-foreground group-hover:text-background md:flex">
        Back
      </span>
    </li>
  );
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'h-8 border px-3 text-[0.8125rem] whitespace-nowrap transition-colors',
        selected ? 'border-foreground bg-foreground font-medium text-background' : 'hover:border-foreground/40',
      )}
    >
      {children}
    </button>
  );
}

function Projects() {
  const { filters, set, active, clear } = useFilters();
  const [search, setSearch] = useState(filters.q);
  const query: ProjectFilters = {
    q: filters.q || undefined,
    language: filters.language || undefined,
    tag: filters.tag || undefined,
    status: 'active',
    needs_donors: filters.tab === 'needs' || undefined,
    sort: filters.tab === 'needs' ? 'trending' : (filters.tab as Exclude<Tab, 'needs'>),
    limit: PAGE_SIZE,
  };
  const projects = useProjects(query);
  const items = flatItems(projects);
  const languages = useKnownValues(items.map((project) => project.language), filters.language);
  const tags = useKnownValues(items.flatMap((project) => project.tags ?? []), filters.tag, TAG_CHIPS);

  // Keep typing responsive: the URL (and so the request) follows a moment behind the input.
  useEffect(() => {
    if (search === filters.q) return;
    const timer = setTimeout(() => set({ q: search || null }), 250);
    return () => clearTimeout(timer);
  }, [search, filters.q, set]);

  return (
    <section id="projects" aria-labelledby="projects-title" className="container-page grid scroll-mt-20 pt-20 sm:pt-24">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 pb-5">
        <div className="grid gap-2">
          <h2 id="projects-title" className="text-4xl font-semibold tracking-[-0.04em] sm:text-[2.75rem] sm:leading-[1.1]">
            Projects to back.
          </h2>
          <p className="text-[0.9375rem] text-muted-foreground">Open source, research and in-house tools with signed tasks open right now.</p>
        </div>
        <div role="group" aria-label="Order" className="-mb-px flex gap-6 overflow-x-auto [scrollbar-width:none]">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={filters.tab === tab.value}
              onClick={() => set({ tab: tab.value === 'trending' ? null : tab.value })}
              className={cn(
                'border-b-2 pb-1.5 text-sm whitespace-nowrap transition-colors',
                filters.tab === tab.value ? 'border-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <form
        role="search"
        aria-label="Filter projects"
        onSubmit={(event) => event.preventDefault()}
        className="flex flex-wrap items-center justify-between gap-3 pb-5"
      >
        <div role="group" aria-label="Tags" className="flex w-full min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none] sm:w-auto sm:flex-wrap sm:overflow-visible">
          <Chip selected={!filters.tag} onClick={() => set({ tag: null })}>
            All
          </Chip>
          {tags.map((tag) => (
            <Chip key={tag} selected={filters.tag === tag} onClick={() => set({ tag: filters.tag === tag ? null : tag })}>
              {tag}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <div className="relative w-full min-w-44 sm:w-52">
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
              className="h-8 rounded-none pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
            />
            <kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 border bg-muted px-1.5 text-[0.6875rem] leading-5 font-medium text-muted-foreground">
              /
            </kbd>
          </div>
          <SelectField
            label="Language"
            hideLabel
            value={filters.language}
            onChange={(event) => set({ language: event.target.value || null })}
            className="h-8 min-w-36 [&_select]:rounded-none"
          >
            <option value="">Any language</option>
            {languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </SelectField>
        </div>
      </form>

      {projects.isPending ? (
        <Loading label="projects" className="border-t border-t-foreground md:border-t-0">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="grid gap-2 border-b py-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
          ))}
        </Loading>
      ) : projects.isError ? (
        <ErrorState title="Couldn't load projects" error={projects.error} onRetry={() => void projects.refetch()} className="mt-5" />
      ) : items.length === 0 && active ? (
        <EmptyState icon={SearchX} title="No projects match these filters" action={<Button onClick={clear}>Clear filters</Button>} className="mt-5">
          <p>Try a broader search, or drop a filter.</p>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          className="mt-5"
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
          <div
            aria-hidden="true"
            className={cn('hidden h-10 border-t border-b border-t-foreground text-[0.6875rem] font-medium tracking-[0.08em] text-muted-foreground uppercase md:grid', ROW_GRID)}
          >
            <span>#</span>
            <span>Project</span>
            <span>Language</span>
            <span>Delivered of goal</span>
            <span className="text-right">7-day</span>
            <span className="text-right">Donors</span>
            <span />
          </div>
          <ol aria-label="Projects" className="border-t border-t-foreground md:border-t-0">
            {items.map((project, index) => (
              <ProjectRow key={project.slug} project={project} rank={index + 1} />
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 text-[0.8125rem] text-muted-foreground">
            <span>
              {filters.tab === 'trending' ? 'Ranked by tokens delivered in the last 7 days.' : `Showing ${items.length}.`}
            </span>
            <LoadMore
              hasMore={projects.hasNextPage}
              loading={projects.isFetchingNextPage}
              onLoad={() => void projects.fetchNextPage()}
              label="More projects"
            />
          </div>
        </>
      )}
    </section>
  );
}

function ForTeams() {
  const meta = useMeta();
  const docs = docLinks(meta.data);
  const command = 'docker compose up --build';
  const points = [
    ['Your instance, your rules', 'One Node process and Postgres, with your own GitHub sign-in. An admin approves every project it lists.'],
    ['Caps on every worker', "Each engineer's worker stops at its own per-task, daily and weekly caps."],
    ['Signed tasks only', 'Workers run nothing a maintainer has not signed, and check it on their own machine.'],
    ['A ledger you can audit', 'Tokens spent against work delivered and merged, per project and per person.'],
  ];
  return (
    <section aria-labelledby="teams-title" id="teams" className="container-page scroll-mt-20 pt-24">
      <div className="grid gap-12 bg-band p-8 text-band-foreground sm:p-12 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:gap-16 lg:p-16">
        <div className="flex flex-col justify-between gap-10">
          <div className="grid gap-5">
            <p className="text-xs font-semibold tracking-[0.12em] text-band-muted uppercase">For teams and companies</p>
            <h2 id="teams-title" className="text-4xl leading-[1.08] font-semibold tracking-[-0.045em] sm:text-5xl">
              Run your own instance. Send your team's spare tokens where they count.
            </h2>
            <p className="text-[1.0625rem] leading-relaxed text-pretty text-band-muted">
              Your company already pays for agent seats. Run your own instance and let engineers' idle agents work on the
              open-source projects you depend on, with caps and a ledger you control.
            </p>
          </div>
          <a
            href={docs.selfHosting}
            className="inline-flex h-11 w-fit items-center gap-1.5 bg-band-foreground px-5 text-[0.9375rem] font-semibold text-band transition-opacity hover:opacity-90"
          >
            Read the self-hosting guide <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </a>
        </div>
        <div className="grid content-start">
          <ul className="grid">
            {points.map(([title, body]) => (
              <li key={title} className="grid gap-1.5 border-b border-band-line py-5 first:pt-0">
                <span className="text-[1.0625rem] font-semibold">{title}</span>
                <span className="text-sm leading-relaxed text-band-muted">{body}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex h-11 items-center justify-between gap-3 border border-band-line pr-2 pl-4">
            <code className="truncate text-[0.8125rem]">
              <span className="text-band-muted">$ </span>
              {command}
            </code>
            <CopyButton text={command} label="the start command" className="border-band-line bg-transparent text-band-muted hover:bg-white/10 hover:text-band-foreground" />
          </div>
        </div>
      </div>
    </section>
  );
}

function States() {
  const steps: [TokenState, string, string, string][] = [
    ['pledged', '01 · Pledged', 'A maintainer signs small tasks.', 'A prompt, a write scope and a token cap, signed with a key you can check.'],
    ['reported', '02 · Reported', 'Your agent runs one, locally.', 'Sandboxed, with your own login and your caps. The spend is reported, pass or fail.'],
    ['delivered', '03 · Delivered', 'CI passes on its pull request.', 'Now it counts, and only now. Failed runs stay visible; they never rank.'],
    ['merged', '04 · Merged', 'The maintainer merges it.', 'Every merge is on the public ledger, linked to the run that paid for it.'],
  ];
  return (
    <section aria-labelledby="states-title" className="container-page grid gap-7 pt-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="states-title" className="text-4xl font-semibold tracking-[-0.04em] sm:text-[2.75rem] sm:leading-[1.1]">
          Four states. One counts.
        </h2>
      </div>
      <ol className="grid border-t border-t-foreground sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([state, label, title, body], index) => (
          <li key={state} className={cn('grid content-start gap-4 border-b py-7 sm:pr-7 lg:border-b-0', index > 0 && 'lg:border-l lg:pl-7', index % 2 === 1 && 'sm:border-l sm:pl-7 lg:pl-7')}>
            <TokenDot state={state} className={cn('size-9', state === 'pledged' && 'border-[3px]')} />
            <div className="grid gap-1.5">
              <span className={cn('num text-xs', state === 'delivered' ? 'text-live' : 'text-muted-foreground')}>{label}</span>
              <span className="text-lg font-semibold tracking-tight">{title}</span>
              <span className="text-sm leading-relaxed text-muted-foreground">{body}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Docs() {
  const meta = useMeta();
  const docs = docLinks(meta.data);
  const guides = [
    ['01 · 5 min', 'Quickstart', 'Run a throwaway instance and a worker in one command.', docs.quickstart],
    ['02 · donors', 'Back a project', 'Install the worker, approve a project, set your caps.', docs.donors],
    ['03 · maintainers', 'Write signed tasks', 'Scopes, caps, CI gates and signing your manifests.', docs.maintainers],
    ['04 · teams', 'Self-host', 'Run your own instance with your own login and repositories.', docs.selfHosting],
    ['05 · reference', 'Spec v1', 'The manifest format, the protocol and the OpenAPI schema.', docs.spec],
    ['06 · trust', 'Security model', 'What runs where, what is checked, and what the server never sees.', docs.security],
  ];
  return (
    <section aria-labelledby="docs-title" className="container-page grid gap-7 pt-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <h2 id="docs-title" className="text-4xl font-semibold tracking-[-0.04em] sm:text-[2.75rem] sm:leading-[1.1]">
            Read the docs.
          </h2>
          <p className="text-[0.9375rem] text-muted-foreground">From a first run to the full spec.</p>
        </div>
        <a href={docs.home} className="flex items-center gap-1 text-sm font-medium hover:underline">
          All docs <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </a>
      </div>
      <ul className="grid border-t border-t-foreground sm:grid-cols-2 lg:grid-cols-3">
        {guides.map(([label, title, body, href]) => (
          <li key={title} className="border-b">
            <a href={href} className="group grid h-full content-start gap-2 py-6 pr-6 transition-colors hover:bg-muted/40">
              <span className="num text-xs text-muted-foreground">{label}</span>
              <span className="flex items-center gap-1 text-lg font-semibold tracking-tight">
                {title}
                <ArrowUpRight className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="text-sm leading-relaxed text-muted-foreground">{body}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Closing() {
  return (
    <section aria-labelledby="closing-title" className="container-page pt-24">
      <div className="flex flex-wrap items-end justify-between gap-8 bg-band p-8 text-band-foreground sm:p-12 lg:p-16">
        <h2 id="closing-title" className="max-w-3xl text-4xl leading-[1.06] font-semibold tracking-[-0.045em] sm:text-[3.5rem]">
          Your agent is idle tonight. Lend it to something worth building.
        </h2>
        <div className="grid justify-items-start gap-3 sm:justify-items-end">
          <a href="#projects" className="inline-flex h-12 items-center bg-band-foreground px-6 text-[0.9375rem] font-semibold text-band transition-opacity hover:opacity-90">
            Find a project to back
          </a>
          <Link to="/maintain/new" className="text-sm text-band-muted hover:text-band-foreground">
            Maintainer? <span className="text-band-foreground">List your project ›</span>
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Discover() {
  useDocumentTitle(undefined);
  const stats = useStats();
  const live = useLive();
  const totals = live.frame?.totals ?? stats.data?.totals;
  return (
    <>
      <Hero totals={totals} live={live.status === 'live'} />
      <StatStrip totals={totals} />
      <Projects />
      <ForTeams />
      <States />
      <Docs />
      <Closing />
    </>
  );
}

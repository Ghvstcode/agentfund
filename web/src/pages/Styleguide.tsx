import { FolderGit2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { AuditEvent, Project } from '@/api/types';
import { Button, ButtonLink } from '@/components/Button';
import { CommandLine } from '@/components/CommandLine';
import { ConfirmButton } from '@/components/ConfirmButton';
import { CopyButton } from '@/components/CopyButton';
import { Dialog, DialogSection } from '@/components/Dialog';
import { EventLine } from '@/components/EventLine';
import { SelectField, SwitchField, TextField } from '@/components/Field';
import { FundingBar } from '@/components/FundingBar';
import { HandleAvatar } from '@/components/HandleAvatar';
import { Hash } from '@/components/Hash';
import { InFlight } from '@/components/InFlight';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Num } from '@/components/Num';
import { ProjectCard, ProjectCardSkeleton } from '@/components/ProjectCard';
import { Sparkline } from '@/components/Sparkline';
import { Stat } from '@/components/Stat';
import { EmptyState, ErrorState, Notice, Skeleton, SkeletonRows } from '@/components/States';
import { Tabs } from '@/components/Tabs';
import { Time } from '@/components/Time';
import { TokenCounter } from '@/components/TokenCounter';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTheme } from '@/hooks/useTheme';

const COLOURS = [
  ['--background', 'Page'],
  ['--card', 'Raised surfaces'],
  ['--popover', 'Menus, dialogs'],
  ['--muted', 'Quiet fills'],
  ['--secondary', 'Secondary buttons, badges'],
  ['--border', 'Hairlines'],
  ['--input', 'Field borders'],
  ['--muted-foreground', 'Secondary text'],
  ['--foreground', 'Text'],
  ['--primary', 'Primary buttons'],
  ['--destructive', 'Errors'],
  ['--live', 'Live values and progress only'],
] as const;

const TYPE = [
  ['Display', 'counter--hero', 'Hero counter · Geist Mono 500'],
  ['Title', 'text-2xl font-semibold tracking-tight', 'Page titles · 24 / 600'],
  ['Section', 'text-base font-semibold tracking-tight', 'Section titles · 16 / 600'],
  ['Body', 'text-sm', 'Body · 14 / 400'],
  ['Meta', 'text-xs text-muted-foreground', 'Labels and meta · 12 / 500'],
] as const;

const OTHER = ['--radius', '--shadow-card', '--shadow-raised', '--highlight'] as const;

/** Resolved values of CSS custom properties, re-read when the theme flips. */
function useTokenValues(names: readonly string[]): Record<string, string> {
  const theme = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const key = names.join(' ');
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(key.split(' ').map((name) => [name, style.getPropertyValue(name).trim()])));
  }, [key, theme]);
  return values;
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`sg-${id}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 border-t py-10">
      <header className="grid max-w-prose gap-1">
        <h2 id={`sg-${id}`} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Specimen({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2.5">
      <p className="label">{label}</p>
      <div className={className ?? 'grid min-w-0 grid-cols-[minmax(0,1fr)] justify-items-start gap-3'}>{children}</div>
    </div>
  );
}

const SAMPLE_PROJECT: Project = {
  id: 'https://example.org/gridrs',
  slug: 'styleguide-sample',
  name: 'gridrs',
  description: 'A terminal spreadsheet in Rust.',
  repo_url: 'https://github.com/example/gridrs',
  language: 'rust',
  tags: ['tui', 'spreadsheet'],
  status: 'active',
  ci_provider: 'github',
  base_branch: 'main',
  follow_branch: true,
  maintainer: { id: 'https://example.org/u/ada', handle: 'ada' },
  pubkey: 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
  pubkey_fingerprint: 'SHA256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  pinned_commit: '2721068a7775bcc9f2fd134fc2b7a1f6584071ff',
  token_goal: 60_000_000,
  totals: { pledged: 41_500_000, reported: 31_200_000, delivered: 24_873_412, merged: 17_300_000, in_flight: 1_240_000 },
  tasks: { open: 4, claimed: 1, delivered: 2, merged: 5, failed: 0, claimable: 3 },
  donors: 9,
  velocity_7d: 6_100_000,
  trust: { tier: 'established', merged_tasks: 5, max_tokens_per_task: null, max_tokens_per_day: null },
  created_at: '2026-08-01T10:00:00Z',
};

const SAMPLE_EVENT: AuditEvent = {
  id: 'evt_sample',
  at: '2026-10-06T17:05:00Z',
  actor: 'ada',
  action: 'task.delivered',
  project: 'gridrs',
  task_id: 'gridrs:0001-csv-parser',
  payload: { tokens: 2_895_396 },
};

function CounterDemo() {
  const [value, setValue] = useState(24_873_412);
  const [inFlight, setInFlight] = useState(0);
  return (
    <div className="surface bg-grid grid gap-4 p-6">
      <TokenCounter value={value} label="tokens delivered" size="hero" />
      <InFlight tokens={inFlight} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setValue((current) => current + 1)}>
          Add 1
        </Button>
        <Button size="sm" onClick={() => setValue((current) => current + 48_213)}>
          Add 48,213
        </Button>
        <Button size="sm" onClick={() => setValue((current) => current * 10 + 7)}>
          Gain a digit
        </Button>
        <Button size="sm" onClick={() => setInFlight((current) => current + 86_400)}>
          Heartbeat
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setValue((current) => current + inFlight);
            setInFlight(0);
          }}
        >
          Deliver
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setValue(24_873_412)}>
          Reset
        </Button>
      </div>
    </div>
  );
}

export default function Styleguide() {
  useDocumentTitle('Styleguide');
  const tokens = useTokenValues([...COLOURS.map(([name]) => name), ...OTHER]);
  const [dialog, setDialog] = useState<'modal' | 'drawer' | null>(null);

  return (
    <div className="container-page grid grid-cols-[minmax(0,1fr)] py-10">
      <header className="grid max-w-prose gap-2 pb-10">
        <h1 className="text-2xl font-semibold tracking-tight">Styleguide</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Every token and component of this interface, in every state. The theme is the block of CSS variables at the
          top of <code className="text-foreground">src/index.css</code>; components are shadcn/ui, vendored in{' '}
          <code className="text-foreground">src/components/ui</code>. Change a variable and it changes here and everywhere.
        </p>
      </header>

      <Section id="colour" title="Colour" note="Layered neutrals and one accent. The accent marks live values and progress, nothing else.">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {COLOURS.map(([name, use]) => (
            <li key={name} className="surface overflow-hidden">
              <span className="block h-14 border-b" style={{ background: `var(${name})` }} />
              <span className="grid gap-0.5 p-3">
                <span className="num text-xs">{name}</span>
                <span className="num text-xs text-muted-foreground">{tokens[name]}</span>
                <span className="text-xs text-muted-foreground">{use}</span>
              </span>
            </li>
          ))}
        </ul>
        <dl className="surface grid gap-2 p-4 text-xs">
          {OTHER.map((name) => (
            <div key={name} className="grid gap-x-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="num">{name}</dt>
              <dd className="num text-muted-foreground [overflow-wrap:anywhere]">{tokens[name]}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="type" title="Type" note="Geist for words. Geist Mono, with tabular figures, for every number, hash, commit and key. Radii step from 6 to 18px off one --radius.">
        <ul className="surface divide-y px-5">
          {TYPE.map(([name, className, use]) => (
            <li key={name} className="grid grid-cols-[minmax(0,1fr)] items-baseline gap-x-6 gap-y-1 py-4 sm:grid-cols-[6rem_minmax(0,1fr)_14rem]">
              <span className="label">{name}</span>
              <span className={`${className} ${name === 'Display' ? 'counter !text-4xl sm:!text-5xl' : ''} text-balance`}>
                {name === 'Display' ? '12 400 000' : 'Fund open source with inference'}
              </span>
              <span className="text-xs text-muted-foreground">{use}</span>
            </li>
          ))}
        </ul>
        <Specimen label="Numbers and identifiers" className="flex flex-wrap items-center gap-3 text-sm">
          <Num value={12_400_000} />
          <Num value={12_400_000} exact />
          <Time value={SAMPLE_PROJECT.created_at} />
          <Hash value={SAMPLE_PROJECT.pinned_commit} label="commit" />
          <Hash value={SAMPLE_PROJECT.pubkey_fingerprint} label="key fingerprint" length={12} />
          <HandleAvatar handle="ada" />
          <HandleAvatar handle="niklaus" className="size-8 text-sm" />
          <kbd className="rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 font-medium">⌘K</kbd>
        </Specimen>
      </Section>

      <Section id="counter" title="Token counter" note="Fixed-width wheels, thin gaps between thousands, no shift when the number grows. Screen readers get the exact value without announcements.">
        <CounterDemo />
        <div className="grid gap-6 sm:grid-cols-3">
          <Specimen label="Before data arrives">
            <TokenCounter value={undefined} label="tokens delivered" size="lg" />
          </Specimen>
          <Specimen label="Sizes">
            <TokenCounter value={9_503_806} label="tokens" size="xl" />
            <TokenCounter value={9_503_806} label="tokens" size="lg" />
            <TokenCounter value={9_503_806} label="tokens" size="md" />
            <TokenCounter value={412_907} label="tokens in flight" size="sm" tone="accent" />
          </Specimen>
          <Specimen label="Stream status">
            <LiveIndicator status="live" />
            <LiveIndicator status="connecting" />
            <LiveIndicator status="polling" />
            <LiveIndicator status="offline" />
          </Specimen>
        </div>
      </Section>

      <Section id="funding" title="Progress and trend" note="The track is the goal, the pale fill is pledged. On top: merged solid, delivered in the accent, running work as a lighter tail.">
        <div className="surface grid gap-5 p-5">
          <FundingBar totals={SAMPLE_PROJECT.totals} goal={SAMPLE_PROJECT.token_goal} size="lg" />
          <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat label="Pledged" swatch="bg-foreground/15 ring-1 ring-border" value={<Num value={41_500_000} />} note="Stated intent" />
            <Stat label="Delivered" swatch="bg-live" value={<Num value={24_873_412} />} note="CI passed" />
            <Stat label="Merged" swatch="bg-foreground" value={<Num value={17_300_000} />} note="PR merged" />
            <Stat label="Reported" value={<Num value={31_200_000} />} note="Includes failed runs" />
          </dl>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <Specimen label="Small bar: empty, partial, past the goal" className="grid gap-3">
            <FundingBar totals={{ pledged: 0, delivered: 0, merged: 0, in_flight: 0 }} goal={60e6} />
            <FundingBar totals={{ pledged: 30e6, delivered: 9e6, merged: 4e6, in_flight: 0 }} goal={60e6} />
            <FundingBar totals={{ pledged: 80e6, delivered: 66e6, merged: 61e6, in_flight: 0 }} goal={60e6} />
          </Specimen>
          <Specimen label="Sparkline: with data, and flat" className="grid gap-3">
            <Sparkline values={[0, 2, 2, 5, 9, 9, 14, 21, 21, 30]} label="Sample growth" className="h-12 text-foreground" />
            <Sparkline values={[0, 0, 0, 0, 0, 0]} label="No deliveries" className="h-8 text-foreground" />
          </Specimen>
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        <Specimen label="Variants and sizes" className="flex flex-wrap items-center gap-2.5">
          <Button variant="primary" size="lg">
            Back this project
          </Button>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button size="sm">Small</Button>
          <ButtonLink to="/styleguide">Link as button</ButtonLink>
        </Specimen>
        <Specimen label="States: busy, disabled, confirm, copy, toast" className="flex flex-wrap items-center gap-2.5">
          <Button variant="primary" busy busyLabel="Saving…">
            Save
          </Button>
          <Button disabled>Disabled</Button>
          <ConfirmButton label="Revoke" confirmLabel="Revoke key" subject="sample key" onConfirm={() => undefined} />
          <CopyButton text="copied from the styleguide" label="sample text" />
          <CopyButton text="copied from the styleguide" label="sample text" caption="Copy link" />
          <Button onClick={() => toast.success('Saved')}>Show a toast</Button>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="quiet">Hover for a tooltip</Button>
              </TooltipTrigger>
              <TooltipContent>Tooltips explain icons and dense figures.</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Specimen>
      </Section>

      <Section id="forms" title="Form fields">
        <div className="grid items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <TextField label="Text field" placeholder="Placeholder" hint="A hint explains what is expected." />
          <TextField label="With an error" defaultValue="2 many" error="Enter a whole number of tokens, like 50m." />
          <TextField label="Mono field" mono defaultValue="https://github.com/example/gridrs" />
          <TextField label="Disabled" defaultValue="Not editable" disabled />
          <SelectField label="Select" defaultValue="trending">
            <option value="trending">Trending</option>
            <option value="recent">Newest</option>
          </SelectField>
          <div className="grid gap-1">
            <SwitchField label="Needs donors" checked onCheckedChange={() => undefined} />
            <SwitchField label="Off" checked={false} onCheckedChange={() => undefined} />
            <SwitchField label="Disabled" checked={false} onCheckedChange={() => undefined} disabled />
          </div>
        </div>
      </Section>

      <Section id="badges" title="Badges" note="Status is carried by words and icons. The accent tone means something is happening right now.">
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge variant="outline">New project</Badge>
          <Badge variant="secondary">Paused</Badge>
          <Badge variant="outline" className="gap-1.5 border-live/30 bg-live/8 text-live">
            <span className="live-dot" aria-hidden="true" /> Running
          </Badge>
        </div>
      </Section>

      <Section id="commands" title="Commands">
        <CommandLine command='agentfund work https://example.org/gridrs --budget 200m --schedule "02:00-06:00"' label="start working" />
      </Section>

      <Section id="navigation" title="Tabs">
        <Tabs
          label="Sample sections"
          items={[
            { to: '/styleguide', label: 'Current', count: 12, end: true },
            { to: '/styleguide/other', label: 'Other' },
            { to: '/styleguide/third', label: 'Third', count: 3 },
          ]}
        />
      </Section>

      <Section id="data" title="Data">
        <Specimen label="Project card: loaded and loading" className="grid gap-4 sm:grid-cols-2">
          <ProjectCard project={SAMPLE_PROJECT} />
          <ProjectCardSkeleton />
        </Specimen>
        <Specimen label="Event line: delivery and plain" className="surface divide-y px-4">
          <EventLine event={SAMPLE_EVENT} />
          <EventLine event={{ ...SAMPLE_EVENT, id: 'evt_sample_2', action: 'task.claimed', payload: {} }} />
        </Specimen>
      </Section>

      <Section id="states" title="Loading, empty, error" note="Every list and page has all three. Skeletons take the exact box of what replaces them.">
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Specimen label="Skeleton" className="grid gap-2">
            <Skeleton className="h-5 w-2/5" />
            <SkeletonRows rows={3} className="h-9" />
          </Specimen>
          <Specimen label="Notices" className="grid gap-3">
            <Notice title="This repository verifies">The lock signature is valid and every manifest matches its hash.</Notice>
            <Notice tone="strong" title="The latest commit was not indexed">
              Lock signature does not verify against the registered key.
            </Notice>
          </Specimen>
          <Specimen label="Empty" className="grid">
            <EmptyState icon={FolderGit2} title="No projects yet" action={<Button variant="primary">Register the first project</Button>}>
              <p>This instance is running and waiting for its first project.</p>
            </EmptyState>
          </Specimen>
          <Specimen label="Error" className="grid">
            <ErrorState title="Couldn't load projects" error={new TypeError('Failed to fetch')} onRetry={() => undefined} />
          </Specimen>
        </div>
      </Section>

      <Section id="overlays" title="Dialog and sheet" note="Focus is trapped inside, Escape closes, and focus returns to the button that opened it. Press ⌘K for the command palette.">
        <div className="flex flex-wrap gap-2.5">
          <Button onClick={() => setDialog('modal')}>Open dialog</Button>
          <Button onClick={() => setDialog('drawer')}>Open sheet</Button>
        </div>
        {dialog && (
          <Dialog
            variant={dialog}
            title={dialog === 'modal' ? 'A dialog' : 'A sheet'}
            subtitle="Used for backing a project and for task details."
            onClose={() => setDialog(null)}
          >
            <DialogSection>
              <p className="text-sm text-muted-foreground">Tab moves between the controls in here and nowhere else.</p>
              <TextField label="A field" placeholder="Type here" />
              <div>
                <Button variant="primary" onClick={() => setDialog(null)}>
                  Done
                </Button>
              </div>
            </DialogSection>
          </Dialog>
        )}
      </Section>
    </div>
  );
}

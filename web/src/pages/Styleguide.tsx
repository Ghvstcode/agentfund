import { type ReactNode, useEffect, useState } from 'react';
import type { AuditEvent, Project } from '../api/types';
import { Badge } from '../components/Badge';
import { Button, ButtonLink } from '../components/Button';
import { CommandLine } from '../components/CommandLine';
import { ConfirmButton } from '../components/ConfirmButton';
import { CopyButton } from '../components/CopyButton';
import { Dialog } from '../components/Dialog';
import { EventLine } from '../components/EventLine';
import { Checkbox, SelectField, TextField } from '../components/Field';
import { FundingBar } from '../components/FundingBar';
import { Hash } from '../components/Hash';
import { LiveIndicator } from '../components/LiveIndicator';
import { Num } from '../components/Num';
import { ProjectCard, ProjectCardSkeleton } from '../components/ProjectCard';
import { EmptyState, ErrorState, LoadMore, Notice, Skeleton, SkeletonRows } from '../components/States';
import { StatList } from '../components/StatList';
import { TableScroll } from '../components/TableScroll';
import { Tabs } from '../components/Tabs';
import { Time } from '../components/Time';
import { TokenCounter } from '../components/TokenCounter';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useTheme } from '../hooks/useTheme';

const COLOURS = [
  ['--color-bg', 'Page background'],
  ['--color-surface', 'Quiet fills: code, skeletons'],
  ['--color-fg', 'Text, strong rules, primary buttons'],
  ['--color-muted', 'Secondary text'],
  ['--color-line', 'Hairline rules'],
  ['--color-line-control', 'Borders of inputs'],
  ['--color-accent', 'Live values and progress only'],
  ['--color-on-fg', 'Text on foreground fills'],
] as const;

const TYPE = [
  ['--text-hero', 'Hero counter'],
  ['--text-2xl', 'Page title'],
  ['--text-xl', 'Project counter'],
  ['--text-lg', 'Section title'],
  ['--text-md', 'Lede'],
  ['--text-base', 'Body'],
  ['--text-sm', 'Secondary'],
  ['--text-xs', 'Labels'],
] as const;

const SPACES = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8', '--space-9'] as const;

const OTHER = ['--radius', '--page-max', '--page-gutter', '--control-height', '--motion-fast', '--motion-slow', '--font-sans', '--font-mono'] as const;

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
    <section className="sg-section" aria-labelledby={`sg-${id}`}>
      <header className="sg-section__header">
        <h2 id={`sg-${id}`}>{title}</h2>
        {note && <p className="muted">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sg-specimen">
      <p className="eyebrow">{label}</p>
      <div className="sg-specimen__body">{children}</div>
    </div>
  );
}

const SAMPLE_PROJECT: Project = {
  id: 'https://example.org/gridrs',
  slug: 'gridrs',
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
    <>
      <Specimen label="Hero · with data">
        <TokenCounter value={value} label="tokens delivered" size="hero" />
        <p className="in-flight" data-active={inFlight > 0 || undefined}>
          {inFlight > 0 ? (
            <>
              <span className="live-dot" aria-hidden="true" />
              <span>Running now</span>
              <TokenCounter value={inFlight} label="tokens in flight" size="md" tone="accent" />
            </>
          ) : (
            <span className="muted">No worker is running right now.</span>
          )}
        </p>
        <div className="button-row">
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
      </Specimen>
      <Specimen label="Before data arrives">
        <TokenCounter value={undefined} label="tokens delivered" size="xl" />
      </Specimen>
      <Specimen label="Sizes: xl, lg, md, sm · accent tone">
        <div className="sg-stack">
          <TokenCounter value={9_503_806} label="tokens" size="xl" />
          <TokenCounter value={9_503_806} label="tokens" size="lg" />
          <TokenCounter value={9_503_806} label="tokens" size="md" />
          <TokenCounter value={9_503_806} label="tokens" size="sm" />
          <TokenCounter value={412_907} label="tokens in flight" size="md" tone="accent" />
        </div>
      </Specimen>
    </>
  );
}

export default function Styleguide() {
  useDocumentTitle('Styleguide');
  const tokens = useTokenValues([...COLOURS.map(([name]) => name), ...TYPE.map(([name]) => name), ...SPACES, ...OTHER]);
  const [dialog, setDialog] = useState<'modal' | 'drawer' | null>(null);

  return (
    <div className="page styleguide">
      <header className="page__header">
        <h1>Styleguide</h1>
        <p className="lede">
          Every token and component of this interface, in every state. The whole theme lives in{' '}
          <code>src/styles/tokens.css</code>: change a value there and it changes here and everywhere else.
        </p>
      </header>

      <Section id="colour" title="Colour" note="Black, white, and one accent. The accent marks live values and progress, nothing else.">
        <ul className="sg-swatches">
          {COLOURS.map(([name, use]) => (
            <li key={name}>
              <span className="sg-swatch" style={{ background: `var(${name})` }} />
              <span className="mono">{name}</span>
              <span className="mono muted">{tokens[name]}</span>
              <span className="muted">{use}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="type" title="Type" note="Inter for words. JetBrains Mono, with tabular figures, for every number, hash, commit and key.">
        <ul className="sg-type">
          {TYPE.map(([name, use]) => (
            <li key={name}>
              <span className="mono muted">
                {name} · {tokens[name]}
              </span>
              <span style={{ fontSize: `var(${name})`, lineHeight: 1.15 }} className={name === '--text-hero' || name === '--text-xl' ? 'mono' : undefined}>
                {name === '--text-hero' || name === '--text-xl' ? '12 400 000' : use}
              </span>
            </li>
          ))}
        </ul>
        <Specimen label="Numbers and identifiers">
          <p>
            <Num value={12_400_000} /> compact · <Num value={12_400_000} exact /> exact · <Time value={SAMPLE_PROJECT.created_at} /> ·{' '}
            <Hash value={SAMPLE_PROJECT.pinned_commit} label="commit" /> ·{' '}
            <Hash value={SAMPLE_PROJECT.pubkey_fingerprint} label="key fingerprint" length={12} />
          </p>
        </Specimen>
      </Section>

      <Section id="space" title="Space and shape" note="A 4px grid, hairline rules, a 2px radius. No shadows, no gradients.">
        <ul className="sg-spaces">
          {SPACES.map((name) => (
            <li key={name}>
              <span className="mono">{name}</span>
              <span className="mono muted">{tokens[name]}</span>
              <span className="sg-space" style={{ width: `var(${name})` }} />
            </li>
          ))}
        </ul>
        <dl className="definitions definitions--wide definitions--mono">
          {OTHER.map((name) => (
            <div key={name} className="definitions__pair">
              <dt>{name}</dt>
              <dd>{tokens[name]}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="counter" title="Token counter" note="The live counter. Fixed-width wheels, thin gaps between thousands, no shift when the number grows.">
        <CounterDemo />
        <Specimen label="Stream status">
          <div className="sg-row">
            <LiveIndicator status="live" />
            <LiveIndicator status="connecting" />
            <LiveIndicator status="polling" />
            <LiveIndicator status="offline" />
          </div>
        </Specimen>
      </Section>

      <Section id="funding" title="Funding bar" note="Hairline track is the goal. Hairline in the text colour is pledged. Accent is delivered, with the merged part solid.">
        <Specimen label="Large · running">
          <FundingBar totals={SAMPLE_PROJECT.totals} goal={SAMPLE_PROJECT.token_goal} size="lg" />
          <StatList
            stats={[
              { label: 'Pledged', swatch: 'pledged', value: <Num value={41_500_000} /> },
              { label: 'Delivered', swatch: 'delivered', value: <Num value={24_873_412} />, note: 'CI passed' },
              { label: 'Merged', swatch: 'merged', value: <Num value={17_300_000} />, note: 'PR merged' },
            ]}
          />
        </Specimen>
        <Specimen label="Small · empty, partial, past the goal">
          <div className="sg-stack">
            <FundingBar totals={{ pledged: 0, delivered: 0, merged: 0, in_flight: 0 }} goal={60e6} />
            <FundingBar totals={{ pledged: 30e6, delivered: 9e6, merged: 4e6, in_flight: 0 }} goal={60e6} />
            <FundingBar totals={{ pledged: 80e6, delivered: 66e6, merged: 61e6, in_flight: 0 }} goal={60e6} />
          </div>
        </Specimen>
      </Section>

      <Section id="buttons" title="Buttons">
        <Specimen label="Variants">
          <div className="sg-row">
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="quiet">Quiet</Button>
            <ButtonLink to="/styleguide">Link as button</ButtonLink>
          </div>
        </Specimen>
        <Specimen label="Sizes">
          <div className="sg-row">
            <Button variant="primary" size="lg">
              <span aria-hidden="true">⚡ </span>Back with tokens
            </Button>
            <Button size="md">Medium</Button>
            <Button size="sm">Small</Button>
          </div>
        </Specimen>
        <Specimen label="States: busy, disabled, confirm">
          <div className="sg-row">
            <Button variant="primary" busy busyLabel="Saving…">
              Save
            </Button>
            <Button disabled>Disabled</Button>
            <ConfirmButton label="Revoke" confirmLabel="Revoke key" subject="sample key" onConfirm={() => undefined} />
            <CopyButton text="copied from the styleguide" label="sample text" />
          </div>
        </Specimen>
      </Section>

      <Section id="forms" title="Form fields">
        <div className="sg-grid">
          <TextField label="Text field" placeholder="Placeholder" hint="A hint explains what is expected." />
          <TextField label="With an error" defaultValue="2 many" error="Enter a whole number of tokens, like 50m." />
          <TextField label="Mono field" mono defaultValue="https://github.com/example/gridrs" />
          <TextField label="Disabled" defaultValue="Not editable" disabled />
          <SelectField label="Select" defaultValue="trending">
            <option value="trending">Trending</option>
            <option value="recent">Newest</option>
          </SelectField>
          <div className="sg-stack">
            <Checkbox label="Needs donors" defaultChecked />
            <Checkbox label="Unchecked" />
            <Checkbox label="Disabled" disabled />
          </div>
        </div>
      </Section>

      <Section id="badges" title="Badges and tags" note="Status is carried by words. The accent tone means something is happening right now.">
        <div className="sg-row">
          <Badge>Needs donors</Badge>
          <Badge tone="strong">Paused</Badge>
          <Badge tone="live">Running now</Badge>
          <ul className="tag-list">
            <li className="tag tag--language">rust</li>
            <li className="tag">tui</li>
            <li className="tag">spreadsheet</li>
          </ul>
        </div>
      </Section>

      <Section id="commands" title="Commands and keys">
        <CommandLine command="agentfund work https://example.org/gridrs --budget 200m" label="start working" />
        <span className="key-line">
          <code className="key-line__value">{SAMPLE_PROJECT.pubkey_fingerprint}</code>
          <CopyButton text={SAMPLE_PROJECT.pubkey_fingerprint} label="the key fingerprint" />
        </span>
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
        <Specimen label="Project card · loaded and loading">
          <div className="project-grid">
            <ProjectCard project={SAMPLE_PROJECT} />
            <ProjectCardSkeleton />
          </div>
        </Specimen>
        <Specimen label="Statistics">
          <StatList
            stats={[
              { label: 'Pledged', value: <Num value={888_900_000} /> },
              { label: 'Merged', value: <Num value={61_873_509} /> },
              { label: 'Projects', value: <Num value={12} unit="" /> },
            ]}
          />
        </Specimen>
        <Specimen label="Table">
          <TableScroll label="Sample table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="table__rank">
                    Rank
                  </th>
                  <th scope="col">Donor</th>
                  <th scope="col" className="table__num">
                    Delivered
                  </th>
                  <th scope="col">Head</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['barbara', 12_888_564],
                  ['niklaus', 11_081_619],
                  ['ada', 7_521_643],
                ].map(([handle, delivered], index) => (
                  <tr key={handle}>
                    <td className="table__rank mono">{index + 1}</td>
                    <th scope="row">{handle}</th>
                    <td className="table__num table__lead">
                      <Num value={Number(delivered)} />
                    </td>
                    <td>
                      <Hash value={SAMPLE_PROJECT.pinned_commit} label="commit" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Specimen>
        <Specimen label="Event line · delivery and plain">
          <ol className="event-list">
            <li>
              <EventLine event={SAMPLE_EVENT} />
            </li>
            <li>
              <EventLine event={{ ...SAMPLE_EVENT, id: 'evt_sample_2', action: 'task.claimed', payload: {} }} />
            </li>
          </ol>
        </Specimen>
      </Section>

      <Section id="states" title="Loading, empty, error" note="Every list and page has all three.">
        <div className="sg-grid">
          <Specimen label="Skeleton">
            <div className="sg-stack">
              <Skeleton width="40%" height="1.4rem" />
              <SkeletonRows rows={3} height="2rem" />
            </div>
          </Specimen>
          <Specimen label="Empty">
            <EmptyState title="No donors yet" action={<Button>Find a project to back</Button>}>
              <p>The board fills in as soon as a worker reports its first run.</p>
            </EmptyState>
          </Specimen>
          <Specimen label="Error">
            <ErrorState title="Couldn't load projects" error={new TypeError('Failed to fetch')} onRetry={() => undefined} />
          </Specimen>
          <Specimen label="Notices">
            <div className="sg-stack">
              <Notice title="This repository verifies">The lock signature is valid and every manifest matches its hash.</Notice>
              <Notice tone="strong" title="The latest commit was not indexed">
                Lock signature does not verify against the registered key.
              </Notice>
            </div>
          </Specimen>
        </div>
        <LoadMore hasMore loading={false} onLoad={() => undefined} />
      </Section>

      <Section id="overlays" title="Dialog and drawer" note="Focus is trapped inside, Escape closes, and focus returns to the button that opened it.">
        <div className="sg-row">
          <Button onClick={() => setDialog('modal')}>Open dialog</Button>
          <Button onClick={() => setDialog('drawer')}>Open drawer</Button>
        </div>
        {dialog && (
          <Dialog
            variant={dialog}
            title={dialog === 'modal' ? 'A dialog' : 'A drawer'}
            subtitle="Used for backing a project and for task details."
            onClose={() => setDialog(null)}
          >
            <section className="dialog-section">
              <p>Tab moves between the controls in here and nowhere else.</p>
              <TextField label="A field" placeholder="Type here" />
              <div className="button-row">
                <Button variant="primary" onClick={() => setDialog(null)}>
                  Done
                </Button>
              </div>
            </section>
          </Dialog>
        )}
      </Section>
    </div>
  );
}

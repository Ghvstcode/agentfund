import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CircleCheck, CircleMinus, CircleX, Clock, type LucideIcon, Rocket, ShieldCheck, ShieldX } from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, unwrap } from '@/api/client';
import { useMeta } from '@/api/queries';
import type { Project, ProjectPreview } from '@/api/types';
import { Button, ButtonLink } from '@/components/Button';
import { CommandLine } from '@/components/CommandLine';
import { CopyButton } from '@/components/CopyButton';
import { TextField } from '@/components/Field';
import { Hash } from '@/components/Hash';
import { Num } from '@/components/Num';
import { SignInRequired } from '@/components/SignIn';
import { describeError, Notice } from '@/components/States';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { WebhookPanel } from '@/components/WebhookPanel';
import { CLI_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useSession } from '@/hooks/useSession';
import { formatExact, parseTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';

const STEPS = ['Repository', 'Review', 'Live'] as const;

function StepList({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-3" aria-label="Progress">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2.5 text-sm whitespace-nowrap',
              active ? 'font-medium' : 'text-muted-foreground',
              // The connector to the next step; it fills in once this step is done.
              index < STEPS.length - 1 && 'flex-1 after:h-px after:min-w-4 after:flex-1 after:bg-border after:transition-colors',
              done && 'text-foreground after:bg-foreground',
            )}
          >
            <span
              className={cn(
                'num flex size-7 shrink-0 items-center justify-center rounded-full border text-xs transition-colors',
                active && 'border-foreground bg-foreground text-background',
                done && 'border-foreground',
              )}
            >
              {done ? (
                <>
                  <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  <span className="sr-only">Done:</span>
                </>
              ) : (
                index + 1
              )}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** A wizard card: title row, body, and an optional footer for the step's actions. */
function Panel({ header, footer, children, className }: { header: ReactNode; footer?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('surface overflow-hidden', className)}>
      <div className="grid gap-1 border-b px-5 py-4">{header}</div>
      {children}
      {footer && <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-5 py-3">{footer}</div>}
    </div>
  );
}

type CheckState = 'ok' | 'failed' | 'skipped';

const CHECK_ICONS: Record<CheckState, LucideIcon> = { ok: CircleCheck, failed: CircleX, skipped: CircleMinus };

interface CheckItem {
  label: ReactNode;
  state: CheckState;
  /** The outcome in words, so the icon is never the only signal. */
  outcome: string;
}

/**
 * What the preview proves, in the order the server checks it. A check that an earlier
 * failure made impossible is "not checked" rather than failed.
 */
function checklist(preview: ProjectPreview): CheckItem[] {
  const fetched = preview.commit !== undefined;
  const parsed = preview.agentfund !== undefined;
  const signature = preview.signature_valid;
  const count = preview.manifests?.length ?? 0;
  return [
    { label: 'Repository fetched', state: fetched ? 'ok' : 'failed', outcome: fetched ? 'Fetched' : 'Could not be read' },
    {
      label: (
        <>
          <code>agentfund.yaml</code> parsed
        </>
      ),
      state: parsed ? 'ok' : fetched ? 'failed' : 'skipped',
      outcome: parsed ? 'Parsed' : fetched ? 'Not parsed' : 'Not checked',
    },
    {
      label: 'Lock signature',
      state: signature === undefined ? 'skipped' : signature ? 'ok' : 'failed',
      outcome: signature === undefined ? 'Not checked' : signature ? 'Valid' : 'Does not verify',
    },
    // Only an overall pass proves every hash; a failed preview does not say which check failed.
    preview.ok
      ? { label: `${count} ${count === 1 ? 'manifest matches its hash' : 'manifests match their hashes'}`, state: 'ok', outcome: 'Match' }
      : { label: 'Manifests match their hashes', state: 'skipped', outcome: 'Not confirmed' },
  ];
}

function Checklist({ preview }: { preview: ProjectPreview }) {
  return (
    <ul aria-label="Verification checks" className="divide-y">
      {checklist(preview).map((item, index) => {
        const Icon = CHECK_ICONS[item.state];
        return (
          <li key={index} className="flex items-center gap-3 px-5 py-3 text-sm">
            <Icon
              className={cn('size-4 shrink-0', item.state === 'failed' ? 'text-destructive' : item.state === 'skipped' && 'text-muted-foreground')}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className={cn('min-w-0 flex-1', item.state === 'skipped' && 'text-muted-foreground')}>{item.label}</span>
            <span className={cn('text-xs', item.state === 'failed' ? 'font-medium text-destructive' : 'text-muted-foreground')}>
              {item.outcome}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A long key split into groups of four for comparing by eye; the copy and screen-reader text stay whole. */
function Fingerprint({ value }: { value: string }) {
  const split = value.indexOf(':') + 1;
  const groups = value.slice(split).match(/.{1,4}/g) ?? [];
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/40 py-2 pr-2 pl-3">
      <code className="num flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-0.5 py-0.5 text-[0.8125rem] leading-5" aria-hidden="true">
        {split > 0 && <span className="text-muted-foreground">{value.slice(0, split)}</span>}
        {groups.map((group, index) => (
          <span key={index}>{group}</span>
        ))}
      </code>
      <span className="sr-only">{value}</span>
      <CopyButton text={value} label="the key fingerprint" />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 px-5 py-3.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="grid min-w-0 gap-2 text-sm">{children}</dd>
    </div>
  );
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function Review({ preview }: { preview: ProjectPreview }) {
  const descriptor = Object.entries(preview.agentfund ?? {});
  const manifests = preview.manifests ?? [];
  const hasFacts = Boolean(preview.pubkey_fingerprint || preview.commit || preview.lock_sha256 || preview.token_total !== undefined);
  return (
    <>
      {preview.ok ? (
        <Notice title="This repository verifies" icon={ShieldCheck} role="status">
          The lock signature is valid for the key in <code>agentfund.yaml</code>, and every manifest matches its hash.
        </Notice>
      ) : (
        <Notice tone="strong" title="This repository can't be registered yet" icon={ShieldX} role="alert">
          <ul className="grid gap-1">
            {preview.errors.length > 0 ? (
              preview.errors.map((error) => (
                <li key={error} className="num text-[0.8125rem] text-foreground">
                  {error}
                </li>
              ))
            ) : (
              <li>Verification failed without a specific reason.</li>
            )}
          </ul>
          {/* No signature verdict means the repository was never read: nothing to re-sign. */}
          {preview.signature_valid === undefined ? (
            <p>Check the URL and that the repository is public, then try again.</p>
          ) : (
            <p>
              Fix these in the repository, run <code>{CLI_NAME} sign</code>, push, and check again.
            </p>
          )}
        </Notice>
      )}

      <section className="surface overflow-hidden" aria-labelledby="wizard-checks">
        <h3 id="wizard-checks" className="border-b px-5 py-4 text-sm font-semibold tracking-tight">
          Verification
        </h3>
        <Checklist preview={preview} />
        {hasFacts && (
          <dl className="divide-y border-t">
            {preview.pubkey_fingerprint && (
              <Fact label="Key fingerprint">
                <Fingerprint value={preview.pubkey_fingerprint} />
                <p className="text-xs text-pretty text-muted-foreground">
                  This key is registered with the project. Donors compare it with what{' '}
                  <code className="text-foreground">{CLI_NAME} approve</code> prints, so check it is yours.
                </p>
              </Fact>
            )}
            {preview.commit && (
              <Fact label="Commit">
                <span className="flex flex-wrap items-center gap-2">
                  <Hash value={preview.commit} label="commit" length={12} />
                  {preview.base_branch && (
                    <span className="text-xs text-muted-foreground">
                      head of <span className="num">{preview.base_branch}</span>
                    </span>
                  )}
                </span>
              </Fact>
            )}
            {preview.lock_sha256 && (
              <Fact label="Lock file">
                <span>
                  <Hash value={`sha256:${preview.lock_sha256}`} label="lock file hash" length={16} />
                </span>
              </Fact>
            )}
            {preview.token_total !== undefined && (
              <Fact label="Token caps, total">
                <span>
                  <Num value={preview.token_total} exact />{' '}
                  <span className="text-xs text-muted-foreground">
                    across <span className="num">{manifests.length}</span> {manifests.length === 1 ? 'manifest' : 'manifests'}
                  </span>
                </span>
              </Fact>
            )}
          </dl>
        )}
      </section>

      {descriptor.length > 0 && (
        <section className="surface overflow-hidden" aria-labelledby="wizard-descriptor">
          <h3 id="wizard-descriptor" className="border-b px-5 py-4 text-sm font-semibold tracking-tight">
            <code>agentfund.yaml</code>, as parsed
          </h3>
          <dl className="num divide-y text-[0.8125rem]">
            {descriptor.map(([key, value]) => (
              <div key={key} className="grid gap-x-4 gap-y-0.5 px-5 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words">{describeValue(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {manifests.length > 0 && (
        <section className="surface overflow-hidden" aria-labelledby="wizard-manifests">
          <h3 id="wizard-manifests" className="border-b px-5 py-4 text-sm font-semibold tracking-tight">
            Task manifests
          </h3>
          <Table aria-labelledby="wizard-manifests">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="h-9 pl-5 text-xs font-medium text-muted-foreground">
                  Task
                </TableHead>
                <TableHead scope="col" className="h-9 text-right text-xs font-medium text-muted-foreground">
                  Token cap
                </TableHead>
                <TableHead scope="col" className="h-9 text-xs font-medium text-muted-foreground">
                  Content hash
                </TableHead>
                <TableHead scope="col" className="hidden h-9 pr-5 text-xs font-medium text-muted-foreground sm:table-cell">
                  Depends on
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manifests.map((manifest) => (
                <TableRow key={manifest.id} className="hover:bg-muted/40">
                  <TableHead scope="row" className="h-auto w-full max-w-0 py-2.5 pl-5 font-normal whitespace-normal">
                    <span className="block font-medium">{manifest.title}</span>
                    <span className="num block text-xs text-muted-foreground [overflow-wrap:anywhere]">{manifest.path}</span>
                  </TableHead>
                  <TableCell className="text-right">
                    <Num value={manifest.max_tokens} />
                  </TableCell>
                  <TableCell>
                    <Hash value={manifest.content_hash} label={`content hash of ${manifest.id}`} length={8} />
                  </TableCell>
                  <TableCell className="num hidden pr-5 text-xs text-muted-foreground sm:table-cell">
                    {manifest.depends_on?.length ? manifest.depends_on.join(', ') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </>
  );
}

function Done({ project }: { project: Project }) {
  const meta = useMeta();
  const pending = project.status === 'pending';
  return (
    <>
      <Notice
        title={pending ? `${project.name} is waiting for approval` : `${project.name} is live`}
        icon={pending ? Clock : Rocket}
        role="status"
      >
        {pending
          ? 'This instance reviews new projects. It will be listed and claimable as soon as an admin approves it.'
          : 'It is listed on the instance and its tasks can be claimed now.'}
      </Notice>
      {meta.data && (
        <section className="surface overflow-hidden" aria-labelledby="wizard-share">
          <div className="grid gap-1 border-b px-5 py-4">
            <h3 id="wizard-share" className="text-sm font-semibold tracking-tight">
              Tell your donors
            </h3>
            <p className="text-sm text-muted-foreground">One line starts the review of your key and task list on their machine.</p>
          </div>
          <div className="p-5">
            <CommandLine command={`${CLI_NAME} approve ${meta.data.base_url}/${project.slug}`} label="approve the project" />
          </div>
        </section>
      )}
      <section className="surface overflow-hidden" aria-labelledby="wizard-ci">
        <div className="grid gap-1 border-b px-5 py-4">
          <h3 id="wizard-ci" className="text-sm font-semibold tracking-tight">
            Connect CI
          </h3>
          <p className="text-sm text-muted-foreground">Delivery is only counted when CI confirms it. This is the last step.</p>
        </div>
        <WebhookPanel slug={project.slug} defaultOpen />
      </section>
      <div className="flex flex-wrap gap-2">
        <ButtonLink to={`/${project.slug}`} variant="primary">
          Open the project page
          <ArrowRight strokeWidth={1.5} aria-hidden="true" />
        </ButtonLink>
        <ButtonLink to="/maintain">Back to your projects</ButtonLink>
      </div>
    </>
  );
}

const STEP_HEADING = 'rounded-sm text-base font-semibold tracking-tight outline-offset-4';

export default function ProjectWizard() {
  useDocumentTitle('Register a project');
  const token = useSession();
  const queryClient = useQueryClient();
  const [repoUrl, setRepoUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [goal, setGoal] = useState('');
  const [goalInvalid, setGoalInvalid] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const preview = useMutation({
    mutationFn: (url: string) => unwrap(api.POST('/v1/projects/preview', { body: { repo_url: url } })),
    onSuccess: (result) => setSlug(result.suggested_slug ?? ''),
  });
  const create = useMutation({
    mutationFn: (body: { repo_url: string; slug?: string; token_goal?: number }) => unwrap(api.POST('/v1/projects', { body })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const step = create.isSuccess ? 2 : preview.isSuccess ? 1 : 0;
  // Each step replaces the last; put keyboard and screen-reader focus on its heading.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  if (!token) {
    return <SignInRequired title="Register a project" reason="Sign in to register a repository. You become its maintainer on this instance." />;
  }

  const check = (event: FormEvent) => {
    event.preventDefault();
    preview.mutate(repoUrl.trim());
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    const tokens = goal.trim() ? parseTokenAmount(goal) : undefined;
    setGoalInvalid(tokens === null);
    if (tokens === null) return;
    create.mutate({ repo_url: repoUrl.trim(), slug: slug.trim() || undefined, token_goal: tokens });
  };

  // `agentfund` is the parsed descriptor: free-form as far as the API schema is concerned.
  const declaredGoal = (preview.data?.agentfund as Record<string, unknown> | undefined)?.token_goal;
  const startOver = () => {
    create.reset();
    preview.reset();
  };

  return (
    <section className="container-page py-10">
      <div className="mx-auto grid max-w-3xl gap-8">
        <header className="rise grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Register a project</h1>
          <p className="max-w-prose text-sm text-pretty text-muted-foreground">
            Point this instance at a repository. It reads <code className="text-foreground">agentfund.yaml</code> and the signed lock,
            shows you what it found, and creates nothing until you confirm.
          </p>
        </header>
        <div className="rise" style={{ '--i': 1 } as CSSProperties}>
          <StepList current={step} />
        </div>

        {step === 0 && (
          <form className="rise" style={{ '--i': 2 } as CSSProperties} onSubmit={check}>
            <Panel
              header={
                <>
                  <h2 ref={heading} tabIndex={-1} className={STEP_HEADING}>
                    Repository
                  </h2>
                  <p className="text-sm text-muted-foreground">The repository is read and verified. Nothing is created yet.</p>
                </>
              }
              footer={
                <Button type="submit" variant="primary" className="ml-auto" busy={preview.isPending} busyLabel="Reading the repository…">
                  Check repository
                </Button>
              }
            >
              <div className="p-5">
                <TextField
                  label="Repository URL"
                  type="url"
                  mono
                  required
                  placeholder="https://github.com/owner/repo"
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  spellCheck={false}
                  hint="A public repository reachable over HTTPS."
                  error={preview.isError ? describeError(preview.error) : null}
                />
              </div>
            </Panel>
          </form>
        )}

        {step === 1 && preview.data && (
          <form className="grid gap-6" onSubmit={confirm} noValidate>
            <h2 ref={heading} tabIndex={-1} className={cn(STEP_HEADING, 'flex flex-wrap items-baseline gap-x-2.5 gap-y-1')}>
              Review <span className="num text-sm font-normal break-all text-muted-foreground">{repoUrl.replace(/^https?:\/\//, '')}</span>
            </h2>
            <Review preview={preview.data} />
            {preview.data.ok ? (
              <Panel
                header={
                  <>
                    <h3 className="text-sm font-semibold tracking-tight">Create the project</h3>
                    <p className="text-sm text-muted-foreground">You become its maintainer on this instance.</p>
                  </>
                }
                footer={
                  <>
                    <Button onClick={startOver}>Use a different repository</Button>
                    <Button type="submit" variant="primary" className="ml-auto" busy={create.isPending} busyLabel="Creating…">
                      Create project
                    </Button>
                  </>
                }
              >
                <div className="grid gap-5 p-5 sm:grid-cols-2">
                  <TextField
                    label="Slug"
                    mono
                    required
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    pattern="[a-z0-9][a-z0-9\-]{0,62}"
                    spellCheck={false}
                    hint="The project's address on this instance. Lowercase letters, digits and dashes."
                    error={create.isError && create.error ? describeError(create.error) : null}
                  />
                  <TextField
                    label="Token goal (optional)"
                    mono
                    value={goal}
                    onChange={(event) => setGoal(event.target.value)}
                    placeholder={typeof declaredGoal === 'number' ? formatExact(declaredGoal) : '60m'}
                    hint="Overrides the goal in agentfund.yaml. You can change it later."
                    error={goalInvalid ? 'Enter a whole number of tokens, like 60m.' : null}
                  />
                </div>
              </Panel>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={startOver}>Back</Button>
              </div>
            )}
          </form>
        )}

        {step === 2 && create.data && (
          <div className="grid gap-6">
            <h2 ref={heading} tabIndex={-1} className={STEP_HEADING}>
              Live
            </h2>
            <Done project={create.data} />
          </div>
        )}
      </div>
    </section>
  );
}

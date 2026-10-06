import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, unwrap } from '@/api/client';
import { queryKeys, useMe, useMeta } from '@/api/queries';
import type { Project } from '@/api/types';
import { CLI_NAME } from '@/config';
import { backCommands } from '@/lib/commands';
import { formatExact, parseTokenAmount } from '@/lib/format';
import { Button } from './Button';
import { CommandLine } from './CommandLine';
import { Dialog, DialogSection } from './Dialog';
import { TextField } from './Field';
import { Hash } from './Hash';
import { describeError, Notice, Skeleton } from './States';

const WILL = [
  'Checks the signed task manifests against the key you approved, and refuses anything that does not verify.',
  'Runs each task in a network-restricted sandbox under your own Claude Code login, inside your budget caps.',
  'Opens a pull request. Its tokens only count once CI passes.',
];

const NEVER = [
  "Touches files outside the task's declared scope.",
  'Sends your credentials anywhere.',
  "Runs anything you haven't approved.",
];

function PledgeForm({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [invalid, setInvalid] = useState(false);
  const pledge = useMutation({
    mutationFn: (tokens: number) =>
      unwrap(
        api.POST('/v1/projects/{slug}/pledges', {
          params: { path: { slug: project.slug } },
          body: { token_amount: tokens },
        }),
      ),
    onSuccess: () => {
      setAmount('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(project.slug) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const tokens = parseTokenAmount(amount);
    setInvalid(tokens === null);
    if (tokens !== null) pledge.mutate(tokens);
  };

  return (
    <form className="grid gap-2" onSubmit={submit} noValidate>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        <TextField
          label="Pledge an amount"
          mono
          inputMode="text"
          placeholder="50m"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint="Optional. A pledge is a public statement of intent; only delivered tokens count on leaderboards."
          error={invalid ? 'Enter a whole number of tokens, like 50m or 2,500,000.' : pledge.isError ? describeError(pledge.error) : null}
        />
        {/* Offset by the label's height so the button lines up with the input. */}
        <Button type="submit" busy={pledge.isPending} busyLabel="Pledging…" className="mt-[1.375rem] h-9">
          Pledge
        </Button>
      </div>
      {pledge.isSuccess && (
        <p role="status" className="text-sm">
          Pledged <span className="num">{formatExact(pledge.data.token_amount)}</span> tokens. It is in the ledger now.
        </p>
      )}
    </form>
  );
}

function Behaviour({ title, items, icon: Icon, tone }: { title: string; items: string[]; icon: typeof Check; tone: string }) {
  return (
    <div className="grid content-start gap-2.5 rounded-lg border bg-muted/30 p-4">
      <h4 className="text-sm font-semibold tracking-tight">{title}</h4>
      <ul className="grid gap-2.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-sm text-pretty text-muted-foreground">
            <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${tone}`}>
              <Icon className="size-2.5" strokeWidth={3} aria-hidden="true" />
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BackDialogProps {
  project: Project;
  onClose: () => void;
}

/** How to back a project: the exact CLI lines, what the worker will and won't do, and pledging. */
export function BackDialog({ project, onClose }: BackDialogProps) {
  const meta = useMeta();
  const me = useMe();

  return (
    <Dialog
      title={`Back ${project.name} with tokens`}
      subtitle="You donate inference, not money. The work runs on your machine under your own Claude Code subscription."
      onClose={onClose}
    >
      <DialogSection title="Run these lines" id="back-commands">
        <p className="text-sm text-pretty text-muted-foreground [&_code]:text-foreground">
          You need Docker running, and Claude Code credentials in the environment: <code>CLAUDE_CODE_OAUTH_TOKEN</code>{' '}
          from <code>claude setup-token</code>, or <code>ANTHROPIC_API_KEY</code>. The worker never stores them.
        </p>
        {meta.isPending ? (
          <Skeleton className="h-80" />
        ) : meta.isError ? (
          <Notice tone="strong" role="alert" title="Couldn't build the commands">
            {describeError(meta.error)}
          </Notice>
        ) : (
          <ol className="grid grid-cols-[minmax(0,1fr)]">
            {backCommands(meta.data, project.slug).map((line, index, all) => (
              <li key={line.command} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                {index < all.length - 1 && <span aria-hidden="true" className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border" />}
                <span aria-hidden="true" className="num relative flex size-6 items-center justify-center rounded-full border bg-card text-xs font-medium">
                  {index + 1}
                </span>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
                  <p className="pt-0.5 text-sm font-medium">{line.label}</p>
                  <CommandLine command={line.command} label={line.label} />
                  {line.note && <p className="text-xs text-muted-foreground">{line.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground [&_code]:text-foreground">
          <span>
            The fingerprint <code>{CLI_NAME} approve</code> shows must match
          </span>
          <Hash value={project.pubkey_fingerprint} label="key fingerprint" length={16} />
        </p>
      </DialogSection>

      <DialogSection title="What the worker does" id="back-explainer">
        <div className="grid gap-3 sm:grid-cols-2">
          <Behaviour title="It will" items={WILL} icon={Check} tone="bg-foreground text-background" />
          <Behaviour title="It never" items={NEVER} icon={X} tone="border border-foreground/40 text-foreground" />
        </div>
      </DialogSection>

      <DialogSection title="Pledge" id="back-pledge">
        {me.data ? (
          <PledgeForm project={project} />
        ) : (
          <p className="text-sm text-pretty text-muted-foreground">
            Sign in to record a pledge. You don't need one to start working: delivered tokens are counted either way.
          </p>
        )}
      </DialogSection>
    </Dialog>
  );
}

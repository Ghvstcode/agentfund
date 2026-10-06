import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, unwrap } from '../api/client';
import { queryKeys, useMe, useMeta } from '../api/queries';
import type { Project } from '../api/types';
import { CLI_NAME } from '../config';
import { backCommands } from '../lib/commands';
import { formatExact, parseTokenAmount } from '../lib/format';
import { Button } from './Button';
import { CommandLine } from './CommandLine';
import { Dialog } from './Dialog';
import { TextField } from './Field';
import { Hash } from './Hash';
import { describeError, Notice, Skeleton } from './States';

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
    <form className="inline-form" onSubmit={submit} noValidate>
      <TextField
        label="Pledge an amount"
        mono
        inputMode="text"
        placeholder="50m"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        hint="Optional. A pledge is a public statement of intent; only delivered tokens count on leaderboards."
        error={
          invalid
            ? 'Enter a whole number of tokens, like 50m or 2,500,000.'
            : pledge.isError
              ? describeError(pledge.error)
              : null
        }
      />
      <Button type="submit" busy={pledge.isPending} busyLabel="Pledging…">
        Pledge
      </Button>
      {pledge.isSuccess && (
        <p className="inline-form__result" role="status">
          Pledged <span className="mono">{formatExact(pledge.data.token_amount)}</span> tokens. It is in the ledger now.
        </p>
      )}
    </form>
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
      <section className="dialog-section" aria-labelledby="back-commands">
        <h3 id="back-commands">Run these lines</h3>
        <p className="muted">
          You need Docker running, and Claude Code credentials in the environment: <code>CLAUDE_CODE_OAUTH_TOKEN</code>{' '}
          from <code>claude setup-token</code>, or <code>ANTHROPIC_API_KEY</code>. The worker never stores them.
        </p>
        {meta.isPending ? (
          <Skeleton height="16rem" />
        ) : meta.isError ? (
          <Notice tone="strong" role="alert" title="Couldn't build the commands">
            {describeError(meta.error)}
          </Notice>
        ) : (
          <ol className="command-list">
            {backCommands(meta.data, project.slug).map((line) => (
              <li key={line.command}>
                <p className="command-list__label">{line.label}</p>
                <CommandLine command={line.command} label={line.label} />
                {line.note && <p className="command-list__note">{line.note}</p>}
              </li>
            ))}
          </ol>
        )}
        <p className="muted">
          The fingerprint <code>{CLI_NAME} approve</code> shows must match this one:{' '}
          <Hash value={project.pubkey_fingerprint} label="key fingerprint" length={16} />
        </p>
      </section>

      <section className="dialog-section" aria-labelledby="back-explainer">
        <h3 id="back-explainer">What the worker does</h3>
        <ol className="steps">
          <li>
            <strong>Verifies.</strong> Before anything runs, it checks the signed task manifests against the key you
            approved. A task that does not verify is refused.
          </li>
          <li>
            <strong>Runs in a sandbox.</strong> Each task runs in a network-restricted sandbox under your own Claude
            Code login, inside the budget caps you set.
          </li>
          <li>
            <strong>Opens a pull request.</strong> The result is pushed as a PR, and its tokens only count once CI
            passes on it.
          </li>
        </ol>
        <p>
          It never touches files outside the task's declared scope, never sends your credentials anywhere, and never
          runs anything you haven't approved.
        </p>
      </section>

      <section className="dialog-section" aria-labelledby="back-pledge">
        <h3 id="back-pledge">Pledge</h3>
        {me.data ? (
          <PledgeForm project={project} />
        ) : (
          <p className="muted">
            Sign in to record a pledge. You don't need one to start working: delivered tokens are counted either way.
          </p>
        )}
      </section>
    </Dialog>
  );
}

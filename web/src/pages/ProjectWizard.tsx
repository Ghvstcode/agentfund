import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, unwrap } from '../api/client';
import { useMeta } from '../api/queries';
import type { Project, ProjectPreview } from '../api/types';
import { Button, ButtonLink } from '../components/Button';
import { CommandLine } from '../components/CommandLine';
import { CopyButton } from '../components/CopyButton';
import { TextField } from '../components/Field';
import { Hash } from '../components/Hash';
import { Num } from '../components/Num';
import { SignInRequired } from '../components/SignIn';
import { describeError, Notice } from '../components/States';
import { TableScroll } from '../components/TableScroll';
import { CLI_NAME } from '../config';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSession } from '../hooks/useSession';
import { formatExact, parseTokenAmount } from '../lib/format';

const STEPS = ['Repository', 'Review', 'Live'] as const;

function StepList({ current }: { current: number }) {
  return (
    <ol className="wizard-steps" aria-label="Progress">
      {STEPS.map((label, index) => (
        <li key={label} aria-current={index === current ? 'step' : undefined} data-done={index < current || undefined}>
          <span className="mono">{index + 1}</span> {label}
        </li>
      ))}
    </ol>
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
  return (
    <>
      {preview.ok ? (
        <Notice title="This repository verifies" role="status">
          The lock signature is valid for the key in <code>agentfund.yaml</code>, and every manifest matches its hash.
        </Notice>
      ) : (
        <Notice tone="strong" title="This repository can't be registered yet" role="alert">
          <ul className="bullet-list">
            {preview.errors.length > 0 ? (
              preview.errors.map((error) => <li key={error}>{error}</li>)
            ) : (
              <li>Verification failed without a specific reason.</li>
            )}
          </ul>
          <p>
            Fix these in the repository, run <code>{CLI_NAME} sign</code>, push, and check again.
          </p>
        </Notice>
      )}

      <dl className="definitions definitions--wide">
        <dt>Signature</dt>
        <dd>
          <strong>{preview.signature_valid ? 'Valid' : 'Does not verify'}</strong>
        </dd>
        {preview.pubkey_fingerprint && (
          <>
            <dt>Key fingerprint</dt>
            <dd>
              <span className="key-line">
                <code className="key-line__value">{preview.pubkey_fingerprint}</code>
                <CopyButton text={preview.pubkey_fingerprint} label="the key fingerprint" />
              </span>
              <p className="muted">
                This key is registered with the project. Donors compare it with what <code>{CLI_NAME} approve</code>{' '}
                prints, so check it is yours.
              </p>
            </dd>
          </>
        )}
        {preview.commit && (
          <>
            <dt>Commit</dt>
            <dd>
              <Hash value={preview.commit} label="commit" length={12} />{' '}
              {preview.base_branch && (
                <span className="muted">
                  head of <span className="mono">{preview.base_branch}</span>
                </span>
              )}
            </dd>
          </>
        )}
        {preview.lock_sha256 && (
          <>
            <dt>Lock file</dt>
            <dd>
              <Hash value={`sha256:${preview.lock_sha256}`} label="lock file hash" length={16} />
            </dd>
          </>
        )}
        {preview.token_total !== undefined && (
          <>
            <dt>Token caps, total</dt>
            <dd>
              <Num value={preview.token_total} exact />{' '}
              <span className="muted">
                across {manifests.length} {manifests.length === 1 ? 'manifest' : 'manifests'}
              </span>
            </dd>
          </>
        )}
      </dl>

      {descriptor.length > 0 && (
        <section className="wizard__block" aria-labelledby="wizard-descriptor">
          <h3 id="wizard-descriptor">
            <code>agentfund.yaml</code>, as parsed
          </h3>
          <dl className="definitions definitions--wide definitions--mono">
            {descriptor.map(([key, value]) => (
              <div key={key} className="definitions__pair">
                <dt>{key}</dt>
                <dd>{describeValue(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {manifests.length > 0 && (
        <section className="wizard__block" aria-labelledby="wizard-manifests">
          <h3 id="wizard-manifests">Task manifests</h3>
          <TableScroll label="Task manifests">
            <table className="table table--dense">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col" className="table__num">
                    Token cap
                  </th>
                  <th scope="col">Content hash</th>
                  <th scope="col">Depends on</th>
                </tr>
              </thead>
              <tbody>
                {manifests.map((manifest) => (
                  <tr key={manifest.id}>
                    <td>
                      {manifest.title}
                      <span className="table__sub mono">{manifest.path}</span>
                    </td>
                    <td className="table__num">
                      <Num value={manifest.max_tokens} />
                    </td>
                    <td>
                      <Hash value={manifest.content_hash} label={`content hash of ${manifest.id}`} length={12} />
                    </td>
                    <td className="mono">{manifest.depends_on?.length ? manifest.depends_on.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
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
      <Notice title={pending ? `${project.name} is waiting for approval` : `${project.name} is live`} role="status">
        {pending
          ? 'This instance reviews new projects. It will be listed and claimable as soon as an admin approves it.'
          : 'It is listed on the instance and its tasks can be claimed now.'}
      </Notice>
      {meta.data && (
        <section className="wizard__block" aria-labelledby="wizard-share">
          <h3 id="wizard-share">Tell your donors</h3>
          <p className="muted">One line starts the review of your key and task list on their machine.</p>
          <CommandLine command={`${CLI_NAME} approve ${meta.data.base_url}/${project.slug}`} label="approve the project" />
        </section>
      )}
      <div className="button-row">
        <ButtonLink to={`/${project.slug}`} variant="primary">
          Open the project page
        </ButtonLink>
        <ButtonLink to="/maintain">Back to your projects</ButtonLink>
      </div>
    </>
  );
}

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

  return (
    <section className="page page--medium wizard">
      <header className="page__header">
        <h1>Register a project</h1>
        <p className="lede">
          Point this instance at a repository. It reads <code>agentfund.yaml</code> and the signed lock, shows you what
          it found, and creates nothing until you confirm.
        </p>
      </header>
      <StepList current={step} />

      {step === 0 && (
        <form className="wizard__panel" onSubmit={check}>
          <h2 ref={heading} tabIndex={-1}>
            Repository
          </h2>
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
          <div className="button-row">
            <Button type="submit" variant="primary" busy={preview.isPending} busyLabel="Reading the repository…">
              Check repository
            </Button>
          </div>
        </form>
      )}

      {step === 1 && preview.data && (
        <form className="wizard__panel" onSubmit={confirm} noValidate>
          <h2 ref={heading} tabIndex={-1}>
            Review <span className="mono wizard__repo">{repoUrl.replace(/^https?:\/\//, '')}</span>
          </h2>
          <Review preview={preview.data} />
          {preview.data.ok && (
            <div className="wizard__fields">
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
          )}
          <div className="button-row">
            {preview.data.ok && (
              <Button type="submit" variant="primary" busy={create.isPending} busyLabel="Creating…">
                Create project
              </Button>
            )}
            <Button
              onClick={() => {
                create.reset();
                preview.reset();
              }}
            >
              {preview.data.ok ? 'Use a different repository' : 'Back'}
            </Button>
          </div>
        </form>
      )}

      {step === 2 && create.data && (
        <div className="wizard__panel">
          <h2 ref={heading} tabIndex={-1}>
            Live
          </h2>
          <Done project={create.data} />
        </div>
      )}
    </section>
  );
}

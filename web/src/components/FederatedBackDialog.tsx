import { ArrowUpRight, UserRoundX } from 'lucide-react';
import { useMe, useMeta } from '@/api/queries';
import type { FederatedProject } from '@/api/types';
import { CLI_NAME } from '@/config';
import { federatedBackCommands, hostOf } from '@/lib/commands';
import { Button } from './Button';
import { CommandLine } from './CommandLine';
import { Dialog, DialogSection } from './Dialog';
import { describeError, Notice, Skeleton } from './States';

interface FederatedBackDialogProps {
  project: FederatedProject;
  onClose: () => void;
}

function OpenThere({ project, variant }: { project: FederatedProject; variant?: 'primary' | 'secondary' }) {
  return (
    <Button asChild variant={variant}>
      <a href={project.url} target="_blank" rel="noreferrer">
        Open on {project.instance.host}
        <ArrowUpRight strokeWidth={1.5} aria-hidden="true" />
      </a>
    </Button>
  );
}

/**
 * How to back a project that lives on a peer. When the peer accepts identities from this
 * instance: the two exact lines (sign in there through here, approve). When it does not: say
 * so plainly and point at the home instance.
 */
export function FederatedBackDialog({ project, onClose }: FederatedBackDialogProps) {
  const meta = useMeta();
  const me = useMe();
  const { instance } = project;
  const here = meta.data ? hostOf(meta.data.base_url) : null;

  return (
    <Dialog
      title={`Back ${project.name} on ${instance.host}`}
      subtitle={`This project is hosted by ${instance.name}. The work still runs on your machine, under your own Claude Code subscription; its tokens are counted on ${instance.host}.`}
      onClose={onClose}
    >
      {project.accepts_local_identities ? (
        <>
          <DialogSection title="Run these lines" id="federated-back-commands">
            <p className="text-sm text-pretty text-muted-foreground [&_code]:text-foreground">
              {instance.host} accepts accounts from this instance, so you do not need one there. Your worker signs in
              through {here ?? 'this instance'}
              {me.data && here ? (
                <>
                  {' '}
                  and you appear there as{' '}
                  <code>
                    {me.data.handle}@{here}
                  </code>
                </>
              ) : (
                <>
                  {' '}
                  and you appear there as <code>you@{here ?? 'this-instance'}</code>
                </>
              )}
              .
            </p>
            {meta.isPending ? (
              <Skeleton className="h-40" />
            ) : meta.isError ? (
              <Notice tone="strong" role="alert" title="Couldn't build the commands">
                {describeError(meta.error)}
              </Notice>
            ) : (
              <ol className="grid grid-cols-[minmax(0,1fr)]">
                {federatedBackCommands(meta.data, project).map((line, index, all) => (
                  <li key={line.command} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                    {index < all.length - 1 && <span aria-hidden="true" className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border" />}
                    <span aria-hidden="true" className="num relative flex size-6 items-center justify-center rounded-full border bg-card text-xs font-medium">
                      {index + 1}
                    </span>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
                      <p className="pt-0.5 text-sm font-medium">{line.label}</p>
                      <CommandLine command={line.command} label={line.label} />
                      {line.note && <p className="text-xs text-pretty text-muted-foreground">{line.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="text-sm text-pretty text-muted-foreground [&_code]:text-foreground">
              After that, <code>{CLI_NAME} dry-run</code> and <code>{CLI_NAME} work</code> take the same project URL as
              for a project here. Compare the key fingerprint <code>{CLI_NAME} approve</code> shows with the one on the
              project's page on {instance.host}.
            </p>
          </DialogSection>
          <DialogSection title="Where it counts" id="federated-back-counting">
            <p className="text-sm text-pretty text-muted-foreground">
              Tokens you deliver are recorded and ranked on {instance.host}, not here. Your profile on this instance
              lists them separately under “On other instances”, as {instance.host} reports them; they are never added
              to your totals or your rank here.
            </p>
            <div>
              <OpenThere project={project} />
            </div>
          </DialogSection>
        </>
      ) : (
        <DialogSection>
          <Notice tone="strong" icon={UserRoundX} title={`You need an account on ${instance.host}`}>
            <p>
              {instance.host} does not accept accounts from this instance, so your sign-in here cannot be used there.
              Create an account on {instance.host}, then use “Back with tokens” on the project's page: it shows the
              lines to run for that instance.
            </p>
          </Notice>
          <div>
            <OpenThere project={project} variant="primary" />
          </div>
        </DialogSection>
      )}
    </Dialog>
  );
}

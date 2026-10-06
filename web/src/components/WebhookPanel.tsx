import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Eye, EyeOff, Webhook } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { api, unwrap } from '@/api/client';
import { queryKeys, useMeta } from '@/api/queries';
import type { ProjectWebhook } from '@/api/types';
import { instanceLinks } from '@/lib/commands';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { describeError, ErrorState, Loading, Notice, SkeletonRows } from './States';

const SIGNATURE_HEADER = 'X-AgentFund-Signature: sha256=<hex HMAC-SHA256 of the raw body>';

/** One setting to paste into the CI provider: a name, a read-only value field and its controls. */
function Row({ name, note, children }: { name: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 py-3.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm font-medium sm:pt-1.5">{name}</dt>
      <dd className="grid min-w-0 gap-1.5">
        {children}
        {note && <p className="text-xs text-pretty text-muted-foreground">{note}</p>}
      </dd>
    </div>
  );
}

/** A read-only value set like an input, with its actions inside the right edge. */
function ValueField({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <span className="flex min-h-9 items-center gap-1 rounded-lg border border-input bg-background py-1 pr-1 pl-3 dark:bg-input/30">
      {children}
      <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>
    </span>
  );
}

const VALUE = 'num min-w-0 flex-1 text-[0.8125rem] break-all';

function Secret({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  const Icon = revealed ? EyeOff : Eye;
  return (
    <ValueField
      actions={
        <>
          <Button size="sm" variant="quiet" onClick={() => setRevealed((shown) => !shown)} aria-pressed={revealed}>
            <Icon strokeWidth={1.5} aria-hidden="true" />
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
          <CopyButton text={value} label="the webhook secret" />
        </>
      }
    >
      <code className={cn(VALUE, !revealed && 'tracking-widest text-muted-foreground')} aria-label={revealed ? undefined : 'Secret, hidden'}>
        {revealed ? value : '•'.repeat(24)}
      </code>
    </ValueField>
  );
}

function Rotate({ slug, onRotated }: { slug: string; onRotated: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const rotate = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/projects/{slug}/webhook/rotate', { params: { path: { slug } } })),
    onSuccess: (webhook) => {
      queryClient.setQueryData(queryKeys.webhook(slug), webhook);
      setConfirming(false);
      onRotated();
    },
  });

  if (!confirming) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="sm" onClick={() => setConfirming(true)}>
          Rotate secret
        </Button>
        {rotate.isSuccess && (
          <span role="status" className="text-xs text-muted-foreground">
            New secret issued. Update it in your CI settings now.
          </span>
        )}
      </div>
    );
  }
  return (
    <Notice tone="strong" title="Rotate the webhook secret?" role="alert">
      <p>
        The old secret stops working immediately. CI results signed with it are rejected until you paste the new one
        into your CI settings.
      </p>
      {rotate.isError && <p className="font-medium text-destructive">{describeError(rotate.error)}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          variant="primary"
          busy={rotate.isPending}
          busyLabel="Rotating…"
          // Confirming replaced the button that had focus; keep the keyboard user here.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onClick={() => rotate.mutate()}
        >
          Rotate now
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </Notice>
  );
}

function Setup({ slug, webhook }: { slug: string; webhook: ProjectWebhook }) {
  const meta = useMeta();
  const links = instanceLinks(meta.data);
  const docs = links.docsUrl ?? `${links.sourceUrl}/blob/main/spec/protocol.md`;
  // A fresh key makes the secret field forget "revealed" when the secret is replaced.
  const [generation, setGeneration] = useState(0);

  return (
    <div className="grid gap-4">
      {webhook.ci_poll && (
        <Notice>
          This instance also polls the CI provider for results, so the webhook is optional. Adding it makes delivery
          show up sooner.
        </Notice>
      )}
      {webhook.provider === 'github' ? (
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          In the repository on GitHub, open Settings → Webhooks → Add webhook and enter the values below. Add the hook
          only after the project exists here: GitHub pings a new hook straight away, and a ping for an unregistered
          repository is rejected.
        </p>
      ) : (
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          Have your CI send each result as signed JSON to the payload URL, with the header{' '}
          <code className="text-[0.8125rem] text-foreground">{SIGNATURE_HEADER}</code>, using the secret below as the HMAC key.{' '}
          <a href={docs} rel="noreferrer" className="link text-foreground">
            Payload format in the docs
          </a>
        </p>
      )}
      <dl className="divide-y border-y">
        <Row name="Payload URL">
          <ValueField actions={<CopyButton text={webhook.url} label="the payload URL" />}>
            <code className={VALUE}>{webhook.url}</code>
          </ValueField>
        </Row>
        <Row name="Content type">
          <ValueField actions={<CopyButton text={webhook.content_type} label="the content type" />}>
            <code className={VALUE}>{webhook.content_type}</code>
          </ValueField>
        </Row>
        <Row name="Secret" note="Signs CI results for this project only. Treat it like a password.">
          <Secret key={generation} value={webhook.secret} />
        </Row>
        {webhook.provider === 'github' && (
          <Row name="Events">
            {webhook.events.length > 0 ? (
              <>
                <p className="text-sm text-muted-foreground sm:pt-1.5">Choose “Let me select individual events” and tick:</p>
                <ul className="flex flex-wrap gap-1.5">
                  {webhook.events.map((event) => (
                    <li key={event} className="num rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs">
                      {event}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground sm:pt-1.5">The default push event is enough.</p>
            )}
          </Row>
        )}
      </dl>
      <Rotate slug={slug} onRotated={() => setGeneration((current) => current + 1)} />
    </div>
  );
}

interface WebhookPanelProps {
  slug: string;
  /** Start expanded (the wizard's last step); the dashboard keeps it collapsed. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * CI webhook setup for one project. The secret is only requested from the server when the
 * panel is opened, and stays masked until revealed.
 */
export function WebhookPanel({ slug, defaultOpen = false, className }: WebhookPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const webhook = useQuery({
    queryKey: queryKeys.webhook(slug),
    queryFn: () => unwrap(api.GET('/v1/projects/{slug}/webhook', { params: { path: { slug } } })),
    enabled: open,
    // A secret should not sit in the cache longer than the panel is in use.
    gcTime: 0,
    staleTime: 0,
  });

  return (
    <section className={cn('min-w-0', className)} aria-label={`CI webhook for ${slug}`}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((shown) => !shown)}
          className="group flex h-12 w-full items-center gap-2.5 px-5 text-left text-sm font-medium -outline-offset-2 transition-colors hover:bg-muted/40"
        >
          <Webhook className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          CI webhook
          <ChevronRight
            className="ml-auto size-4 text-muted-foreground transition-transform duration-200 group-aria-expanded:rotate-90"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </button>
      </h3>
      <div id={bodyId} className="border-t p-5" hidden={!open}>
        {!open ? null : webhook.isPending ? (
          <Loading label="webhook settings">
            <SkeletonRows rows={3} className="h-10" />
          </Loading>
        ) : webhook.isError ? (
          <ErrorState title="Couldn't load the webhook settings" error={webhook.error} onRetry={() => void webhook.refetch()} />
        ) : (
          <Setup slug={slug} webhook={webhook.data} />
        )}
      </div>
    </section>
  );
}

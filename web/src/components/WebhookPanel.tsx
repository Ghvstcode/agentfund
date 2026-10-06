import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api, unwrap } from '../api/client';
import { queryKeys, useMeta } from '../api/queries';
import type { ProjectWebhook } from '../api/types';
import { instanceLinks } from '../lib/commands';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { describeError, ErrorState, Loading, Notice, SkeletonRows } from './States';

const SIGNATURE_HEADER = 'X-AgentFund-Signature: sha256=<hex HMAC-SHA256 of the raw body>';

function Secret({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="key-line">
      <code className="key-line__value" aria-label={revealed ? undefined : 'Secret, hidden'}>
        {revealed ? value : '•'.repeat(24)}
      </code>
      <Button size="sm" onClick={() => setRevealed((shown) => !shown)} aria-pressed={revealed}>
        {revealed ? 'Hide' : 'Reveal'}
      </Button>
      <CopyButton text={value} label="the webhook secret" />
    </span>
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
      <div className="button-row">
        <Button size="sm" onClick={() => setConfirming(true)}>
          Rotate secret
        </Button>
        {rotate.isSuccess && (
          <span role="status" className="muted">
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
      {rotate.isError && <p>{describeError(rotate.error)}</p>}
      <div className="button-row">
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
    <>
      {webhook.ci_poll && (
        <Notice>
          This instance also polls the CI provider for results, so the webhook is optional. Adding it makes delivery
          show up sooner.
        </Notice>
      )}
      {webhook.provider === 'github' ? (
        <p>
          In the repository on GitHub, open Settings → Webhooks → Add webhook and enter the values below. Add the hook
          only after the project exists here: GitHub pings a new hook straight away, and a ping for an unregistered
          repository is rejected.
        </p>
      ) : (
        <p>
          Have your CI send each result as signed JSON to the payload URL, with the header{' '}
          <code>{SIGNATURE_HEADER}</code>, using the secret below as the HMAC key.{' '}
          <a href={docs} rel="noreferrer">
            Payload format in the docs
          </a>
        </p>
      )}
      <dl className="definitions definitions--wide">
        <dt>Payload URL</dt>
        <dd>
          <span className="key-line">
            <code className="key-line__value">{webhook.url}</code>
            <CopyButton text={webhook.url} label="the payload URL" />
          </span>
        </dd>
        <dt>Content type</dt>
        <dd>
          <span className="key-line">
            <code className="key-line__value">{webhook.content_type}</code>
            <CopyButton text={webhook.content_type} label="the content type" />
          </span>
        </dd>
        <dt>Secret</dt>
        <dd>
          <Secret key={generation} value={webhook.secret} />
          <p className="muted">Signs CI results for this project only. Treat it like a password.</p>
        </dd>
        {webhook.provider === 'github' && (
          <>
            <dt>Events</dt>
            <dd>
              {webhook.events.length > 0 ? (
                <>
                  Choose “Let me select individual events” and tick:
                  <ul className="glob-list mono">
                    {webhook.events.map((event) => (
                      <li key={event}>{event}</li>
                    ))}
                  </ul>
                </>
              ) : (
                'The default push event is enough.'
              )}
            </dd>
          </>
        )}
      </dl>
      <Rotate slug={slug} onRotated={() => setGeneration((current) => current + 1)} />
    </>
  );
}

interface WebhookPanelProps {
  slug: string;
  /** Start expanded (the wizard's last step); the dashboard keeps it collapsed. */
  defaultOpen?: boolean;
}

/**
 * CI webhook setup for one project. The secret is only requested from the server when the
 * panel is opened, and stays masked until revealed.
 */
export function WebhookPanel({ slug, defaultOpen = false }: WebhookPanelProps) {
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
    <section className="webhook" aria-label={`CI webhook for ${slug}`}>
      <h3 className="webhook__title">
        <button type="button" className="disclosure" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((shown) => !shown)}>
          <span className="disclosure__marker" aria-hidden="true" />
          CI webhook
        </button>
      </h3>
      <div id={bodyId} className="webhook__body" hidden={!open}>
        {!open ? null : webhook.isPending ? (
          <Loading label="webhook settings">
            <SkeletonRows rows={3} height="2.5rem" />
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

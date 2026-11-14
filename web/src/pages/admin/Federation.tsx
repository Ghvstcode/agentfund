import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, unwrap } from '@/api/client';
import { queryKeys, useAdminPeers, useFederationEnabled, useMeta } from '@/api/queries';
import type { Peer, PeerPreview, PeerUpdate } from '@/api/types';
import { Button } from '@/components/Button';
import { Dialog, DialogSection } from '@/components/Dialog';
import { TextField } from '@/components/Field';
import { Fingerprint } from '@/components/Fingerprint';
import { Hash } from '@/components/Hash';
import { InstanceBadge } from '@/components/InstanceBadge';
import { Num } from '@/components/Num';
import { describeError, EmptyState, ErrorState, Loading, Notice, Skeleton, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useKeyFingerprint } from '@/hooks/useKeyFingerprint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { hostOf } from '@/lib/commands';
import { shortHash } from '@/lib/format';
import { cn } from '@/lib/utils';
import { COLUMN, ConfirmDialog, RowError } from './shared';

/** What each of the two per-peer switches does, in the words used everywhere on this tab. */
const SWITCHES = {
  discover: {
    name: 'Discover',
    label: 'List its projects here',
    hint: 'Its projects appear on this instance’s Discover page, marked with its host and linking to their home.',
  },
  accept_identities: {
    name: 'Accept identities',
    label: 'Accept its donors',
    hint: 'Its donors can work on projects here without creating an account. They appear as handle@host, and its key vouches for who they are.',
  },
} as const;

type SwitchKey = keyof typeof SWITCHES;

const STATUS: Record<Peer['status'], { label: string; variant: 'outline' | 'secondary' | 'destructive' }> = {
  active: { label: 'Active', variant: 'outline' },
  paused: { label: 'Paused', variant: 'secondary' },
  key_mismatch: { label: 'Key changed', variant: 'destructive' },
};

function StatusBadge({ status }: { status: Peer['status'] }) {
  const { label, variant } = STATUS[status];
  return (
    <Badge variant={variant}>
      {status === 'key_mismatch' && <ShieldAlert strokeWidth={1.75} aria-hidden="true" />}
      {label}
    </Badge>
  );
}

/** Whether the peer accepts this instance's donors, as it last said. */
function AcceptsUs({ value }: { value: Peer['accepts_us'] }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1" title="Donors from this instance can work there without an account">
        <Check className="size-3.5 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
        Yes
      </span>
    );
  }
  return (
    <span className="text-muted-foreground" title={value === false ? 'Donors from this instance need an account there' : 'The peer has not said yet'}>
      {value === false ? 'No' : 'Not known'}
    </span>
  );
}

/** Mutations and confirm steps for one peer, shared by the table row and the narrow card. */
function usePeerControls(peer: Peer) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<'remove' | 'pin' | null>(null);
  const path = { params: { path: { host: peer.host } } };

  const store = (updated: Peer) => {
    queryClient.setQueryData<{ items: Peer[] }>(queryKeys.adminPeers, (current) =>
      current ? { items: current.items.map((item) => (item.host === updated.host ? updated : item)) } : current,
    );
    // What the public sees (the peer list, the projects on Discover) follows from this.
    void queryClient.invalidateQueries({ queryKey: queryKeys.federation });
  };

  const update = useMutation({
    mutationFn: (body: PeerUpdate) => unwrap(api.PATCH('/v1/admin/federation/peers/{host}', { ...path, body })),
    onSuccess: store,
  });
  const sync = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/admin/federation/peers/{host}/sync', path)),
    onSuccess: (updated) => {
      store(updated);
      if (updated.last_error) toast.error(`Sync with ${peer.host} failed`, { description: updated.last_error });
      else toast.success(`Synced with ${peer.host}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/admin/federation/peers/{host}', path)),
    onSuccess: () => {
      queryClient.setQueryData<{ items: Peer[] }>(queryKeys.adminPeers, (current) =>
        current ? { items: current.items.filter((item) => item.host !== peer.host) } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.federation });
      toast.success(`Stopped peering with ${peer.host}`);
    },
  });

  return {
    update,
    sync,
    remove,
    confirming,
    setConfirming,
    busy: update.isPending || sync.isPending || remove.isPending,
    error: update.error ?? sync.error ?? remove.error,
  };
}

type PeerControls = ReturnType<typeof usePeerControls>;

function PeerSwitch({ peer, controls, which }: { peer: Peer; controls: PeerControls; which: SwitchKey }) {
  const { name } = SWITCHES[which];
  return (
    <Switch
      aria-label={`${name}: ${peer.host}`}
      title={SWITCHES[which].hint}
      checked={peer[which]}
      // While the key is in question nothing is fetched or accepted, whatever the switches say.
      disabled={controls.busy || peer.status === 'key_mismatch'}
      onCheckedChange={(checked) => controls.update.mutate({ [which]: checked })}
    />
  );
}

function PeerMenu({ peer, controls }: { peer: Peer; controls: PeerControls }) {
  const { status } = peer;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${peer.host}`}
          disabled={controls.busy}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 aria-expanded:bg-muted aria-expanded:text-foreground"
        >
          {controls.busy ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <MoreHorizontal className="size-4" strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {status === 'key_mismatch' ? (
          <DropdownMenuItem disabled={!peer.observed_pubkey} onSelect={() => controls.setConfirming('pin')}>
            <KeyRound strokeWidth={1.5} aria-hidden="true" /> Pin new key…
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem disabled={status === 'paused'} onSelect={() => controls.sync.mutate()}>
              <RefreshCw strokeWidth={1.5} aria-hidden="true" /> Sync now
            </DropdownMenuItem>
            {status === 'active' ? (
              <DropdownMenuItem onSelect={() => controls.update.mutate({ status: 'paused' })}>
                <Pause strokeWidth={1.5} aria-hidden="true" /> Pause
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => controls.update.mutate({ status: 'active' })}>
                <Play strokeWidth={1.5} aria-hidden="true" /> Resume
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => controls.setConfirming('remove')}>
          <Trash2 strokeWidth={1.5} aria-hidden="true" /> Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The confirm steps of a peer's two consequential actions. Rendered once per peer. */
function PeerConfirmations({ peer, controls, observed }: { peer: Peer; controls: PeerControls; observed: string | null | undefined }) {
  if (controls.confirming === 'remove') {
    return (
      <ConfirmDialog
        title={`Stop peering with ${peer.host}?`}
        consequence={
          <>
            {peer.projects > 0
              ? `Its ${plural(peer.projects, 'project', 'projects')} cached here ${peer.projects === 1 ? 'leaves' : 'leave'} Discover. `
              : 'Its projects are no longer listed here. '}
            {peer.donors > 0
              ? `The ${plural(peer.donors, 'donor', 'donors')} who arrived from it ${peer.donors === 1 ? 'keeps' : 'keep'} their history and their place on the leaderboards, but can no longer sign in here. `
              : 'Its donors can no longer sign in here. '}
            The pinned key is forgotten; to peer again you compare its fingerprint again.
          </>
        }
        confirmLabel="Remove peer"
        onConfirm={() => controls.remove.mutate()}
        onClose={() => controls.setConfirming(null)}
      />
    );
  }
  if (controls.confirming === 'pin' && peer.observed_pubkey) {
    const pubkey = peer.observed_pubkey;
    return (
      <ConfirmDialog
        title={`Pin the new key of ${peer.host}?`}
        consequence={
          <>
            From now on this instance trusts only the key{' '}
            <span className="num text-foreground">{observed ? shortHash(observed, 16) : shortHash(pubkey, 16)}</span> for{' '}
            {peer.host}, and peering resumes with the switches as they are set. Go ahead only if its operator confirmed
            this fingerprint to you over another channel.
          </>
        }
        confirmLabel="Pin new key"
        onConfirm={() => controls.update.mutate({ pubkey })}
        onClose={() => controls.setConfirming(null)}
      />
    );
  }
  return null;
}

/**
 * A peer that now publishes a key other than the pinned one. This is either a routine key
 * rotation or someone answering in the peer's place, and only the admin can tell which, so it
 * gets its own block: what is suspended, both fingerprints in full, and the two ways out.
 */
function KeyMismatch({ peer, controls, observed }: { peer: Peer; controls: PeerControls; observed: string | null | undefined }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 whitespace-normal">
      <div className="flex gap-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" strokeWidth={1.5} aria-hidden="true" />
        <div className="grid min-w-0 gap-1.5">
          <h3 id={id} className="text-sm font-semibold tracking-tight">
            {peer.host} now publishes a different key
          </h3>
          <p className="max-w-prose text-sm text-pretty text-muted-foreground">
            Peering is suspended: nothing is fetched from it and none of its donors are accepted here. A key the
            operator rotated looks exactly like someone answering in their place. Ask the operator of {peer.host} for
            their current fingerprint over a channel you already trust, and pin the new key only if it matches.
          </p>
        </div>
      </div>
      <dl className="grid min-w-0 gap-3 xl:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <dt className="label">Pinned here</dt>
          <dd>
            <Fingerprint value={peer.pubkey_fingerprint} label={`the pinned key fingerprint of ${peer.host}`} className="bg-card" />
          </dd>
        </div>
        <div className="grid min-w-0 content-start gap-1.5">
          <dt className="label">Published by {peer.host} now</dt>
          <dd>
            {!peer.observed_pubkey ? (
              <p className="py-2 text-sm text-muted-foreground">Not reported. Sync again, or remove the peer.</p>
            ) : observed === undefined ? (
              <Skeleton className="h-[3.25rem] rounded-lg" />
            ) : (
              // Without a secure context the browser cannot hash; the key itself is still comparable.
              <Fingerprint value={observed ?? peer.observed_pubkey} label={`the new key ${observed ? 'fingerprint ' : ''}of ${peer.host}`} className="bg-card" />
            )}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" busy={controls.update.isPending} busyLabel="Pinning…" disabled={!peer.observed_pubkey} onClick={() => controls.setConfirming('pin')}>
          Pin new key
        </Button>
        <Button size="sm" busy={controls.remove.isPending} busyLabel="Removing…" onClick={() => controls.setConfirming('remove')}>
          Remove peer
        </Button>
      </div>
    </section>
  );
}

function SyncError({ peer }: { peer: Peer }) {
  if (!peer.last_error || peer.status === 'key_mismatch') return null;
  return (
    <p className="flex gap-2 text-xs whitespace-normal">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-destructive" strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-medium text-destructive">Last sync failed.</span>{' '}
        <span className="text-muted-foreground">{peer.last_error}</span>
      </span>
    </p>
  );
}

function PeerIdentity({ peer }: { peer: Peer }) {
  return (
    <>
      <span className="block truncate font-medium text-foreground">{peer.name}</span>
      <a href={peer.base_url} target="_blank" rel="noreferrer" className="num block truncate text-xs text-muted-foreground underline-offset-4 hover:underline">
        {peer.host}
      </a>
    </>
  );
}

const COLUMNS = 10;

/** One peer in the table. Its own `tbody`, so a second row (a sync error, a changed key) stays attached to it. */
function PeerRows({ peer }: { peer: Peer }) {
  const controls = usePeerControls(peer);
  // The server sends the fingerprint; computing it here only covers an older server.
  const computed = useKeyFingerprint(peer.status === 'key_mismatch' && !peer.observed_pubkey_fingerprint ? peer.observed_pubkey : null);
  const observed = peer.observed_pubkey_fingerprint ?? computed;
  const mismatch = peer.status === 'key_mismatch';
  const detail = mismatch || Boolean(peer.last_error) || Boolean(controls.error);
  return (
    <TableBody className="border-b transition-colors last:border-b-0 hover:bg-muted/40">
      <TableRow className="border-0 hover:bg-transparent">
        <TableHead scope="row" className="h-auto w-full max-w-0 py-2.5 pl-5 font-normal">
          <PeerIdentity peer={peer} />
        </TableHead>
        <TableCell>
          <Hash value={peer.pubkey_fingerprint} label={`pinned key fingerprint of ${peer.host}`} length={8} />
        </TableCell>
        <TableCell>
          <StatusBadge status={peer.status} />
        </TableCell>
        <TableCell>
          <PeerSwitch peer={peer} controls={controls} which="discover" />
        </TableCell>
        <TableCell>
          <PeerSwitch peer={peer} controls={controls} which="accept_identities" />
        </TableCell>
        <TableCell>
          <AcceptsUs value={peer.accepts_us} />
        </TableCell>
        <TableCell className="text-right">
          <Num value={peer.projects} unit="projects cached here" />
        </TableCell>
        <TableCell className="text-right">
          <Num value={peer.donors} unit="donors here whose home it is" />
        </TableCell>
        <TableCell className="text-muted-foreground">{peer.last_synced_at ? <Time value={peer.last_synced_at} /> : 'Never'}</TableCell>
        <TableCell className="pr-5 text-right">
          <PeerMenu peer={peer} controls={controls} />
          <PeerConfirmations peer={peer} controls={controls} observed={observed} />
        </TableCell>
      </TableRow>
      {detail && (
        <TableRow className="border-0 hover:bg-transparent">
          <TableCell colSpan={COLUMNS} className="px-5 pt-0.5 pb-3.5 whitespace-normal">
            <div className="grid gap-2">
              {mismatch && <KeyMismatch peer={peer} controls={controls} observed={observed} />}
              <SyncError peer={peer} />
              {controls.error ? <RowError error={controls.error} /> : null}
            </div>
          </TableCell>
        </TableRow>
      )}
    </TableBody>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <dt className="label">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** The same peer for narrow screens, where ten columns cannot be a table. */
function PeerCard({ peer }: { peer: Peer }) {
  const controls = usePeerControls(peer);
  // The server sends the fingerprint; computing it here only covers an older server.
  const computed = useKeyFingerprint(peer.status === 'key_mismatch' && !peer.observed_pubkey_fingerprint ? peer.observed_pubkey : null);
  const observed = peer.observed_pubkey_fingerprint ?? computed;
  return (
    <li className="surface grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <PeerIdentity peer={peer} />
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <StatusBadge status={peer.status} />
          <PeerMenu peer={peer} controls={controls} />
        </span>
      </div>
      {peer.status === 'key_mismatch' && <KeyMismatch peer={peer} controls={controls} observed={observed} />}
      <div className="grid divide-y border-y">
        {(Object.keys(SWITCHES) as SwitchKey[]).map((which) => (
          <div key={which} className="flex items-center justify-between gap-4 py-2.5">
            {/* The switch names itself for assistive tech; this is its visible caption. */}
            <p className="grid gap-0.5" aria-hidden="true">
              <span className="text-sm font-medium">{SWITCHES[which].name}</span>
              <span className="text-xs text-muted-foreground">{SWITCHES[which].label}</span>
            </p>
            <PeerSwitch peer={peer} controls={controls} which={which} />
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label="Pinned key">
          <Hash value={peer.pubkey_fingerprint} label={`pinned key fingerprint of ${peer.host}`} length={8} />
        </Fact>
        <Fact label="Accepts us">
          <AcceptsUs value={peer.accepts_us} />
        </Fact>
        <Fact label="Projects">
          <Num value={peer.projects} unit="projects cached here" />
        </Fact>
        <Fact label="Donors">
          <Num value={peer.donors} unit="donors here whose home it is" />
        </Fact>
        <Fact label="Last synced">
          <span className="text-muted-foreground">{peer.last_synced_at ? <Time value={peer.last_synced_at} /> : 'Never'}</span>
        </Fact>
      </dl>
      <SyncError peer={peer} />
      {controls.error ? <RowError error={controls.error} /> : null}
      <PeerConfirmations peer={peer} controls={controls} observed={observed} />
    </li>
  );
}

function PeerTable({ peers }: { peers: Peer[] }) {
  return (
    <div className="surface overflow-hidden">
      <Table aria-label="Peers">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={`${COLUMN} pl-5`}>
              Peer
            </TableHead>
            <TableHead scope="col" className={COLUMN}>
              Pinned key
            </TableHead>
            <TableHead scope="col" className={COLUMN}>
              Status
            </TableHead>
            <TableHead scope="col" className={COLUMN} title={SWITCHES.discover.hint}>
              Discover
            </TableHead>
            <TableHead scope="col" className={COLUMN} title={SWITCHES.accept_identities.hint}>
              Accept identities
            </TableHead>
            <TableHead scope="col" className={COLUMN} title="Whether the peer accepts this instance's donors, as it last said">
              Accepts us
            </TableHead>
            <TableHead scope="col" className={`${COLUMN} text-right`}>
              Projects
            </TableHead>
            <TableHead scope="col" className={`${COLUMN} text-right`}>
              Donors
            </TableHead>
            <TableHead scope="col" className={COLUMN}>
              Synced
            </TableHead>
            <TableHead scope="col" className={`${COLUMN} pr-5`}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        {peers.map((peer) => (
          <PeerRows key={peer.host} peer={peer} />
        ))}
      </Table>
    </div>
  );
}

/** A switch with its consequence spelled out under the label. */
function TrustSwitch({ which, checked, onChange }: { which: SwitchKey; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="grid min-w-0 gap-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {SWITCHES[which].name}
        </Label>
        <p id={`${id}-hint`} className="text-xs text-pretty text-muted-foreground">
          {SWITCHES[which].hint}
        </p>
      </div>
      <Switch id={id} aria-describedby={`${id}-hint`} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

/** `fund.example.org` is what people type; the API wants a URL. */
function normalizeUrl(text: string): string {
  const trimmed = text.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function previewProblem(error: unknown): string {
  if (error instanceof ApiError && error.code === 'peer-unverifiable') {
    return error.problem?.detail ?? 'It could not be reached, or it does not answer as an AgentFund instance.';
  }
  return describeError(error);
}

function createProblem(error: unknown, host: string): { title: string; body: string } {
  if (error instanceof ApiError && error.code === 'peer-exists') {
    return { title: `${host} is already a peer`, body: 'Change what it is trusted for from the list instead.' };
  }
  if (error instanceof ApiError && error.code === 'peer-unverifiable') {
    return {
      title: 'The key could not be confirmed',
      body:
        error.problem?.detail ??
        `${host} did not answer, or it now publishes a different key than the one shown above. Nothing was saved. Look it up again.`,
    };
  }
  return { title: 'The peer was not added', body: describeError(error) };
}

const FOOTER = 'flex flex-col-reverse gap-2 bg-muted/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-end';

/**
 * Peering in two steps. First ask the instance who it is; nothing is saved. Then show its key
 * fingerprint for the admin to compare out of band, and only on their say-so pin it, together
 * with what the peer is trusted for.
 */
export function AddPeerDialog({ peers, onClose }: { peers: Peer[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [discover, setDiscover] = useState(true);
  const [acceptIdentities, setAcceptIdentities] = useState(false);

  const lookup = useMutation({
    mutationFn: (baseUrl: string) => unwrap(api.POST('/v1/admin/federation/peers/preview', { body: { base_url: baseUrl } })),
  });
  const create = useMutation({
    mutationFn: (preview: PeerPreview) =>
      unwrap(
        api.POST('/v1/admin/federation/peers', {
          body: { base_url: preview.base_url, pubkey: preview.pubkey, discover, accept_identities: acceptIdentities },
        }),
      ),
    onSuccess: (peer) => {
      queryClient.setQueryData<{ items: Peer[] }>(queryKeys.adminPeers, (current) =>
        current ? { items: [...current.items.filter((item) => item.host !== peer.host), peer] } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminPeers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.federation });
      toast.success(`Peered with ${peer.host}`);
      onClose();
    },
  });

  const preview = lookup.data;
  const submitUrl = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim()) lookup.mutate(normalizeUrl(url));
  };
  const back = () => {
    lookup.reset();
    create.reset();
  };

  if (!preview) {
    return (
      <Dialog title="Add a peer" subtitle="Step 1 of 2 · Find the instance" onClose={onClose}>
        <form onSubmit={submitUrl} noValidate>
          <DialogSection>
            <TextField
              label="Instance URL"
              mono
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://fund.example.org"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                if (lookup.isError) lookup.reset();
              }}
              hint="The address its operator gave you. This only asks the instance who it is; nothing is saved yet."
              error={lookup.isError ? previewProblem(lookup.error) : null}
            />
          </DialogSection>
          <div className={FOOTER}>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={lookup.isPending} busyLabel="Looking it up…" disabled={!url.trim()}>
              Look up instance
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  const known = peers.some((peer) => peer.host === preview.host);
  const blocked = known || !preview.federation;
  const problem = create.isError ? createProblem(create.error, preview.host) : null;

  return (
    <Dialog title={`Add ${preview.host} as a peer`} subtitle="Step 2 of 2 · Confirm its key" onClose={onClose}>
      <DialogSection>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="grid min-w-0 gap-0.5">
            <p className="truncate text-[0.9375rem] font-semibold tracking-tight">{preview.name}</p>
            {preview.description && <p className="text-sm text-pretty text-muted-foreground">{preview.description}</p>}
          </div>
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <InstanceBadge instance={preview} />
            {preview.version && <span className="num shrink-0 whitespace-nowrap">v{preview.version.replace(/^v/, '')}</span>}
          </p>
        </div>
        {!preview.federation && (
          <Notice tone="strong" role="alert" title={`${preview.host} has federation turned off`}>
            It answers as an AgentFund instance but does not serve the federation operations, so there is nothing to
            peer with yet. Its operator has to turn federation on first.
          </Notice>
        )}
        {known && (
          <Notice tone="strong" role="alert" title={`${preview.host} is already a peer`}>
            Change what it is trusted for from the list instead.
          </Notice>
        )}
      </DialogSection>

      {!blocked && (
        <>
          <DialogSection title="Compare its key fingerprint" id="add-peer-key">
            <Fingerprint value={preview.pubkey_fingerprint} label={`the key fingerprint of ${preview.host}`} />
            <p className="text-sm text-pretty text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
              This is the key {preview.host} published just now. <strong>Before you continue, compare all of it</strong>{' '}
              with the fingerprint its operator gives you over a channel you already trust: a call, a signed message,
              in person. Theirs is on their Admin → Federation page. If the two differ, stop: something other than
              their instance answered.
            </p>
            <p className="text-sm text-pretty text-muted-foreground">
              Adding the peer pins this key. If {preview.host} ever publishes another one, peering stops until you
              confirm the new key.
            </p>
          </DialogSection>
          <DialogSection title="What to trust it for" id="add-peer-trust">
            <div className="grid divide-y">
              <TrustSwitch which="discover" checked={discover} onChange={setDiscover} />
              <TrustSwitch which="accept_identities" checked={acceptIdentities} onChange={setAcceptIdentities} />
            </div>
            <p className="text-xs text-muted-foreground">Both can be changed later, per peer.</p>
          </DialogSection>
        </>
      )}

      {problem && (
        <div className="border-b p-5">
          <Notice tone="strong" role="alert" title={problem.title}>
            {problem.body}
          </Notice>
        </div>
      )}
      <div className={FOOTER}>
        <Button onClick={back} className="sm:mr-auto">
          <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
          Another instance
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        {!blocked && (
          <Button variant="primary" busy={create.isPending} busyLabel="Adding…" onClick={() => create.mutate(preview)}>
            The fingerprints match, add peer
          </Button>
        )}
      </div>
    </Dialog>
  );
}

/** What peers see when they look this instance up, so its operator can read it out to them. */
function OwnKey() {
  const meta = useMeta();
  const computed = useKeyFingerprint(meta.data?.instance_pubkey_fingerprint ? null : meta.data?.instance_pubkey);
  const fingerprint = meta.data?.instance_pubkey_fingerprint ?? computed;
  if (!meta.data?.instance_pubkey) return null;
  const host = hostOf(meta.data.base_url);
  return (
    <aside aria-label="This instance's key" className="surface grid min-w-0 gap-x-8 gap-y-3 p-5 md:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="grid content-start gap-1">
        <p className="text-sm font-semibold tracking-tight">This instance's key</p>
        <p className="text-xs text-pretty text-muted-foreground">
          An operator who adds {host} as a peer is shown this fingerprint and asked to confirm it with you. Give it to
          them over a channel they already trust.
        </p>
      </div>
      <div className="grid min-w-0 content-start">
        {fingerprint === undefined ? (
          <Skeleton className="h-[3.25rem] rounded-lg" />
        ) : (
          <Fingerprint value={fingerprint ?? meta.data.instance_pubkey} label={`this instance's key ${fingerprint ? 'fingerprint' : ''}`.trim()} />
        )}
      </div>
    </aside>
  );
}

function Explainer() {
  return (
    <>
      <p>
        Peering connects this instance to another AgentFund instance. You compare the other instance's key fingerprint
        with its operator once, the key is pinned here, and from then on two independent switches say what the peer is
        trusted for:
      </p>
      <dl className="grid gap-2.5">
        {(Object.keys(SWITCHES) as SwitchKey[]).map((which) => (
          <div key={which} className="grid gap-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-3">
            <dt className="font-medium text-foreground">{SWITCHES[which].name}</dt>
            <dd>{SWITCHES[which].hint}</dd>
          </div>
        ))}
      </dl>
      <p>
        What donors from here did on a peer is shown on their profile, apart from their numbers here: every total and
        every rank on this instance counts only work this instance verified itself.
      </p>
    </>
  );
}

/** Admin → Federation: the peers of this instance, and what each is trusted for. */
export function Federation() {
  const enabled = useFederationEnabled();
  const meta = useMeta();
  const query = useAdminPeers();
  const [adding, setAdding] = useState(false);
  // Ten columns need room to show a host in full; below that each peer is a card with the same controls.
  const wide = useMediaQuery('(min-width: 80rem)');
  const peers = query.data?.items ?? [];
  const add = (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus strokeWidth={1.75} aria-hidden="true" />
      Add peer
    </Button>
  );

  if (meta.isSuccess && !enabled) {
    return (
      <section aria-labelledby="admin-federation">
        <h2 id="admin-federation" className="sr-only">
          Federation
        </h2>
        <EmptyState title="Federation is turned off" icon={Network}>
          <p>
            This instance does not peer with others. An operator turns it on in the server's environment (
            <code className="text-foreground">FEDERATION=true</code>).
          </p>
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="grid min-w-0 gap-6" aria-labelledby="admin-federation">
      <h2 id="admin-federation" className="sr-only">
        Federation
      </h2>
      {query.isPending ? (
        <Loading label="peers">
          <SkeletonRows rows={3} className="h-14" />
        </Loading>
      ) : query.isError ? (
        <ErrorState title="Couldn't load peers" error={query.error} onRetry={() => void query.refetch()} />
      ) : peers.length === 0 ? (
        <EmptyState title="No peers yet" icon={Network} action={add}>
          <Explainer />
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <p className="max-w-prose text-sm text-pretty text-muted-foreground">
              Instances this one peers with. <span className="font-medium text-foreground">Discover</span> lists a peer's
              projects here; <span className="font-medium text-foreground">Accept identities</span> lets its donors work
              here without an account. The two are independent.
            </p>
            {add}
          </div>
          {wide ? (
            <PeerTable peers={peers} />
          ) : (
            <ul aria-label="Peers" className={cn('grid items-start gap-4', peers.length > 1 && 'md:grid-cols-2')}>
              {peers.map((peer) => (
                <PeerCard key={peer.host} peer={peer} />
              ))}
            </ul>
          )}
        </>
      )}
      {query.isSuccess && <OwnKey />}
      {adding && <AddPeerDialog peers={peers} onClose={() => setAdding(false)} />}
    </section>
  );
}

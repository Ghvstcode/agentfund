import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Peer } from '../../api/types';
import { keyFingerprint } from '../../lib/fingerprint';
import { session } from '../../lib/session';
import { FEDERATION_META, federationRoutes, META, mockApi, PEER_PREVIEW, PEERS, reply } from '../../test/mockApi';
import { renderApp } from '../../test/render';
import { Federation } from './Federation';

type Routes = Parameters<typeof mockApi>[0];

function setup(extra: Routes = {}, peers: Peer[] = PEERS) {
  const spy = mockApi({ 'GET /v1/meta': () => FEDERATION_META, ...federationRoutes({ peers }), ...extra });
  const user = userEvent.setup();
  renderApp(<Federation />);
  return { spy, user };
}

/** Requests made with a method and path, with their JSON bodies. */
async function calls(spy: ReturnType<typeof mockApi>, method: string, pathname: string) {
  const matching = spy.mock.calls
    .map(([request]) => request as Request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
  return Promise.all(matching.map((request) => request.clone().json().catch(() => null) as Promise<unknown>));
}

const HACKERSPACE = PEERS.find((peer) => peer.status === 'key_mismatch') as Peer;
const HACKERSPACE_PATH = '/v1/admin/federation/peers/lab.hackerspace.example%3A8443';

describe('Admin federation', () => {
  beforeEach(() => {
    session.setToken('afs_admin');
    // The table is the wide layout; jsdom has no matchMedia of its own.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists peers with what each is trusted for and how the last sync went', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Peers' });
    const nordic = within(within(table).getByRole('rowheader', { name: /Nordic OSS Fund/ }).closest('tr') as HTMLElement);
    expect(nordic.getByText('Active')).toBeInTheDocument();
    expect(nordic.getByRole('switch', { name: 'Discover: fund.nordic-oss.example' })).toBeChecked();
    expect(nordic.getByRole('switch', { name: 'Accept identities: fund.nordic-oss.example' })).toBeChecked();
    expect(nordic.getByText('Yes')).toBeInTheDocument();
    expect(nordic.getByRole('button', { name: /Copy pinned key fingerprint/ })).toHaveAttribute('title', expect.stringContaining(PEERS[0]?.pubkey_fingerprint ?? ''));

    const libre = within(table).getByRole('rowheader', { name: /Libre Science Compute/ }).closest('tbody') as HTMLElement;
    expect(within(libre).getByRole('switch', { name: 'Accept identities: tokens.libre-science.example' })).not.toBeChecked();
    expect(within(libre).getByText('No')).toBeInTheDocument();
    expect(within(libre).getByText(/Last sync failed\./)).toBeInTheDocument();
    expect(within(libre).getByText(/503 Service Unavailable/)).toBeInTheDocument();
  });

  it('changes one switch with one PATCH', async () => {
    const { spy, user } = setup();
    const toggle = await screen.findByRole('switch', { name: 'Accept identities: tokens.libre-science.example' });
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(await calls(spy, 'PATCH', '/v1/admin/federation/peers/tokens.libre-science.example')).toEqual([{ accept_identities: true }]);
  });

  it('shows the same controls as cards on a narrow screen', async () => {
    vi.stubGlobal('matchMedia', undefined);
    setup();
    const list = await screen.findByRole('list', { name: 'Peers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('table', { name: 'Peers' })).not.toBeInTheDocument();
    expect(within(list).getByRole('switch', { name: 'Discover: fund.nordic-oss.example' })).toBeChecked();
  });

  describe('a peer whose key changed', () => {
    it('shows pinned and observed fingerprints and suspends the switches', async () => {
      setup();
      const block = (await screen.findByRole('heading', { name: 'lab.hackerspace.example:8443 now publishes a different key' })).closest('section') as HTMLElement;
      expect(within(block).getByText(/nothing is fetched from it and none of its donors are accepted here/)).toBeInTheDocument();

      const pinned = within(block).getByText('Pinned here').parentElement as HTMLElement;
      expect(pinned).toHaveTextContent(HACKERSPACE.pubkey_fingerprint);
      const observed = (await keyFingerprint(HACKERSPACE.observed_pubkey ?? '')) as string;
      expect(observed).toMatch(/^SHA256:[0-9a-f]{64}$/);
      const published = within(block).getByText('Published by lab.hackerspace.example:8443 now').parentElement as HTMLElement;
      await waitFor(() => expect(published).toHaveTextContent(observed));

      expect(screen.getByText('Key changed')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Discover: lab.hackerspace.example:8443' })).toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Accept identities: lab.hackerspace.example:8443' })).toBeDisabled();
    });

    it('pins the observed key only after a confirmation that names it', async () => {
      const { spy, user } = setup();
      await user.click(await screen.findByRole('button', { name: 'Pin new key' }));
      const confirm = await screen.findByRole('dialog', { name: 'Pin the new key of lab.hackerspace.example:8443?' });
      expect(confirm).toHaveTextContent(/only if its operator confirmed this fingerprint/);
      expect(await calls(spy, 'PATCH', HACKERSPACE_PATH)).toHaveLength(0);

      await user.click(within(confirm).getByRole('button', { name: 'Pin new key' }));
      await waitFor(() => expect(screen.queryByText('Key changed')).not.toBeInTheDocument());
      expect(await calls(spy, 'PATCH', HACKERSPACE_PATH)).toEqual([{ pubkey: HACKERSPACE.observed_pubkey }]);
      expect(screen.queryByRole('heading', { name: /now publishes a different key/ })).not.toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Discover: lab.hackerspace.example:8443' })).toBeEnabled();
    });

    it('removes the peer after stating what that costs', async () => {
      const { spy, user } = setup();
      await user.click(await screen.findByRole('button', { name: 'Remove peer' }));
      const confirm = await screen.findByRole('dialog', { name: 'Stop peering with lab.hackerspace.example:8443?' });
      expect(confirm).toHaveTextContent('Its 2 projects cached here leave Discover.');
      expect(confirm).toHaveTextContent('The 1 donor who arrived from it keeps their history');
      await user.click(within(confirm).getByRole('button', { name: 'Remove peer' }));
      await waitFor(() => expect(screen.queryByRole('rowheader', { name: /Hackerspace Lab/ })).not.toBeInTheDocument());
      expect(await calls(spy, 'DELETE', HACKERSPACE_PATH)).toHaveLength(1);
    });
  });

  describe('adding a peer', () => {
    async function lookUp(user: ReturnType<typeof userEvent.setup>, url: string) {
      await user.click(await screen.findByRole('button', { name: 'Add peer' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add a peer' });
      await user.type(within(dialog).getByLabelText('Instance URL'), url);
      await user.click(within(dialog).getByRole('button', { name: 'Look up instance' }));
    }

    it('previews the instance, then pins the previewed key with discover on and identities off', async () => {
      const { spy, user } = setup();
      await lookUp(user, 'fund.rustbridge.example');

      const dialog = await screen.findByRole('dialog', { name: 'Add fund.rustbridge.example as a peer' });
      expect(await calls(spy, 'POST', '/v1/admin/federation/peers/preview')).toEqual([{ base_url: 'https://fund.rustbridge.example' }]);
      expect(await calls(spy, 'POST', '/v1/admin/federation/peers')).toHaveLength(0);
      expect(within(dialog).getByText('Rustbridge Fund')).toBeInTheDocument();
      expect(within(dialog).getByText('v0.4.2')).toBeInTheDocument();
      expect(dialog).toHaveTextContent(PEER_PREVIEW.pubkey_fingerprint);
      expect(dialog).toHaveTextContent(/compare all of it with the fingerprint its operator gives you over a channel you already trust/);
      expect(within(dialog).getByRole('switch', { name: 'Discover' })).toBeChecked();
      expect(within(dialog).getByRole('switch', { name: 'Accept identities' })).not.toBeChecked();

      await user.click(within(dialog).getByRole('button', { name: 'The fingerprints match, add peer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await calls(spy, 'POST', '/v1/admin/federation/peers')).toEqual([
        { base_url: 'https://fund.rustbridge.example', pubkey: PEER_PREVIEW.pubkey, discover: true, accept_identities: false },
      ]);
      expect(await screen.findByRole('rowheader', { name: /Rustbridge Fund/ })).toBeInTheDocument();
    });

    it('sends the switches as the admin set them', async () => {
      const { spy, user } = setup();
      await lookUp(user, 'https://fund.rustbridge.example/');
      const dialog = await screen.findByRole('dialog', { name: 'Add fund.rustbridge.example as a peer' });
      await user.click(within(dialog).getByRole('switch', { name: 'Discover' }));
      await user.click(within(dialog).getByRole('switch', { name: 'Accept identities' }));
      await user.click(within(dialog).getByRole('button', { name: 'The fingerprints match, add peer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await calls(spy, 'POST', '/v1/admin/federation/peers')).toMatchObject([{ discover: false, accept_identities: true }]);
    });

    it('stays on the first step when the instance cannot be verified', async () => {
      const { user } = setup();
      await lookUp(user, 'https://unreachable.example');
      const dialog = screen.getByRole('dialog', { name: 'Add a peer' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('unreachable.example did not answer GET /v1/meta within 10 seconds.');
      expect(within(dialog).getByLabelText('Instance URL')).toBeInvalid();
    });

    it('offers nothing to confirm for an instance with federation off', async () => {
      const { user } = setup();
      await lookUp(user, 'https://legacy.example');
      const dialog = await screen.findByRole('dialog', { name: 'Add legacy.example as a peer' });
      expect(within(dialog).getByText('legacy.example has federation turned off')).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: /add peer/ })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('switch')).not.toBeInTheDocument();
    });

    it('says so when the key changed between preview and confirm, and saves nothing', async () => {
      const { user } = setup({
        'POST /v1/admin/federation/peers': () =>
          reply(422, { type: 'http://api.test/problems/peer-unverifiable', title: 'The instance could not be verified', status: 422 }),
      });
      await lookUp(user, 'https://fund.rustbridge.example');
      const dialog = await screen.findByRole('dialog', { name: 'Add fund.rustbridge.example as a peer' });
      await user.click(within(dialog).getByRole('button', { name: 'The fingerprints match, add peer' }));
      expect(await within(dialog).findByText('The key could not be confirmed')).toBeInTheDocument();
      expect(dialog).toHaveTextContent(/Nothing was saved\. Look it up again\./);
    });

    it('lets the admin go back and look up another instance', async () => {
      const { user } = setup();
      await lookUp(user, 'https://fund.rustbridge.example');
      const dialog = await screen.findByRole('dialog', { name: 'Add fund.rustbridge.example as a peer' });
      await user.click(within(dialog).getByRole('button', { name: 'Another instance' }));
      expect(await screen.findByRole('dialog', { name: 'Add a peer' })).toBeInTheDocument();
    });
  });

  it('explains peering and its two switches when there are no peers', async () => {
    setup({}, []);
    expect(await screen.findByText('No peers yet')).toBeInTheDocument();
    expect(screen.getByText('Discover')).toBeInTheDocument();
    expect(screen.getByText('Accept identities')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add peer' })).toBeInTheDocument();
  });

  it('says federation is off instead of asking for peers', async () => {
    const spy = mockApi({ 'GET /v1/meta': () => META });
    renderApp(<Federation />);
    expect(await screen.findByText('Federation is turned off')).toBeInTheDocument();
    expect(spy.mock.calls.map(([request]) => new URL((request as Request).url).pathname)).not.toContain('/v1/admin/federation/peers');
  });
});

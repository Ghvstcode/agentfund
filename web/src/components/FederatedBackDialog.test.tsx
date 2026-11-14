import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FederatedProject } from '../api/types';
import { session } from '../lib/session';
import { FEDERATED_PROJECTS, FEDERATION_META, mockApi } from '../test/mockApi';
import { renderApp } from '../test/render';
import { FederatedBackDialog } from './FederatedBackDialog';
import { FederatedProjectCard } from './FederatedProjectCard';

const ACCEPTED = FEDERATED_PROJECTS.find((project) => project.slug === 'fjord-db') as FederatedProject;
const NOT_ACCEPTED = FEDERATED_PROJECTS.find((project) => project.slug === 'openspectra') as FederatedProject;

describe('FederatedProjectCard', () => {
  it('reads as remote: host badge, a link that leaves in a new tab, and its own back control', async () => {
    const onBack = vi.fn();
    renderApp(<FederatedProjectCard project={ACCEPTED} onBack={onBack} />);
    expect(screen.getByText('fund.nordic-oss.example')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /fjord-db on fund\.nordic-oss\.example \(opens in a new tab\)/ });
    expect(link).toHaveAttribute('href', 'https://fund.nordic-oss.example/fjord-db');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('img', { name: /170M delivered of a 240M token goal/ })).toBeInTheDocument();
    // No trend line: the ledger is not on this instance.
    expect(screen.queryByRole('img', { name: /Delivery over the last/ })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'How to back fjord-db on fund.nordic-oss.example' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe('FederatedBackDialog', () => {
  beforeEach(() => {
    session.clear();
    mockApi({ 'GET /v1/meta': () => FEDERATION_META });
  });

  it('shows the two exact lines when the peer accepts this instance’s donors', async () => {
    renderApp(<FederatedBackDialog project={ACCEPTED} onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Back fjord-db on fund.nordic-oss.example' });
    const commands = await waitFor(() => {
      const found = within(dialog).getAllByText(/^agentfund /, { selector: 'pre code' });
      expect(found).toHaveLength(2);
      return found.map((node) => node.textContent);
    });
    expect(commands).toEqual([
      'agentfund login https://fund.nordic-oss.example --via https://fund.example',
      'agentfund approve https://fund.nordic-oss.example/fjord-db',
    ]);
    expect(within(dialog).getByText(/never added to your totals or your rank here/)).toBeInTheDocument();
  });

  it('copies the federated login line', async () => {
    const user = userEvent.setup();
    renderApp(<FederatedBackDialog project={ACCEPTED} onClose={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: /Copy the command: Sign in to fund\.nordic-oss\.example/ }));
    expect(await navigator.clipboard.readText()).toBe('agentfund login https://fund.nordic-oss.example --via https://fund.example');
  });

  it('tells a signed-in donor the handle they will have there', async () => {
    session.setToken('afs_test');
    mockApi({
      'GET /v1/meta': () => FEDERATION_META,
      'GET /v1/me': () => ({ id: 'https://fund.example/u/ada', handle: 'ada', role: 'donor', created_at: '2026-01-01T00:00:00Z' }),
    });
    renderApp(<FederatedBackDialog project={ACCEPTED} onClose={() => undefined} />);
    expect(await screen.findByText('ada@fund.example')).toBeInTheDocument();
  });

  it('says plainly that an account there is needed when the peer does not accept us', async () => {
    renderApp(<FederatedBackDialog project={NOT_ACCEPTED} onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Back openspectra on tokens.libre-science.example' });
    expect(within(dialog).getByText('You need an account on tokens.libre-science.example')).toBeInTheDocument();
    expect(within(dialog).queryByText(/--via/)).not.toBeInTheDocument();
    expect(dialog.querySelector('pre')).toBeNull();
    expect(within(dialog).getByRole('link', { name: /Open on tokens\.libre-science\.example/ })).toHaveAttribute(
      'href',
      'https://tokens.libre-science.example/openspectra',
    );
  });
});

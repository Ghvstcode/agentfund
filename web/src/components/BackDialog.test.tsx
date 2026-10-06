import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../api/types';
import { INSTALL_COMMAND } from '../config';
import { session } from '../lib/session';
import { META, mockApi } from '../test/mockApi';
import { renderApp } from '../test/render';
import { BackDialog } from './BackDialog';

const PROJECT = {
  slug: 'gridrs',
  name: 'gridrs',
  pubkey_fingerprint: 'SHA256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
} as Project;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div id="root">
      <button type="button" onClick={() => setOpen(true)}>
        Back with tokens
      </button>
      {open && <BackDialog project={PROJECT} onClose={() => setOpen(false)} />}
    </div>
  );
}

async function openDialog() {
  const user = userEvent.setup();
  renderApp(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Back with tokens' }));
  const dialog = await screen.findByRole('dialog', { name: 'Back gridrs with tokens' });
  return { user, dialog };
}

describe('BackDialog', () => {
  beforeEach(() => {
    session.clear();
    mockApi({ 'GET /v1/meta': () => META });
  });

  it('builds the exact CLI lines from the instance base URL', async () => {
    const { dialog } = await openDialog();
    const commands = await waitFor(() => {
      const found = within(dialog).getAllByText(/^(curl|agentfund) /, { selector: 'pre code' });
      expect(found).toHaveLength(4);
      return found.map((node) => node.textContent);
    });
    expect(commands).toEqual([
      INSTALL_COMMAND,
      'agentfund login https://fund.example',
      'agentfund approve https://fund.example/gridrs',
      'agentfund work https://fund.example/gridrs --budget 200m',
    ]);
  });

  it('copies a command to the clipboard', async () => {
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: /Copy the command: Start working/ }));
    expect(await navigator.clipboard.readText()).toBe('agentfund work https://fund.example/gridrs --budget 200m');
    expect(within(dialog).getByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('explains what the worker will and will not do, and shows the fingerprint to compare', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText(/checks the signed task manifests against the key you approved/)).toBeInTheDocument();
    expect(within(dialog).getByText(/network-restricted sandbox under your own Claude Code login/)).toBeInTheDocument();
    expect(within(dialog).getByText(/only count once CI passes/)).toBeInTheDocument();
    expect(within(dialog).getByText(/never touches files outside the task's declared scope/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Copy key fingerprint/ })).toHaveAttribute(
      'title',
      expect.stringContaining(PROJECT.pubkey_fingerprint),
    );
  });

  it('moves focus into the dialog and makes the page behind it inert', async () => {
    const { dialog } = await openDialog();
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.getElementById('root')).toHaveAttribute('inert');
  });

  it('traps Tab inside the dialog in both directions', async () => {
    const { user, dialog } = await openDialog();
    await within(dialog).findByText('agentfund login https://fund.example');
    const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex="0"]')];
    const first = focusable[0] as HTMLElement;
    const last = focusable.at(-1) as HTMLElement;
    expect(first).toHaveAccessibleName('Close');

    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();

    for (let i = 0; i < focusable.length * 2; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('closes on Escape and returns focus to the button that opened it', async () => {
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back with tokens' })).toHaveFocus();
    expect(document.getElementById('root')).not.toHaveAttribute('inert');
  });

  it('closes from the Close button', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks signed-out visitors to sign in before pledging', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText(/Sign in to record a pledge/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Pledge an amount')).not.toBeInTheDocument();
  });

  it('lets a signed-in user pledge a human-written amount', async () => {
    session.setToken('afs_test');
    const fetchSpy = mockApi({
      'GET /v1/meta': () => META,
      'GET /v1/me': () => ({ id: 'https://fund.example/u/ada', handle: 'ada', role: 'donor', created_at: '2026-01-01T00:00:00Z' }),
      'POST /v1/projects/gridrs/pledges': async (request) => {
        const body = (await request.json()) as { token_amount: number };
        return { id: 'plg_1', project: 'gridrs', donor: { id: 'x', handle: 'ada' }, token_amount: body.token_amount, created_at: '2026-10-06T00:00:00Z' };
      },
    });
    const { user, dialog } = await openDialog();
    const field = await within(dialog).findByLabelText('Pledge an amount');

    await user.type(field, 'lots');
    await user.click(within(dialog).getByRole('button', { name: 'Pledge' }));
    expect(await within(dialog).findByText(/Enter a whole number of tokens/)).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, '50m');
    await user.click(within(dialog).getByRole('button', { name: 'Pledge' }));
    expect(await within(dialog).findByText('50,000,000')).toBeInTheDocument();
    const posts = fetchSpy.mock.calls.map(([request]) => request as Request).filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
  });
});

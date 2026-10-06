import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../api/types';
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
      expect(found).toHaveLength(5);
      return found.map((node) => node.textContent);
    });
    expect(commands).toEqual([
      'curl -fsSL https://get.fund.example/install.sh | sh',
      'agentfund login https://fund.example',
      'agentfund approve https://fund.example/gridrs',
      'agentfund dry-run https://fund.example/gridrs',
      'agentfund work https://fund.example/gridrs --budget 200m --schedule "02:00-06:00"',
    ]);
  });

  it('copies a command to the clipboard', async () => {
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: /Copy the command: Start working/ }));
    expect(await navigator.clipboard.readText()).toBe(
      'agentfund work https://fund.example/gridrs --budget 200m --schedule "02:00-06:00"',
    );
    expect(within(dialog).getByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('falls back to the built-in install line when the instance names none', async () => {
    mockApi({ 'GET /v1/meta': () => ({ ...META, links: undefined }) });
    const { dialog } = await openDialog();
    expect(
      await within(dialog).findByText(
        'curl -fsSL https://raw.githubusercontent.com/agentfund/agentfund/main/scripts/install.sh | sh',
      ),
    ).toBeInTheDocument();
  });

  it('states what the worker needs and that credentials are not stored', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText(/You need Docker running/)).toHaveTextContent(
      /CLAUDE_CODE_OAUTH_TOKEN from claude setup-token, or ANTHROPIC_API_KEY\. The worker never stores them\./,
    );
  });

  it('explains what the worker will and will not do, and shows the fingerprint to compare', async () => {
    const { dialog } = await openDialog();
    const will = within(within(dialog).getByRole('heading', { name: 'It will' }).parentElement as HTMLElement);
    expect(will.getByText(/Checks the signed task manifests against the key you approved/)).toBeInTheDocument();
    expect(will.getByText(/network-restricted sandbox under your own Claude Code login/)).toBeInTheDocument();
    expect(will.getByText(/only count once CI passes/)).toBeInTheDocument();
    const never = within(within(dialog).getByRole('heading', { name: 'It never' }).parentElement as HTMLElement);
    expect(never.getByText("Touches files outside the task's declared scope.")).toBeInTheDocument();
    expect(never.getByText('Sends your credentials anywhere.')).toBeInTheDocument();
    expect(never.getByText("Runs anything you haven't approved.")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Copy key fingerprint/ })).toHaveAttribute(
      'title',
      expect.stringContaining(PROJECT.pubkey_fingerprint),
    );
  });

  it('moves focus into the dialog and hides the page behind it from assistive tech', async () => {
    const { dialog } = await openDialog();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    // The page behind is out of the accessibility tree: its button can no longer be found by role.
    expect(screen.queryByRole('button', { name: 'Back with tokens' })).not.toBeInTheDocument();
  });

  it('traps Tab inside the dialog in both directions', async () => {
    const { user, dialog } = await openDialog();
    await within(dialog).findByText('agentfund login https://fund.example');
    const stops = dialog.querySelectorAll('a[href], button, input, [tabindex="0"]').length;
    expect(stops).toBeGreaterThan(5);

    for (let i = 0; i < stops + 3; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < stops + 3; i += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('closes on Escape and returns focus to the button that opened it', async () => {
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back with tokens' })).toHaveFocus());
  });

  it('closes from the Close button', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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

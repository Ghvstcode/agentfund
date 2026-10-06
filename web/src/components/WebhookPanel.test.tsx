import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProjectWebhook } from '../api/types';
import { META, mockApi, reply } from '../test/mockApi';
import { renderApp } from '../test/render';
import { WebhookPanel } from './WebhookPanel';

const WEBHOOK: ProjectWebhook = {
  url: 'https://fund.example/v1/webhooks/ci',
  secret: 'whsec_first',
  provider: 'github',
  content_type: 'application/json',
  events: ['workflow_run', 'check_suite', 'pull_request'],
  ci_poll: false,
};

function mock(webhook: ProjectWebhook = WEBHOOK) {
  let current = webhook;
  return mockApi({
    'GET /v1/meta': () => META,
    'GET /v1/projects/gridrs/webhook': () => current,
    'POST /v1/projects/gridrs/webhook/rotate': () => {
      current = { ...current, secret: 'whsec_second' };
      return current;
    },
  });
}

const requests = (spy: ReturnType<typeof mock>, path: string) =>
  spy.mock.calls.filter(([request]) => new URL((request as Request).url).pathname === path);

describe('WebhookPanel', () => {
  it('does not ask the server for the secret until the panel is opened', async () => {
    const spy = mock();
    const user = userEvent.setup();
    renderApp(<WebhookPanel slug="gridrs" />);
    const toggle = screen.getByRole('button', { name: 'CI webhook' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(requests(spy, '/v1/projects/gridrs/webhook')).toHaveLength(0);

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('https://fund.example/v1/webhooks/ci')).toBeInTheDocument();
    expect(requests(spy, '/v1/projects/gridrs/webhook')).toHaveLength(1);
  });

  it('shows the URL, content type and GitHub events, and says to register the project first', async () => {
    mock();
    renderApp(<WebhookPanel slug="gridrs" defaultOpen />);
    expect(await screen.findByText('application/json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the payload URL' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the content type' })).toBeInTheDocument();
    for (const event of WEBHOOK.events) expect(screen.getByText(event)).toBeInTheDocument();
    expect(screen.getByText(/Add the hook only after the project exists here/)).toBeInTheDocument();
    expect(screen.queryByText(/also polls the CI provider/)).not.toBeInTheDocument();
  });

  it('keeps the secret masked until revealed, but lets it be copied either way', async () => {
    mock();
    const user = userEvent.setup();
    renderApp(<WebhookPanel slug="gridrs" defaultOpen />);
    const reveal = await screen.findByRole('button', { name: 'Reveal' });
    expect(screen.queryByText('whsec_first')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy the webhook secret' }));
    expect(await navigator.clipboard.readText()).toBe('whsec_first');
    expect(screen.queryByText('whsec_first')).not.toBeInTheDocument();

    await user.click(reveal);
    expect(screen.getByText('whsec_first')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('whsec_first')).not.toBeInTheDocument();
  });

  it('rotates only after a confirmation that says the old secret stops working', async () => {
    const spy = mock();
    const user = userEvent.setup();
    renderApp(<WebhookPanel slug="gridrs" defaultOpen />);
    await user.click(await screen.findByRole('button', { name: 'Reveal' }));
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    const confirm = screen.getByRole('alert');
    expect(confirm).toHaveTextContent('The old secret stops working immediately.');
    expect(requests(spy, '/v1/projects/gridrs/webhook/rotate')).toHaveLength(0);

    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(requests(spy, '/v1/projects/gridrs/webhook/rotate')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    await user.click(screen.getByRole('button', { name: 'Rotate now' }));
    expect(await screen.findByText(/New secret issued/)).toBeInTheDocument();
    expect(requests(spy, '/v1/projects/gridrs/webhook/rotate')).toHaveLength(1);

    // The new secret replaces the old one and starts out masked again.
    expect(screen.queryByText('whsec_first')).not.toBeInTheDocument();
    expect(screen.queryByText('whsec_second')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByText('whsec_second')).toBeInTheDocument();
  });

  it('keeps the confirmation open and explains when rotation fails', async () => {
    mockApi({
      'GET /v1/meta': () => META,
      'GET /v1/projects/gridrs/webhook': () => WEBHOOK,
      'POST /v1/projects/gridrs/webhook/rotate': () =>
        reply(403, { type: 'http://api.test/problems/forbidden', title: 'Forbidden', status: 403 }),
    });
    const user = userEvent.setup();
    renderApp(<WebhookPanel slug="gridrs" defaultOpen />);
    await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
    await user.click(screen.getByRole('button', { name: 'Rotate now' }));
    expect(await screen.findByText('Your account is not allowed to do this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate now' })).toBeInTheDocument();
  });

  it('gives signed-JSON instructions for generic CI and notes when polling makes the hook optional', async () => {
    mock({ ...WEBHOOK, provider: 'generic', events: [], ci_poll: true });
    renderApp(<WebhookPanel slug="gridrs" defaultOpen />);
    expect(await screen.findByText('X-AgentFund-Signature: sha256=<hex HMAC-SHA256 of the raw body>')).toBeInTheDocument();
    // The link follows the instance's own source once /v1/meta has answered.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Payload format in the docs' })).toHaveAttribute(
        'href',
        'https://src.fund.example/blob/main/spec/protocol.md',
      ),
    );
    expect(screen.getByText(/also polls the CI provider for results, so the webhook is optional/)).toBeInTheDocument();
    expect(screen.queryByText(/Add the hook only after the project exists here/)).not.toBeInTheDocument();
    expect(screen.queryByText('Events')).not.toBeInTheDocument();
  });

  it('shows an error state when the settings cannot be loaded', async () => {
    mockApi({ 'GET /v1/meta': () => META });
    renderApp(<WebhookPanel slug="gridrs" defaultOpen />);
    expect(await screen.findByText("Couldn't load the webhook settings")).toBeInTheDocument();
  });
});

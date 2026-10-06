import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectPreview } from '../api/types';
import { session } from '../lib/session';
import { META, mockApi, reply } from '../test/mockApi';
import { renderApp } from '../test/render';
import ProjectWizard from './ProjectWizard';

const REPO = 'https://github.com/example/gridrs';

const PREVIEW: ProjectPreview = {
  ok: true,
  errors: [],
  commit: '2721068a7775bcc9f2fd134fc2b7a1f6584071ff',
  base_branch: 'main',
  agentfund: { name: 'gridrs', language: 'rust', token_goal: 60_000_000 } as unknown as ProjectPreview['agentfund'],
  suggested_slug: 'gridrs',
  pubkey_fingerprint: 'SHA256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  signature_valid: true,
  lock_sha256: '87c50d7b3920959abb1be2122e5b7fa88d8302225fe35af984afb95320389a3f',
  token_total: 7_000_000,
  manifests: [
    { id: '0001-csv-parser', title: 'CSV parser with quoted fields', path: 'tasks/0001-csv-parser.yaml', max_tokens: 4_000_000, content_hash: 'aa'.repeat(32) },
    { id: '0002-formula-tokenizer', title: 'Formula tokenizer', path: 'tasks/0002-formula-tokenizer.yaml', max_tokens: 3_000_000, content_hash: 'bb'.repeat(32), depends_on: ['0001-csv-parser'] },
  ],
};

const created = (status: 'active' | 'pending') => ({ slug: 'grid', name: 'gridrs', status });

async function checkRepository(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Repository URL'), REPO);
  await user.click(screen.getByRole('button', { name: 'Check repository' }));
}

describe('ProjectWizard', () => {
  beforeEach(() => session.setToken('afs_test'));

  it('asks signed-out visitors to sign in', async () => {
    session.clear();
    mockApi({ 'GET /v1/meta': () => META });
    renderApp(<ProjectWizard />);
    expect(screen.getByRole('heading', { name: 'Register a project' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dev login' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Repository URL')).not.toBeInTheDocument();
  });

  it('walks from repository to preview to a live project', async () => {
    const bodies: Record<string, unknown> = {};
    mockApi({
      'GET /v1/meta': () => META,
      'POST /v1/projects/preview': async (request) => {
        bodies.preview = await request.json();
        return PREVIEW;
      },
      'POST /v1/projects': async (request) => {
        bodies.create = await request.json();
        return reply(201, created('active'));
      },
    });
    const user = userEvent.setup();
    renderApp(<ProjectWizard />);
    expect(screen.getByText('Repository', { selector: 'li' })).toHaveAttribute('aria-current', 'step');

    await checkRepository(user);

    const review = await screen.findByRole('heading', { name: /^Review/ });
    expect(review).toHaveFocus();
    expect(bodies.preview).toEqual({ repo_url: REPO });
    expect(screen.getByText('This repository verifies')).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.getByText(PREVIEW.pubkey_fingerprint as string)).toBeInTheDocument();
    expect(screen.getByText('7,000,000')).toBeInTheDocument();

    const manifests = within(screen.getByRole('table'));
    expect(manifests.getByText('CSV parser with quoted fields')).toBeInTheDocument();
    expect(manifests.getByText('tasks/0002-formula-tokenizer.yaml')).toBeInTheDocument();
    expect(manifests.getByText('0001-csv-parser')).toBeInTheDocument();

    const descriptor = screen.getByRole('heading', { name: /as parsed/ }).parentElement as HTMLElement;
    expect(within(descriptor).getByText('language')).toBeInTheDocument();
    expect(within(descriptor).getByText('rust')).toBeInTheDocument();

    const slug = screen.getByLabelText('Slug');
    expect(slug).toHaveValue('gridrs');
    await user.clear(slug);
    await user.type(slug, 'grid');
    await user.type(screen.getByLabelText('Token goal (optional)'), '80m');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('gridrs is live')).toBeInTheDocument();
    expect(bodies.create).toEqual({ repo_url: REPO, slug: 'grid', token_goal: 80_000_000 });
    expect(screen.getByRole('link', { name: 'Open the project page' })).toHaveAttribute('href', '/grid');
    expect(await screen.findByText('agentfund approve https://fund.example/grid')).toBeInTheDocument();
    expect(screen.getByText('Live', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
  });

  it('leaves the goal out when it is not overridden', async () => {
    let body: unknown;
    mockApi({
      'GET /v1/meta': () => META,
      'POST /v1/projects/preview': () => PREVIEW,
      'POST /v1/projects': async (request) => {
        body = await request.json();
        return reply(201, created('pending'));
      },
    });
    const user = userEvent.setup();
    renderApp(<ProjectWizard />);
    await checkRepository(user);
    await user.click(await screen.findByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('gridrs is waiting for approval')).toBeInTheDocument();
    expect(body).toEqual({ repo_url: REPO, slug: 'gridrs' });
  });

  it('shows why a repository cannot be registered and offers no way to create it', async () => {
    mockApi({
      'GET /v1/meta': () => META,
      'POST /v1/projects/preview': () => ({
        ...PREVIEW,
        ok: false,
        signature_valid: false,
        errors: ['MANIFEST.lock.minisig does not verify against the pubkey in agentfund.yaml'],
      }),
    });
    const user = userEvent.setup();
    renderApp(<ProjectWizard />);
    await checkRepository(user);

    expect(await screen.findByText("This repository can't be registered yet")).toBeInTheDocument();
    expect(screen.getByText(/does not verify against the pubkey/)).toBeInTheDocument();
    expect(screen.getByText('Does not verify')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Slug')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Repository URL')).toHaveValue(REPO);
  });

  it('reports a failed preview next to the URL field', async () => {
    mockApi({
      'GET /v1/meta': () => META,
      'POST /v1/projects/preview': () =>
        reply(422, {
          type: 'http://api.test/problems/validation',
          title: 'Invalid repository URL',
          status: 422,
          errors: [{ path: 'repo_url', message: 'Expected an https URL like https://github.com/owner/repo' }],
        }),
    });
    const user = userEvent.setup();
    renderApp(<ProjectWizard />);
    await checkRepository(user);
    expect(await screen.findByText(/Expected an https URL/)).toBeInTheDocument();
    expect(screen.getByLabelText('Repository URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the review open and explains when the slug is taken', async () => {
    mockApi({
      'GET /v1/meta': () => META,
      'POST /v1/projects/preview': () => PREVIEW,
      'POST /v1/projects': () =>
        reply(409, { type: 'http://api.test/problems/slug-taken', title: 'That slug is taken', status: 409, detail: 'A project called "gridrs" already exists.' }),
    });
    const user = userEvent.setup();
    renderApp(<ProjectWizard />);
    await checkRepository(user);
    await user.click(await screen.findByRole('button', { name: 'Create project' }));
    expect(await screen.findByText(/A project called "gridrs" already exists/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Slug')).toHaveAttribute('aria-invalid', 'true'));
  });

  it('rejects a goal that is not a token amount before calling the API', async () => {
    const fetchSpy = mockApi({ 'GET /v1/meta': () => META, 'POST /v1/projects/preview': () => PREVIEW });
    const user = userEvent.setup();
    renderApp(<ProjectWizard />);
    await checkRepository(user);
    await user.type(await screen.findByLabelText('Token goal (optional)'), 'plenty');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText(/Enter a whole number of tokens, like 60m/)).toBeInTheDocument();
    const creates = fetchSpy.mock.calls.filter(([request]) => new URL((request as Request).url).pathname === '/v1/projects');
    expect(creates).toHaveLength(0);
  });
});

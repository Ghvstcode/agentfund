import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { profilePath } from '../lib/handles';
import { DONOR_WITH_ELSEWHERE, FEDERATION_META, mockApi, REMOTE_DONOR } from '../test/mockApi';
import { renderApp } from '../test/render';
import DonorProfile from './DonorProfile';

const page = (handle: string) =>
  renderApp(
    <Routes>
      <Route path="u/:handle" element={<DonorProfile />} />
    </Routes>,
    { route: profilePath(handle) },
  );

describe('DonorProfile', () => {
  it('lists work on other instances apart from the local numbers', async () => {
    mockApi({ 'GET /v1/meta': () => FEDERATION_META, 'GET /v1/donors/ada': () => DONOR_WITH_ELSEWHERE });
    page('ada');
    const section = (await screen.findByRole('heading', { name: 'On other instances' })).closest('section') as HTMLElement;
    expect(within(section).getByText('Not counted in the totals or rank here')).toBeInTheDocument();

    const rows = within(within(section).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const nordic = within(rows[0] as HTMLElement);
    expect(nordic.getByRole('link', { name: /Nordic OSS Fund/ })).toHaveAttribute('href', 'https://fund.nordic-oss.example/u/ada@fund.example');
    expect(nordic.getByRole('rowheader')).toHaveTextContent('as reported by fund.nordic-oss.example');
    expect(nordic.getByText('18.4M')).toBeInTheDocument();
    expect(nordic.getByText('15.1M')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByRole('rowheader')).toHaveTextContent('as reported by lab.hackerspace.example:8443');
    // The local figure on the card is the local one, not a sum.
    expect(screen.getAllByTitle('36,000,000 tokens').length).toBeGreaterThan(0);
    expect(screen.queryByTitle('54,420,000 tokens')).not.toBeInTheDocument();
  });

  it('has no such block for a donor who only worked here', async () => {
    mockApi({ 'GET /v1/meta': () => FEDERATION_META, 'GET /v1/donors/ada': () => ({ ...DONOR_WITH_ELSEWHERE, elsewhere: undefined }) });
    page('ada');
    await screen.findByRole('heading', { name: 'Projects backed' });
    expect(screen.queryByRole('heading', { name: 'On other instances' })).not.toBeInTheDocument();
  });

  it('loads a remote donor by a handle with @ and a port, and points at their home', async () => {
    const spy = mockApi({ 'GET /v1/meta': () => FEDERATION_META, 'GET /v1/donors/:handle': (_request, { handle }) => ({ ...REMOTE_DONOR, handle }) });
    page('jun@lab.hackerspace.example:8443');
    const home = await screen.findByRole('link', { name: /Profile at home/ });
    expect(home).toHaveAttribute('href', 'https://lab.hackerspace.example:8443/u/jun');
    expect(screen.getByText(/hosts jun's account and vouches for it/)).toBeInTheDocument();
    expect(screen.getByText(/Here since/)).toBeInTheDocument();

    const paths = spy.mock.calls.map(([request]) => new URL((request as Request).url).pathname);
    expect(paths).toContain('/v1/donors/jun%40lab.hackerspace.example%3A8443');
    // The link to copy is this page, not the profile at home.
    expect(screen.getByRole('button', { name: 'Copy the link to this profile' })).toBeInTheDocument();
  });
});

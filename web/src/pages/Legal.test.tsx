import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { META, mockApi } from '../test/mockApi';
import { renderApp } from '../test/render';
import { Privacy, Terms } from './Legal';

describe('Legal pages', () => {
  it('fill in the instance contact for requests', async () => {
    mockApi({ 'GET /v1/meta': () => ({ ...META, links: { ...META.links, legal_contact: 'privacy@fund.example', legal_name: 'Fund Example Ltd' } }) });
    renderApp(<Privacy />);
    expect(await screen.findByRole('heading', { name: 'Privacy policy.' })).toBeInTheDocument();
    expect(await screen.findByText(/This instance is run by Fund Example Ltd\./)).toBeInTheDocument();
    expect(screen.queryByText(/OPERATOR LEGAL NAME/)).not.toBeInTheDocument();
    expect((await screen.findAllByRole('link', { name: 'privacy@fund.example' }))[0]).toHaveAttribute('href', 'mailto:privacy@fund.example');
  });

  it("link to the operator's own page when one is configured", async () => {
    mockApi({ 'GET /v1/meta': () => ({ ...META, links: { ...META.links, terms_url: 'https://fund.example/legal/terms' } }) });
    renderApp(<Terms />);
    expect(await screen.findByRole('link', { name: 'https://fund.example/legal/terms' })).toHaveAttribute('href', 'https://fund.example/legal/terms');
    expect(screen.queryByRole('heading', { name: 'Terms of use.' })).not.toBeInTheDocument();
  });
});

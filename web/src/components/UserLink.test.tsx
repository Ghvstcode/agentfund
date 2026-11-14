import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DONOR_STANDINGS } from '../test/mockApi';
import { renderApp } from '../test/render';
import { DonorTable } from './DonorTable';
import { UserLink } from './UserLink';

describe('UserLink', () => {
  it('links a local handle to its profile, as plain text', () => {
    renderApp(<UserLink handle="ada" />);
    const link = screen.getByRole('link', { name: 'ada' });
    expect(link).toHaveAttribute('href', '/u/ada');
    expect(link.querySelector('[title]')).toBeNull();
  });

  it('shows a remote donor as name plus a dimmer @host that can be cut short', () => {
    renderApp(<UserLink handle="alice@a.example:8443" />);
    const link = screen.getByRole('link', { name: 'alice@a.example:8443' });
    const host = screen.getByText('@a.example:8443');
    expect(link).toContainElement(host);
    expect(host).toHaveClass('text-muted-foreground', 'truncate');
    expect(screen.getByText('alice')).not.toHaveClass('text-muted-foreground');
    // The whole handle stays available when the host is cut off.
    expect(screen.getByTitle('alice@a.example:8443')).toBeInTheDocument();
  });

  it('escapes @ and : so a remote handle stays one path segment', () => {
    renderApp(<UserLink handle="alice@a.example:8443" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/u/alice%40a.example%3A8443');
  });

  it('does not link system actors', () => {
    renderApp(<UserLink handle="ci" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('ci')).toBeInTheDocument();
  });

  it('renders remote donors on a leaderboard next to local ones', () => {
    renderApp(<DonorTable donors={DONOR_STANDINGS} label="Donor leaderboard" />);
    expect(screen.getByRole('link', { name: 'ada' })).toHaveAttribute('href', '/u/ada');
    expect(screen.getByRole('link', { name: 'jun@lab.hackerspace.example:8443' })).toHaveAttribute(
      'href',
      '/u/jun%40lab.hackerspace.example%3A8443',
    );
    expect(screen.getByRole('link', { name: 'freja@fund.nordic-oss.example' })).toBeInTheDocument();
  });
});

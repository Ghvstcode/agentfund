import { describe, expect, it } from 'vitest';
import { docLinks } from './commands';

describe('docLinks', () => {
  it('points every guide at the docs in the source', () => {
    const links = docLinks({ links: { source_url: 'https://git.example.com/acme/agentfund/' } });
    expect(links.home).toBe('https://git.example.com/acme/agentfund/tree/HEAD/docs');
    expect(links.selfHosting).toBe('https://git.example.com/acme/agentfund/blob/HEAD/docs/self-hosting.md');
    expect(links.organizations).toBe('https://git.example.com/acme/agentfund/blob/HEAD/docs/for-organizations.md');
    expect(links.spec).toBe('https://git.example.com/acme/agentfund/tree/HEAD/spec');
  });

  it("uses the operator's docs site as the docs home", () => {
    const links = docLinks({ links: { source_url: 'https://git.example.com/acme/agentfund', docs_url: 'https://docs.example.com' } });
    expect(links.home).toBe('https://docs.example.com');
    expect(links.quickstart).toBe('https://git.example.com/acme/agentfund/blob/HEAD/docs/quickstart.md');
  });
});

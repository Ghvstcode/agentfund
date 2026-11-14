import { vi } from 'vitest';
import type { Donor, DonorStanding, FederatedProject, Peer, PeerCreate, PeerPreview, PeerUpdate } from '../api/types';

type Params = Record<string, string>;
type Handler = (request: Request, params: Params) => unknown | Promise<unknown>;

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Wrap a body with a non-200 status. */
export function reply(status: number, body: unknown): MockResponse {
  return { status, body };
}

function isMockResponse(value: unknown): value is MockResponse {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/** Match "METHOD /a/:name/b" against a request, decoding what the `:name` segments captured. */
function matchPattern(pattern: string, method: string, pathname: string): Params | null {
  const [patternMethod = '', patternPath = ''] = pattern.split(' ');
  if (patternMethod !== method || !patternPath.includes(':')) return null;
  const wanted = patternPath.split('/');
  const given = pathname.split('/');
  if (wanted.length !== given.length) return null;
  const params: Params = {};
  for (const [index, part] of wanted.entries()) {
    const segment = given[index] ?? '';
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segment);
    else if (part !== segment) return null;
  }
  return params;
}

/**
 * Replace global fetch with a router keyed by "METHOD /path". A path segment written `:name`
 * matches anything and is handed to the handler, decoded, as `params.name`; an exact key wins
 * over a pattern. Unknown routes answer 404 with a problem document. Returns the spy so tests
 * can assert on the requests made.
 */
export function mockApi(routes: Record<string, Handler>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const pathname = new URL(request.url).pathname;
    const key = `${request.method} ${pathname}`;
    let handler = routes[key];
    let params: Params = {};
    if (!handler) {
      for (const [pattern, candidate] of Object.entries(routes)) {
        const matched = matchPattern(pattern, request.method, pathname);
        if (!matched) continue;
        handler = candidate;
        params = matched;
        break;
      }
    }
    const result = handler
      ? // A copy, so a test can still read the body of the request the spy recorded.
        await handler(request.clone(), params)
      : reply(404, { type: 'http://api.test/problems/not-found', title: `No mock for ${key}`, status: 404 });
    const { status, body } = isMockResponse(result) ? result : { status: 200, body: result };
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

export const META = {
  app: 'AgentFund',
  name: 'Test Instance',
  version: '1.2.3',
  base_url: 'https://fund.example',
  protocol_versions: ['v1'],
  spec_versions: [1],
  links: { install_command: 'curl -fsSL https://get.fund.example/install.sh | sh', source_url: 'https://src.fund.example' },
  capabilities: { github_oauth: true, dev_login: true, sse: true, ci_providers: ['github'], ci_poll: false, federation: false },
};

// ───────────────────────────── federation ─────────────────────────────

/** `META` of an instance that serves the federation operations. */
export const FEDERATION_META = { ...META, capabilities: { ...META.capabilities, federation: true } };

const problem = (status: number, code: string, title: string, detail?: string) =>
  reply(status, { type: `http://api.test/problems/${code}`, title, status, detail });

const PEER_DEFAULTS = { added_at: '2026-10-01T09:00:00Z', last_error: null, observed_pubkey: null } as const;

/** One healthy peer, one that does not accept this instance's donors, one whose key changed. */
export const PEERS: Peer[] = [
  {
    ...PEER_DEFAULTS,
    base_url: 'https://fund.nordic-oss.example',
    host: 'fund.nordic-oss.example',
    name: 'Nordic OSS Fund',
    version: '0.4.2',
    pubkey: 'RWQmwzO2sgEHnZwzuKhXItU80U7+0EAbg5Xpb0sdeBpyfaagkY7PCVOW',
    pubkey_fingerprint: 'SHA256:0455f6aa03e7f474b70029535799044afa4b001c11d340446a6bfe3cdad20f58',
    status: 'active',
    discover: true,
    accept_identities: true,
    accepts_us: true,
    projects: 4,
    donors: 2,
    last_synced_at: '2026-11-14T08:00:00Z',
  },
  {
    ...PEER_DEFAULTS,
    base_url: 'https://tokens.libre-science.example',
    host: 'tokens.libre-science.example',
    name: 'Libre Science Compute',
    version: '0.4.0',
    pubkey: 'RWRsxS1kZ1p4Yk9uR3dXc2pQb0ZtN1ZkQ2x6T3hLQjJ5SGVhTnVJcVRy',
    pubkey_fingerprint: 'SHA256:7c1f0d2e9b3a48566e0f1d2c3b4a59687a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d',
    status: 'active',
    discover: true,
    accept_identities: false,
    accepts_us: false,
    projects: 2,
    donors: 0,
    last_synced_at: '2026-11-13T06:00:00Z',
    last_error: 'GET https://tokens.libre-science.example/v1/projects: 503 Service Unavailable',
  },
  {
    ...PEER_DEFAULTS,
    base_url: 'https://lab.hackerspace.example:8443',
    host: 'lab.hackerspace.example:8443',
    name: 'Hackerspace Lab',
    version: '0.3.9',
    pubkey: 'RWT4bGFiLWhhY2tlcnNwYWNlLXBpbm5lZC1rZXktMDAwMDAwMDAwMDAw',
    pubkey_fingerprint: 'SHA256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
    status: 'key_mismatch',
    discover: true,
    accept_identities: true,
    accepts_us: true,
    projects: 2,
    donors: 1,
    last_synced_at: '2026-11-11T08:00:00Z',
    last_error: 'The instance key changed',
    observed_pubkey: 'RWT4bGFiLWhhY2tlcnNwYWNlLW9ic2VydmVkLWtleS0wMDAwMDAwMDAw',
  },
];

const TOTALS = { pledged: 0, reported: 0, delivered: 0, merged: 0, in_flight: 0 };
const TASKS = { open: 4, claimed: 0, delivered: 1, merged: 6, failed: 0, claimable: 3 };

function federatedProject(peer: Peer, slug: string, description: string, language: string, goal: number, delivered: number): FederatedProject {
  return {
    id: `${peer.base_url}/${slug}`,
    url: `${peer.base_url}/${slug}`,
    instance: { base_url: peer.base_url, host: peer.host, name: peer.name },
    slug,
    name: slug,
    description,
    repo_url: `https://codeberg.org/example/${slug}`,
    language,
    tags: [language],
    status: 'active',
    token_goal: goal,
    totals: { ...TOTALS, pledged: goal, reported: delivered, delivered, merged: Math.round(delivered * 0.8) },
    tasks: TASKS,
    donors: 7,
    trust_tier: 'established',
    accepts_local_identities: peer.accepts_us === true,
    fetched_at: peer.last_synced_at ?? peer.added_at,
  };
}

const [NORDIC, LIBRE] = PEERS as [Peer, Peer, Peer];

/** Six projects on the two peers that are listed: four where local donors are accepted, two where not. */
export const FEDERATED_PROJECTS: FederatedProject[] = [
  federatedProject(NORDIC, 'fjord-db', 'An embedded time-series store for sensor data.', 'rust', 240e6, 170.4e6),
  federatedProject(NORDIC, 'wasm-sandbox', 'Run untrusted WebAssembly with capability-based I/O.', 'rust', 180e6, 68.4e6),
  federatedProject(LIBRE, 'openspectra', 'Read and plot mass-spectrometry files.', 'python', 90e6, 46.8e6),
  federatedProject(NORDIC, 'sami-nlp', 'Tokenisers for the Sámi languages.', 'python', 60e6, 26.4e6),
  federatedProject(LIBRE, 'pdbfold-lite', 'Protein structure alignment on a laptop.', 'c++', 320e6, 28.8e6),
  federatedProject(NORDIC, 'icebreaker-ci', 'A self-hosted CI runner that needs nothing but SSH.', 'go', 75e6, 67.5e6),
];

const STANDING = { pledged: 0, reported: 9_000_000, delivered: 8_200_000, merged: 6_100_000, tasks_delivered: 4, tasks_merged: 3 };

/** Leaderboard rows: a local donor and two whose home is a peer (one on a host with a port). */
export const DONOR_STANDINGS: DonorStanding[] = [
  { id: 'https://fund.example/u/ada', handle: 'ada', ...STANDING, delivered: 36_000_000 },
  { id: 'https://lab.hackerspace.example:8443/u/jun', handle: 'jun@lab.hackerspace.example:8443', ...STANDING, delivered: 13_700_000 },
  { id: 'https://fund.nordic-oss.example/u/freja', handle: 'freja@fund.nordic-oss.example', ...STANDING },
];

const DONOR_DEFAULTS = { joined_at: '2026-08-01T00:00:00Z', projects_backed: 0, streak_days: 0, rank: null, projects: [], recent: [] };

/** A local donor who also worked on two peers. */
export const DONOR_WITH_ELSEWHERE: Donor = {
  ...DONOR_DEFAULTS,
  ...(DONOR_STANDINGS[0] as DonorStanding),
  github_login: 'ada',
  rank: 1,
  elsewhere: [
    {
      instance: { base_url: NORDIC.base_url, host: NORDIC.host, name: NORDIC.name },
      profile_url: 'https://fund.nordic-oss.example/u/ada@fund.example',
      pledged: 26_000_000,
      reported: 20_630_400,
      delivered: 18_420_000,
      merged: 15_104_400,
      tasks_delivered: 7,
      tasks_merged: 6,
      fetched_at: '2026-11-14T08:00:00Z',
    },
    {
      instance: { base_url: 'https://lab.hackerspace.example:8443', host: 'lab.hackerspace.example:8443', name: 'Hackerspace Lab' },
      profile_url: 'https://lab.hackerspace.example:8443/u/ada@fund.example',
      pledged: 4_000_000,
      reported: 3_528_000,
      delivered: 3_150_000,
      merged: 3_150_000,
      tasks_delivered: 2,
      tasks_merged: 2,
      fetched_at: '2026-11-11T08:00:00Z',
    },
  ],
};

/** A donor whose home is a peer on a non-default port: `id` is their profile there. */
export const REMOTE_DONOR: Donor = { ...DONOR_DEFAULTS, ...(DONOR_STANDINGS[1] as DonorStanding), github_login: null, rank: 2 };

const PREVIEW_PUBKEY = 'RWSiC1c6mIn4m6ZTHOTANOpwc8nCvPqNnWvqXwgEN3tBeiXzP4w1qFJt';

/** What `fund.rustbridge.example` says about itself when looked up. */
export const PEER_PREVIEW: PeerPreview = {
  base_url: 'https://fund.rustbridge.example',
  host: 'fund.rustbridge.example',
  name: 'Rustbridge Fund',
  description: 'Inference for open source, donated and audited in the open.',
  version: '0.4.2',
  pubkey: PREVIEW_PUBKEY,
  pubkey_fingerprint: 'SHA256:970d017eb00a91eaa20482926c58cdd2b1dc94f11bf5a7ac69c1f2d3e1cc1b77',
  federation: true,
};

/**
 * Stateful handlers for every federation operation, over a private copy of the fixtures. Spread
 * the result into `mockApi({...})`. The preview answers for any URL: a host containing
 * `unreachable` cannot be verified, one containing `legacy` has federation off.
 */
export function federationRoutes({ peers = PEERS, projects = FEDERATED_PROJECTS }: { peers?: Peer[]; projects?: FederatedProject[] } = {}) {
  let current = structuredClone(peers);
  const find = (host: string | undefined) => current.find((peer) => peer.host === host);
  const missing = () => problem(404, 'not-found', 'No such peer');

  const preview = (baseUrl: string): PeerPreview | MockResponse => {
    const host = new URL(baseUrl).host;
    if (host.includes('unreachable')) {
      return problem(422, 'peer-unverifiable', 'The instance could not be verified', `${host} did not answer GET /v1/meta within 10 seconds.`);
    }
    return { ...PEER_PREVIEW, base_url: baseUrl, host, federation: !host.includes('legacy') };
  };

  const routes: Record<string, Handler> = {
    'GET /v1/federation/peers': () => ({
      items: current.filter((peer) => peer.status !== 'paused').map((peer) => ({ ...peer, last_error: null, observed_pubkey: null })),
    }),
    'GET /v1/federation/projects': (request) => {
      const query = new URL(request.url).searchParams;
      const q = (query.get('q') ?? '').toLowerCase();
      const listed = new Set(current.filter((peer) => peer.status === 'active' && peer.discover).map((peer) => peer.host));
      const items = projects
        .filter((project) => listed.has(project.instance.host))
        .filter((project) => !query.get('peer') || project.instance.host === query.get('peer'))
        .filter((project) => !query.get('language') || project.language === query.get('language'))
        .filter((project) => !q || `${project.name} ${project.description}`.toLowerCase().includes(q));
      const limit = Number(query.get('limit') ?? 50);
      const offset = Number(query.get('cursor') ?? 0);
      return { items: items.slice(offset, offset + limit), next_cursor: offset + limit < items.length ? String(offset + limit) : null };
    },
    'GET /v1/admin/federation/peers': () => ({ items: current }),
    'POST /v1/admin/federation/peers/preview': async (request) => preview(((await request.json()) as { base_url: string }).base_url),
    'POST /v1/admin/federation/peers': async (request) => {
      const body = (await request.json()) as PeerCreate;
      const seen = preview(body.base_url);
      if (isMockResponse(seen)) return seen;
      if (find(seen.host)) return problem(409, 'peer-exists', 'Already a peer');
      if (body.pubkey !== seen.pubkey) return problem(422, 'peer-unverifiable', 'The instance could not be verified');
      const peer: Peer = {
        ...PEER_DEFAULTS,
        base_url: seen.base_url,
        host: seen.host,
        name: seen.name,
        version: seen.version,
        pubkey: seen.pubkey,
        pubkey_fingerprint: seen.pubkey_fingerprint,
        status: 'active',
        discover: body.discover,
        accept_identities: body.accept_identities,
        accepts_us: null,
        projects: 0,
        donors: 0,
        last_synced_at: '2026-11-14T09:00:00Z',
      };
      current = [...current, peer];
      return reply(201, peer);
    },
    'PATCH /v1/admin/federation/peers/:host': async (request, { host }) => {
      const peer = find(host);
      if (!peer) return missing();
      const { pubkey, status, ...switches } = (await request.json()) as PeerUpdate;
      Object.assign(peer, switches);
      if (pubkey && pubkey === peer.observed_pubkey) {
        Object.assign(peer, { pubkey, pubkey_fingerprint: 'SHA256:newly-pinned', status: 'active', observed_pubkey: null, last_error: null });
      }
      if (status && peer.status !== 'key_mismatch') peer.status = status;
      return peer;
    },
    'DELETE /v1/admin/federation/peers/:host': (_request, { host }) => {
      if (!find(host)) return missing();
      current = current.filter((peer) => peer.host !== host);
      return reply(204, null);
    },
    'POST /v1/admin/federation/peers/:host/sync': (_request, { host }) => {
      const peer = find(host);
      if (!peer) return missing();
      if (peer.status === 'active') Object.assign(peer, { last_error: null, last_synced_at: '2026-11-14T09:30:00Z' });
      return peer;
    },
  };
  return routes;
}

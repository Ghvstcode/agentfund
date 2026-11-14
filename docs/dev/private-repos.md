# Private repositories: design

Status: **implemented** (option A, approved 2026-11-11). Operator docs:
[Self-hosting](../self-hosting.md#members-only-instance-private-repositories). Changes from the
proposal are noted inline.

Goal: a company runs its own AgentFund instance for its internal GitHub repositories. Employees
back internal projects with their coding-agent quota.

## The invariant

**An instance can read private repositories only if it is a members-only instance.**

Server credentials for private repositories and a sign-in gate over the whole instance ship as
one feature. A public instance never holds credentials that can read a private repository.
Tying the two together removes most of the ways a private project could leak.

## Where repositories are touched today (v0.1)

| Place | What it does | Assumes public? |
| --- | --- | --- |
| `server/src/lib/git.ts` `parseRepoUrl` | Accepts `https://` (or `file://` with `ALLOW_FILE_REPOS`). Refuses credentials in the URL and non-public hosts. | No credentials allowed. The host check is fine for github.com. |
| `git.ts` `Git.run` | `credential.helper=`, `core.askPass=`, `GIT_TERMINAL_PROMPT=0`, `http.followRedirects=false` | Yes. It is deliberately anonymous. |
| `git.ts` `defaultBranch` (`ls-remote`), `fetch` | Bare clone under `DATA_DIR/repos/<sha256(key)>.git` | Yes. Both need a token. |
| `git.ts` `friendlyGitMessage` | Shows "repository not found or not public" | Wording only. |
| `services/repo.ts` `inspectRepo`, `verifyCommit`, `readDescriptor` | Read `agentfund.yaml`, the lock and the manifests from the local clone | No. They work on the local clone. |
| `services/indexer.ts` `previewProject`, `createProject`, `indexProject`, `indexAll` | Fetch on create, on repin and on a timer | Via `git.fetch`. Preview needs only a session, not repo access, so it would become a read primitive. |
| `ci/poller.ts` | GitHub REST: check runs and pulls, with a global optional `GITHUB_TOKEN` | Yes. It is anonymous or uses one PAT. |
| `ci/github.ts`, `services/ci.ts` | Webhooks, verified with an HMAC secret per project | No. They work unchanged. |
| `services/projects.ts` `lockUrl`, `commitUrl`; the web UI | Build links to github.com | No. Links simply 404 for non-members of the GitHub org. |
| Visibility: `ledger.ts` (17, 243, 265), `events.ts` (71, 89), `pages.ts` (sitemap, feed, `headFor`, `/og`), the SSE hub, `listEvents`, `listDonors`, `getDonor`, `getStats` | Each repeats `status IN ('active','paused')` as its "listed" rule | Every listed project is public to anonymous callers. |
| `worker/internal/gitx/cache.go` `Fetch` (from `approve`, `dry-run` and `work`) | Host-side bare cache fetch with `credential.helper=` | Yes. It is anonymous. |
| `worker/internal/githost` `GitHub.Publish` | `gh` session: fork when `login != owner`, push with `gh auth git-credential`, then `gh pr create` | It **always forks** for an org repo, and private org repos usually forbid forking. |
| `worker/internal/scope`, `sandbox` | The sandbox gets a tar of the tree built on the host. It never fetches anything. | No. |
| Egress proxy | Allows the model API only. The git host is optional (`sandbox.allow_git_host`) and off by default. | No change is needed. |
| `docs/SECURITY.md` limitations 1–2, `docs/faq.md` "Can it work on a private repository?" | "Nothing private in the sandbox" | Yes. See [Threat model](#threat-model-changes-securitymd). |

## 1. Server credentials: a GitHub App (recommended)

The operator registers a GitHub App and installs it on the org, on **selected repositories**.
The App is **read-only**:

- Contents: read
- Metadata: read
- Checks: read
- Pull requests: read
- Organization members: read (for the sign-in gate)

The server signs a JWT with the App key. For each repository it looks up the installation
(`GET /repos/{owner}/{repo}/installation`) and mints a one-hour installation token. It caches
the token in memory until about five minutes before it expires. It never writes the token to
disk or to the database. *To verify against GitHub's docs: the exact endpoints, whether the
token can be narrowed with `repositories` / `permissions` when it is minted (it should be
narrowed to one repo), and the permission names.*

How the token is used:

- **git:** `ls-remote` and `fetch` get
  `Authorization: Basic base64(x-access-token:<token>)` as `http.extraHeader`, passed through
  `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` in the environment, **never in
  argv**. The key is `http.<repo url>/.extraHeader`, so git sends the header to that one
  repository only. The header only goes to the `https://github.com/` URL being fetched, and redirects
  stay off. Everything else in the hardened config stays the same.
- **Poller:** it uses the per-repo installation token instead of the global `GITHUB_TOKEN`.
  `GITHUB_TOKEN` keeps its current meaning, a rate-limit boost, for public repos.
- **Public repos on a members instance:** they keep working anonymously. The App token is used
  when the App is installed on the repo, and anonymous access otherwise.

Why not the alternatives:

- **A fine-grained PAT in config.** It is tied to a person who leaves, its scope is broad, and
  it is long-lived. It is fine for a quick trial but bad as the default. Optionally accept it
  later behind the same `tokenFor(repo)` interface. This doc proposes **App only** for v0.2 to
  keep the surface small.
- **Deploy keys per project.** They need SSH, and the server refuses every non-https transport
  on purpose. They are also a per-project secret in the database that leaks with it.

## 2. Backer access: the backer's own `gh` login (recommended)

The worker already pushes and opens PRs through the backer's `gh` session, on the host. For
private projects it also **fetches** with it.

- **Consent, pinned by the backer.** `agentfund approve` first tries an anonymous fetch. If that
  fails with an auth error on github.com, it asks: "Use your gh login to read
  github.com/acme/api?" A yes writes `git_auth: gh` into that project's worker config.
  `dry-run` and `work` then use `credential.helper=!gh auth git-credential` for the fetch, only
  for that project and only for its pinned github.com URL. The server never decides this. A
  hostile server cannot get the backer's credentials used for a URL the backer did not
  approve.
- **`http.followRedirects=false`** is added to the worker's git config whenever credentials are
  on. Today the worker's `baseConfig` lacks it.
- **Publish without forking.** `GitHub.Publish` asks for the backer's permission on the repo
  (`gh api repos/{o}/{r} --jq .permissions`, or GraphQL `viewerPermission`). With
  write/maintain/admin it pushes `agentfund/<task>-<claim>` straight to the project repo and
  opens the PR there. Without it, a private project refuses before the run with "you need write
  access to acme/api to back this project", and a public project keeps the fork path. This
  also fixes the current always-fork behaviour for org repos where the backer can push.
- **The sandbox is unchanged.** It still gets a host-built tar of the tree, never `.git` and
  never a credential. The egress allowlist does not change, and `sandbox.allow_git_host` still
  adds no credentials.

Why not server-minted, per-task installation tokens: the server would have to hold **write**
on every installed repo. Today a compromised server "can stall work but cannot change what
runs". With write tokens it could push to every repository it is installed on, which breaks
the principle in `SECURITY.md`. Commits and PRs would also come from a bot instead of the
backer, so review and attribution get worse. The cost of the recommended approach is that a
backer must be a GitHub org member with write on the repo. Inside a company that is usually
true already.

## 3. Visibility: an instance-wide gate (recommended, option A)

New config: `INSTANCE_ACCESS=public|members` (default `public`) and `ALLOWED_GITHUB_ORGS=acme`.

- **The gate.** In `members` mode, one middleware runs before every route, API and pages alike.
  Without a session or API key it returns 401 for the API, or the sign-in shell for pages
  (`noindex`, generic title, no project data in `headFor`). Allowlist: `/health`, the OAuth
  start and callback, `/v1/webhooks/ci` (signature-checked), `/v1/meta` (what the sign-in
  screen needs), and static assets. *(Implemented in the API's auth step,
  `server/src/http/kit.ts`. Pages can't be gated by session, because a page load carries no
  bearer token. So every path gets the same generic `noindex` shell with status 200, which also
  hides which slugs exist.)* `/sitemap.xml`, `/feed.atom` and `/og/*.png` are
  gated too, and `robots.txt` disallows everything.
- **Membership.** At OAuth callback the server checks `GET /orgs/{org}/members/{login}` with the
  App's installation token, which needs no extra OAuth scope from the user. The result is
  cached for 15 minutes and re-checked on session and API-key use, so someone who leaves the
  org loses access within that window. An admin ban stays the immediate switch. *To verify:
  the endpoint and permission.*
- **Startup refusals.** The server refuses to start when the GitHub App is configured and
  `INSTANCE_ACCESS` is not `members`. It also refuses `members` with `AUTH_DEV_LOGIN=true`.
- **Creating a private project.** Preview and create also require the caller to have write on
  the repo, checked with the App (collaborator permission endpoint; *to verify*). Before that
  check passes, every error is the same "not found or no access", so preview tells nobody
  whether a repo exists.
- **Stated plainly:** every member sees every project on the instance, including task prompts,
  numbers and the feed. An operator who needs per-repo access control runs separate instances.

**Option B (deferred): a per-project `visibility` on a public instance.** It needs a
`projects.visibility` column, and every site in the visibility row of the table above has to
take the viewer into account. That means the totals and stats over listed projects, donor
profiles, the event feed and SSE fan-out, the sitemap, `/og`, `headFor`, and every future
query. A single missed `status IN (...)` leaks a private project. The surface is large and
easy to regress, so it is not part of this change.

## 4. CI confirmation

- **Webhooks:** they work for private repos unchanged. GitHub signs with the per-project
  secret, and the route is in the gate's allowlist.
- **Polling:** it uses the installation token (Checks: read, Pull requests: read). The
  existing rule that the PR must live in the project repo and carry the reported branch stays.
  With direct pushes, `check_suite.head_branch` is set, which makes matching easier.

## 5. Migration and config

- **Migration `0005`:** none is needed for option A. Installation ids are looked up and cached
  in memory, and the instance mode lives in env.
- **New env:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_FILE`),
  `INSTANCE_ACCESS`, `ALLOWED_GITHUB_ORGS`. Add them to `config.ts`, `.env.example` and
  `docker-compose.yml`, with the startup refusals above.
- **Worker config:** a per-project `git_auth: gh` (empty means anonymous), written by
  `approve`.
- **API:** `meta.capabilities.members_only`. *(Implemented without the proposed
  `Project.repo_private`: on a members-only instance nothing is public anyway.)* Members-only
  instances also report `capabilities.sse: false`, because `EventSource` cannot send the bearer
  token. The web UI polls instead, and shows only a sign-in panel to visitors without a session.

## Threat-model changes (`SECURITY.md`)

- **Private code reaches the model provider** under the backer's credential. That is the point
  of the feature, and it is a data-governance decision for the company: back private projects
  with **org-managed** credentials (Claude for Work / Enterprise, or an org API key), not
  personal subscriptions. Codex with a personal ChatGPT sign-in is **not recommended** for
  private projects.
- Limitation 2's "nothing private to send" stops holding. Exfiltration through the model API
  and the domain-fronting gap now concern real data. The rest of the sandbox and egress story
  is unchanged.
- Limitation 1 ("scoped to open-source repositories") becomes: open source, or an internal
  instance whose members trust each other's task lists about as much as their own codebase.
- New rows:
  - **Server compromise:** the server holds a read-only App key. If stolen, it can read the
    installed repos but not change them.
  - **Leak through public pages:** the members-only gate, plus the startup refusals.
  - **Backer credentials used for an unapproved repo:** the per-project `git_auth` consent,
    github.com only, no redirects.
- `faq.md` "Can it work on a private repository?": yes, on a members-only instance.

## Tests

What exists *(as implemented)*:

- **`server/test/members.test.ts`:**
  - the startup refusals;
  - the RS256 JWT, verified with the public key;
  - installation tokens narrowed to one repository and to read access, with caching;
  - membership (204 only) and repository permission;
  - the environment that carries the git token, scoped to the repository URL;
  - an anonymous request to **every operation in the OpenAPI document** except the four open
    ones, which must answer 401 (so a new ungated operation fails the test);
  - `getMeta` saying `members_only` and `sse: false`;
  - member sessions and keys getting in, and a non-member getting 403;
  - pages without project data, with the sitemap, feed and cards giving 404 and `robots.txt`
    disallowing everything;
  - preview and create refused without write access, before any git fetch;
  - GitHub sign-in for a member and refusal of a non-member;
  - a worker's whole loop (pledge, claim, heartbeat, report) with a member's API key, and the
    key refused once the member leaves the org.
- **Worker:**
  - `gitx/auth_test.go`: the `gh` helper and `followRedirects=false` only for `git_auth: gh`,
    and only for `https://github.com`.
  - `githost`: direct push for a private repo with write access, refusal without it (at
    publish and in `Preflight`), and the fork path kept for public repos, all with the fake
    `gh` runner.
- **Checked by hand:**
  - git sends the extra header only to the repository's own URL
    (`git config --get-urlmatch`);
  - the scoped credential helper answers for github.com and not for other hosts;
  - real `gh` prints `false true` for the `repoAccess` query.

Not covered:

- the poller's per-repository token;
- the `approve` consent prompt;
- `scripts/e2e.sh` in members mode, which would need a fake GitHub;
- a real organization (HANDOFF C4b).

## Out of scope

- GitHub Enterprise Server, GitLab and Bitbucket.
- Per-project visibility on a public instance (option B).
- Per-repo access control between members of one instance.
- Fine-grained PATs or deploy keys as server credentials.
- Server-minted push tokens.
- Using the GitHub App for webhooks instead of per-project secrets.
- SNI pinning in the egress proxy. It is still planned, and it now matters more.

## Docs to update

- `self-hosting.md`: setting up the GitHub App and the members mode.
- `for-organizations.md`: remove the v0.1 limit once the selfhost-pitch PR has merged.
- `SECURITY.md`, `faq.md`, `donors.md`: `git_auth`, write access, and which credentials to use.
- `maintainers.md`: registering a private repo.
- `spec/protocol.md`: the gate, and `repo_private`.
- `HANDOFF.md`.

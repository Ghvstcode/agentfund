# Wire protocol v1 — semantics

Normative companion to [`openapi.yaml`](openapi.yaml). The OpenAPI document defines shapes;
this document defines behaviour. A server that implements both is a valid instance; the worker
knows nothing about any server beyond a base URL.

## 1. Identity and identifiers

- Every externally referenced entity has a **global id** rooted at the instance base URL:
  projects `<base_url>/<slug>`, users `<base_url>/u/<handle>`. The root is the entity's **home**
  instance: a donor who arrived from a peer (§14) keeps the id their home gave them. Database
  ids never appear on the wire. Opaque ids that do appear carry a type prefix: `clm_` claims, `rep_` reports, `plg_`
  pledges, `key_` API keys, `evt_` events.
- A **task** is addressed as `<slug>:<manifest id>` (e.g. `gridrs:0042-csv-parser`).
- Each instance generates an Ed25519 keypair on first boot and publishes the public half as
  `meta.instance_pubkey`. It signs identity assertions, and it is what a peer pins (§14).

## 2. Negotiation

Workers call `GET /v1/meta` first and MUST refuse to work when `protocol_versions` lacks `v1`
or `spec_versions` lacks the manifest's `spec_version`. `capabilities` keys are additive;
clients ignore keys they do not know. Breaking changes ship under `/v2/`.

## 3. Authentication

| Credential | Prefix | Obtained | Used for |
| --- | --- | --- | --- |
| Session token | `afs_` | GitHub OAuth (`/v1/auth/github/start`) or dev login | Browser UIs: everything a human does |
| API key | `af_` | `POST /v1/me/api-keys` (session required), or `POST /v1/auth/federated` for a donor vouched for by a peer (§14) | Workers: pledge, claim, heartbeat, report, release |

Both travel as `Authorization: Bearer …`. API keys and session tokens are stored only as
SHA-256 hashes. Operations marked `donorKey` accept an API key; where the OpenAPI lists both
schemes either works. Admin and maintainer operations require a session.

OAuth: `start?redirect=<url>` → GitHub → `callback` → `302` to `redirect` with
`#token=afs_…` in the fragment. `redirect` must be same-origin with the instance or on an
origin in the instance's allow-list, which is what lets an independently hosted UI log in.
Requested GitHub scope is `read:user` (plus `user:email`); the server never holds a token that
can write to anyone's repositories.

Roles: `donor` (default), `maintainer` (granted on first project creation), `admin` (handles
listed in instance config, or the first user when none are configured). Banned users get `403`.

**Members-only instances** (`meta.capabilities.members_only`): every operation except
`getMeta`, `authGithubStart`, `authGithubCallback` and `ciWebhook` needs a credential, also the
ones the OpenAPI marks public, and answers `401` without one. A credential whose user is not
(or no longer) a member of the instance's GitHub organizations gets `403`. GitHub sign-in
refuses non-members. Such an instance also sets `capabilities.sse` to `false`: `EventSource`
cannot send a bearer token, so clients poll. Creating or previewing a project on GitHub needs
write access to its repository; until that holds, every answer is the same
"repository not found or you have no write access to it".

## 4. Task state machine

```
            claim                    report(completed)              CI success            PR merged
  open ───────────────► claimed ─────────────────────► claimed ───────────────► delivered ─────────► merged
   ▲                       │        (awaiting CI)          │                        │
   │  release / expiry /   │                               │ CI failure /           │ PR closed
   └── non-completed ──────┘◄──────────────────────────────┘ PR closed unmerged ◄───┘ unmerged
       report
```

- `open → claimed`: `POST /v1/tasks/{id}/claim`. Atomic (`SELECT … FOR UPDATE SKIP LOCKED`);
  exactly one concurrent caller wins, the rest get `409 task-not-open`.
- A claim is refused with `409` and problem code:
  - `task-not-open` — state is not `open`;
  - `dependencies-unmet` — some `depends_on` task is not `merged`, or the instance has not
    read the base branch without error since that merge was recorded (claims start from the
    pinned commit, which must contain the merged work);
  - `project-not-active` — project is `pending`, `paused` or `removed`;
  - `claim-limit` — the donor already holds the instance's maximum of active claims;
  - `project-task-cap` / `project-daily-cap` — new-project trust caps (§7).
- `claimed → open`: voluntary `release`; lease expiry; any report whose status is not
  `completed`; CI failure on the reported branch; PR closed without merging.
- `claimed → delivered`: a CI result with conclusion `success` for the report's
  `branch` + `head_sha`.
- `delivered → merged`: the PR for the report's branch merges. A merge observed before any CI
  result moves the task straight to `merged` (and counts it delivered).
- `failed`: the manifest disappeared from the lock at a newer pin, or an admin closed it.
- If a manifest's content hash changes at a newer pin while the task is `open`, the row is
  updated in place. If it is `claimed`, the claim continues against the commit it was granted
  for. `delivered`/`merged` tasks are never reopened by a manifest edit.

## 5. Leases, heartbeats, reports

- A claim is a **lease** (`lease_seconds`, default 7200). `heartbeat` resets the expiry to
  now + `lease_seconds`. Workers heartbeat every `heartbeat_interval_seconds` (default 60).
- Heartbeats may carry cumulative `tokens_in` / `tokens_out`; the server exposes their sum as
  `totals.in_flight` and pushes it over SSE. In-flight tokens are display-only and vanish when
  the claim is reported, released or expires.
- A sweeper expires leases: claim status → `expired`, task → `open`, event `claim.expired`.
- **One report per claim.** A second report → `409 already-reported`.
- A report for an `expired` claim is stored with `flagged_late: true`, emits `report.late`, and
  changes neither task state nor any counter — late tokens are listed, not summed.
- A report for a `released` claim → `409 claim-not-active`.
- `status: completed` requires `branch`, `pr_url`, `head_sha` and `verify_exit_code == 0`;
  otherwise `422`. `branch` MUST be `agentfund/<manifest id>-<claim short>` where
  `<claim short>` is the first 8 characters after `clm_`.
- Tokens released via `release` (`tokens_in`/`tokens_out`) are recorded as a report-less burn:
  they count toward `reported` and nothing else.

## 6. The ledger: pledged → reported → delivered → merged

Four monotonic-by-evidence columns, per project and per donor:

| Column | Counts | Evidence |
| --- | --- | --- |
| `pledged` | Sum of pledge `token_amount`s | Donor intent (API call) |
| `reported` | `tokens_in + tokens_out` of every non-late report and release burn, *including failed runs* | Worker claim |
| `delivered` | Tokens of `completed` reports whose branch has a CI-passing run | CI provider (webhook or poll) |
| `merged` | Tokens of delivered reports whose PR merged | Git host |

Burned-but-failed tokens are therefore visible as `reported − delivered`, never hidden.
Leaderboards, trending and donor profiles rank on **delivered**, never on reported or pledged.
If a delivered report's PR is later closed unmerged, the task reopens; the tokens remain
delivered (CI did pass on real work) and are never counted as merged.

Every state change appends a row to the `events` log (`actor`, `action`, `payload`). Events
are never updated or deleted; the public ones are served by `/v1/events` and
`/v1/projects/{slug}/events` and pushed on `/v1/stream`.

## 7. CI confirmation

Delivery requires independent evidence that CI passed on the pushed branch.

**Matching.** A CI result matches a report when the result's branch equals `report.branch`,
its head SHA equals `report.head_sha`, and its repository is the project repo (or a fork of it
targeting the project repo). Unmatched results are acknowledged with `202 {matched:false}` and
ignored.

**GitHub adapter** (`ci_provider: github`). `POST /v1/webhooks/ci` accepts GitHub webhooks,
authenticated with `X-Hub-Signature-256`:

- `workflow_run` / `check_suite` with `action: completed` → CI result
  (`conclusion: success` passes; anything else fails). When a commit has several workflow runs,
  the report is delivered only when **all** completed runs for that head SHA succeeded.
- `pull_request` with `action: closed` → `merged: true` marks merged, otherwise closed.

When capability `ci_poll` is on, the server additionally polls the GitHub REST API for
`pending_ci`/`delivered` reports (check runs for `head_sha` in the project repo, and PR merge
state), so an instance that GitHub cannot reach (e.g. `localhost`) still confirms delivery from
the provider itself. Polling is evidence of the same strength as the webhook.

**Generic adapter** (`ci_provider: generic`). Any CI posts `GenericCiResult` JSON with header
`X-AgentFund-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body, instance webhook secret).

## 8. Project trust caps

Reputation is computed from the ledger. A project is `new` until it has
`established_after_merged_tasks` (default 3) merged tasks, then `established`.

While `new`, the server refuses claims on manifests whose `max_tokens` exceeds
`new_project_max_tokens_per_task` (default 5 000 000 → `409 project-task-cap`) and refuses
claims once the sum of `max_tokens` granted in the current UTC day reaches
`new_project_max_tokens_per_day` (default 25 000 000 → `409 project-daily-cap`).
`Project.trust` publishes the tier and caps. Workers apply their own policy independently and
never loosen it because of anything the server says.

## 9. Indexing

For each non-removed project the server keeps a clone and, on creation, on `repin`, on a push
webhook, and on a timer:

1. resolves the target commit (explicit `commit`, else head of `base_branch` when
   `follow_branch` is on);
2. runs manifest-spec verification steps 2–3 against the **registered** maintainer key
   (following the rotation chain);
3. on success: sets `pinned_commit`, `lock_sha256`, upserts manifest rows, emits
   `manifest.added/changed/removed` and `project.repinned`;
4. on failure: leaves the pin untouched, sets `index_error`, emits `project.index_failed`.

The key registered at creation is the one in `agentfund.yaml` at that moment; it only changes
through a valid rotation chain observed in a lock. The UI shows its fingerprint — the second
channel that makes a repo-only key swap detectable.

## 10. Live stream

`GET /v1/stream[?project=<slug>]` is `text/event-stream`:

```
event: totals
data: {"scope":"project","project":"gridrs","totals":{…},"token_goal":60000000,"tasks":{…}}

event: event
data: {"id":"evt_…","at":"…","actor":"alice","action":"task.claimed","project":"gridrs","task_id":"gridrs:0042-csv-parser","payload":{…}}

event: ping
data: {}
```

`totals` is sent on connect and after every change (coalesced to at most ~4/s per scope).
Clients reconnect with standard `EventSource` behaviour; there is no replay — on reconnect the
fresh `totals` frame is authoritative.

## 11. Errors

RFC 9457 `application/problem+json`. `type` is `<base_url>/problems/<code>`; clients switch on
the trailing `<code>`. Codes used by v1:

`unauthorized` (401) · `forbidden` (403) · `banned` (403) · `not-found` (404) ·
`validation` (422, with `errors[]`) · `task-not-open` · `dependencies-unmet` ·
`project-not-active` · `claim-limit` · `project-task-cap` · `project-daily-cap` ·
`claim-not-active` · `already-reported` · `slug-taken` · `repo-already-registered` (all 409) ·
`repo-unverifiable` (422; signature/schema failure when creating or re-pinning) ·
`bad-signature` (401, webhooks) · `peer-exists` (409) · `peer-unverifiable` (422) ·
`peer-not-trusted` (403) · `assertion-invalid` (401) · `rate-limited` (429) · `internal` (500).

## 12. Non-API public routes

Served by the reference server next to the API, for discoverability; not part of the protocol
contract and not needed by workers: `/sitemap.xml`, `/feed.atom` (new projects + deliveries),
`/og/<slug>.png` (generated card with the progress bar), `/healthz`, and the built SPA with
per-route meta/OpenGraph/JSON-LD tags injected. On a members-only instance the sitemap, feed
and cards answer `404`, and every path gets the same generic, `noindex` shell.

## 13. Clarifications

Readings fixed while building the reference server; they are normative.

- **`follow_branch` defaults to `true`** on creation, so dependent tasks are claimed against a
  commit that contains their merged dependencies.
- **`agentfund.yaml` `repo_url` must equal the URL being registered** (else
  `repo-unverifiable`), so a fork cannot be registered as the original.
- **On a public instance, creating or previewing a GitHub project needs push access** to its
  repository, asked of GitHub with the caller's own sign-in; otherwise `forbidden` (403), before
  the repository is read. Admins are exempt. Repositories off github.com are registered by an
  admin.
- **`Project.pubkey` is the newest key reached through a valid rotation chain** from the key
  registered at creation; the change emits `project.key_rotated`.
- **CI conclusions.** `success` passes. `failure`, `cancelled`, `timed_out`, `action_required`
  fail. `skipped`, `neutral` and `stale` are recorded and decide nothing.
- A failing run that arrives after a report is already `delivered` does not revert it.
  A `ci_failed` report is terminal: the task reopens and a new run is a new claim.
- A CI result that arrives before its report is stored and applied when the report arrives.
- Pull-request events match on branch **and** `pr_url`, not head SHA, so a maintainer fix-up
  commit on the PR still merges the report.
- A lease past its expiry is expired for heartbeats and reports even before the sweeper runs.
- Claim refusals are checked in this order: `project-not-active`, `task-not-open`,
  `dependencies-unmet`, `claim-limit`, `project-task-cap`, `project-daily-cap`.
- A manifest dropped from the lock makes `open`/`claimed` tasks `failed`; `delivered` and
  `merged` tasks are untouched; a failed task that reappears becomes `open`.
- `pending` and `removed` projects are `404` to everyone but their maintainer and admins and
  are excluded from totals, feeds and leaderboards.
- A release burn appears in ledger entries as `type: report` with `report_status: "released"`.
- Public operations ignore an invalid token and answer as anonymous.
- **Reserved slugs.** A project slug may not be `v1`, `u`, `og`, `auth`, `admin`, `donors`,
  `maintain`, `settings`, `styleguide`, `problems`, `assets`, `api`, `healthz`, `static`,
  `feed`, `sitemap`, `robots` or `favicon` (→ `422 validation`), so the reference UI's routes and
  global ids never collide.
- **Claim lost mid-run.** A worker whose heartbeat is answered `claim-not-active` stops and
  still sends its report; the server stores it `flagged_late`, so the burned tokens stay
  visible without being counted.
- **Webhook secrets are per project.** Each project has its own HMAC secret
  (`GET /v1/projects/{slug}/webhook`, maintainer only; `…/webhook/rotate` replaces it). A CI
  webhook is accepted only when its signature verifies under the secret of the project its
  payload names (the repository, for GitHub; `repo_url`, for generic), so one maintainer can
  never sign results for another project. An operator may additionally configure an
  instance-wide secret (`WEBHOOK_SECRET`) for organisation-level hooks; it is never shown to
  maintainers. A webhook whose project cannot be determined is rejected `401 bad-signature`.

## 14. Federation

Optional; advertised as `capabilities.federation`. An instance without it answers every
operation in this section `404 not-found`. An instance with `capabilities.members_only` never
has it. Three things cross instance boundaries, and only
these: a peer's public project list, a donor's identity, and what a peer says that donor did.

### 14.1 Peers

Peering is one-directional and made by an admin. To peer with the instance at `B`, an admin
of `A` supplies `B`'s base URL and the `instance_pubkey` they confirmed for it; `A` reads
`B/v1/meta` and refuses (`422 peer-unverifiable`) unless that document validates, its
`base_url` equals the URL being added, `capabilities.federation` is true and its
`instance_pubkey` is the confirmed key. The key is then **pinned**. Nothing about `B` is taken
on its own word before that, and nothing is ever taken from an instance that is not a peer.

A peer has two independent switches:

| Switch | Default | Effect on `A` |
| --- | --- | --- |
| `discover` | on | `B`'s active projects are listed under `GET /v1/federation/projects` |
| `accept_identities` | **off** | `B`'s donors may obtain an API key on `A` (§14.3) |

and a status: `active`, `paused` (nothing fetched, nothing accepted) or `key_mismatch`.
`GET /v1/federation/peers` lists active peers publicly, which is how `B` learns whether `A`
accepts its donors.

A peer is addressed by the **host** of its base URL (`fund.example.org`, with the port when
it is not the default). Two peers cannot share a host.

### 14.2 Sync

On a timer and on request, `A` pulls from each peer that is not paused, using only public
reads, refusing redirects, with bounded response sizes:

1. `GET /v1/meta`. If `base_url` no longer matches, the sync fails. If `instance_pubkey` is
   not the pinned key the peer becomes `key_mismatch`: its cached projects stop being listed,
   its assertions are refused and its donors' credentials stop resolving, until an admin pins
   the new key (`PATCH …/peers/{host}` with `pubkey`) or removes the peer. A peer whose key
   matches again returns to `active` by itself.
2. `GET /v1/federation/peers`, to record whether the peer accepts `A`'s donors.
3. With `discover` on: `GET /v1/projects?status=active`, paged. Each item must validate as a
   `Project`; anything else is dropped. The result replaces the cache for that peer.
4. `GET /v1/federation/donors?home=<A>`, paged: the standings on the peer of donors whose home
   is `A`. Only items whose `id` is `<A>/u/<handle>` for an existing local user are kept.

A failed sync changes nothing but `last_error`; the previous cache stands.

Everything obtained this way is **the peer's statement**. It is served attributed to the peer
(`FederatedProject.instance`, `Donor.elsewhere[].instance`) and is never added to a local
total, leaderboard or rank. The ledger rule of §6 is unchanged: an instance counts only
evidence it received itself.

### 14.3 Portable donor identity

A donor whose home is `A` works on a project hosted on `B` without an account on `B`:

1. **Assertion.** `POST A/v1/federation/assertions {"audience": "<B>"}` (session or API key)
   returns a `SignedDocument`: `payload` is the JSON text

   ```json
   {"type":"agentfund-identity-v1","iss":"<A>","sub":"<A>/u/<handle>","handle":"<handle>",
    "avatar_url":null,"aud":"<B>","iat":"<RFC 3339>","exp":"<RFC 3339>","jti":"<nonce>"}
   ```

   and `signature` is a minisign signature (prehashed) over the UTF-8 bytes of `payload`
   under `A`'s `instance_pubkey`. Lifetime is 300 seconds. An instance vouches only for
   accounts that are its own: a user whose home is elsewhere gets `403 forbidden`.

2. **Exchange.** `POST B/v1/auth/federated {"assertion": …}` (no credential). `B` checks, in
   this order, and believes nothing in the payload before the signature step passes:

   | Check | Failure |
   | --- | --- |
   | `payload` parses and is an `agentfund-identity-v1` statement with every field | `401 assertion-invalid` |
   | `aud` is `B`'s own base URL | `401 assertion-invalid` |
   | `iss` is a peer of `B` that is `active` with `accept_identities` on | `403 peer-not-trusted` |
   | `signature` verifies under the key **pinned** for that peer | `401 assertion-invalid` |
   | `sub` equals `<iss>/u/<handle>` and `handle` is a valid local handle | `401 assertion-invalid` |
   | `exp` is in the future, `iat` at most 60 s ahead, `exp − iat` ≤ 600 s | `401 assertion-invalid` |
   | `(iss, jti)` has not been redeemed before | `401 assertion-invalid` |

   On success `B` finds or creates the user with `id = sub` and handle
   `<handle>@<peer host>`, role `donor`, and returns a new API key. `@` cannot occur in a local
   handle, so a federated handle never collides with, or shadows, a local account.

3. **Work.** The key is an ordinary API key. Claim, heartbeat, report and release are
   exactly §4–§5; delivery still requires CI evidence (§7); trust caps still apply (§8).

The federated donor is `B`'s user in every other respect: `B`'s admins can ban them, and a ban
on `B` is unaffected by anything `A` says. Their credentials on `B` resolve only while their
home is a peer that is `active` with `accept_identities` on: pausing or removing the peer, or
a `key_mismatch`, cuts all of its donors off at the next request. A federated user never
receives the first-user admin role and cannot hold a browser session on `B`.

### 14.4 What a peer can and cannot do

A peer `B`, by being added to `A`, gains the ability to: have its project list shown on `A`
(marked as `B`'s); if `accept_identities` is on, introduce users to `A` under handles ending
in `@<B host>`; and say what `A`'s own donors did on `B`. It cannot create or alter a local
account, mint a handle without its own host in it, change any local total, or make `A` fetch
from an address other than its own base URL. A compromised peer key lets an attacker introduce
donors as `…@<B host>` until an admin pauses the peer; those donors still cannot count a token
as delivered without passing the project's CI.

Workers need nothing new from the manifest spec. A project found through a peer is approved
and worked on **at its home instance**, with the full verification chain of the manifest spec
against the maintainer key pinned there.

# Task manifests, project descriptor and lock file — spec v1

Normative. Key words MUST / MUST NOT / SHOULD follow RFC 2119. The JSON Schemas in
[`schemas/`](schemas/) are the machine-readable source of truth; where prose and schema
disagree, the schema wins and the prose is a bug.

A project repo carries three kinds of artifact:

| Path | Schema | What it is |
| --- | --- | --- |
| `agentfund.yaml` | `agentfund.schema.json` | Project descriptor, publishes the maintainer public key |
| `tasks/NNNN-slug.yaml` | `manifest.schema.json` | One task manifest per file |
| `tasks/MANIFEST.lock` + `tasks/MANIFEST.lock.minisig` | `lock.schema.json` | Hash list of every manifest + one detached signature over it |

## 1. Manifest

One YAML document per file under `tasks/`. The file name MUST be `<id>.yaml`. YAML is parsed
with the YAML 1.2 core schema; anchors, aliases, merge keys, tags and multiple documents MUST
be rejected. After parsing, the document MUST validate against `manifest.schema.json`.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `spec_version` | yes | — | `1`. Workers reject anything else. |
| `id` | yes | — | `NNNN-slug`, unique in the repo, equals the file stem. |
| `title` | yes | — | Human label for UI and PR titles. |
| `prompt` | yes | — | Instruction handed to the agent verbatim. |
| `scope.write` | yes | — | Globs the agent may change. |
| `scope.read` | no | whole repo | Globs present read-only in the sandbox beyond write scope. |
| `verify` | yes | — | `sh -c` command, cwd = repo root, run after the agent; exit 0 = pass. |
| `max_tokens` | yes | — | Hard cap on tokens for the task (see metering). |
| `timeout_minutes` | no | 60 | Wall-clock cap for agent + verify. |
| `depends_on` | no | `[]` | Task ids that must be `merged` first. |
| `base_branch` | no | `main` | Branch to fork from / target with the PR. |

**Globs.** Repo-relative, `/`-separated, [doublestar](https://github.com/bmatcuk/doublestar)
semantics: `*` matches within one path segment, `**` matches zero or more segments, `?` one
character, `{a,b}` alternation. Matching is case-sensitive. A glob MUST NOT start with `/`,
contain a `..` segment, or address `.git/`. Regardless of globs, the paths `agentfund.yaml`,
`tasks/**` and `.github/**` are **never writable** — a task cannot rewrite its own rules or the
CI that judges it.

**Scope enforcement.** After the agent and `verify` finish, the worker computes the set of
changed paths (added, modified, deleted, renamed — both sides, mode changes) against the claimed
commit. If any path does not match `scope.write`, is a symlink, a submodule, or is a
never-writable path, the worker MUST discard the entire run and report `verification_failed`.

**`scope.read`.** When present, files that match neither `scope.read` nor `scope.write` are
removed from the sandbox working tree before the agent starts (the `.git` directory is not
present in the sandbox at all). Manifest files and `agentfund.yaml` are always removed.

**Metering.** Tokens counted against `max_tokens` are the sum, over every model call the agent
makes, of input tokens (including cache-creation and cache-read tokens) and output tokens.
`tokens_in` in reports is the input-side sum; `tokens_out` the output side.

**Dependencies.** `depends_on` ids MUST exist in the same lock file and MUST NOT form a cycle.

## 2. `agentfund.yaml`

```yaml
spec_version: 1
name: gridrs
description: A terminal spreadsheet in Rust.
repo_url: https://github.com/example/gridrs
ci_provider: github
pubkey: RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
language: rust
tags: [tui, spreadsheet]
token_goal: 60000000
```

`pubkey` is the maintainer's Ed25519 public key in **minisign** encoding: base64 of
`"Ed" || key_id(8 bytes) || public_key(32 bytes)`.

**Fingerprint.** `SHA256:` followed by the lowercase hex SHA-256 of the 42 decoded bytes of
`pubkey`. This is the string shown by `agentfund approve` and on the server's Audit tab; the
donor compares the two.

`agentfund.yaml` is *not* covered by the lock signature. It is a publication channel, not an
authority: the worker never takes the key from the repo at run time — it uses the key the donor
pinned at approval.

## 3. `tasks/MANIFEST.lock`

UTF-8 JSON, schema `lock.schema.json`:

```json
{
  "lock_version": 1,
  "spec_version": 1,
  "manifests": [
    { "path": "tasks/0001-hello.yaml", "id": "0001-hello", "sha256": "9f86d0…" }
  ],
  "rotations": []
}
```

- `manifests` is sorted by `path` and lists **every** `tasks/*.yaml` in the commit — a manifest
  file not in the lock, or a lock entry with no file, fails verification.
- `sha256` is over the raw bytes of the manifest file as stored in git (no normalisation).
- `agentfund sign` writes the file with two-space indentation and a trailing newline, but
  verifiers MUST hash/verify the exact bytes present, never a re-serialisation.

### Signature

`tasks/MANIFEST.lock.minisig` is a standard detached
[minisign](https://jedisct1.github.io/minisign/) signature over the bytes of `MANIFEST.lock`,
in the **prehashed** variant (`ED`: Ed25519 over BLAKE2b-512 of the file). It verifies with the
stock tool:

```sh
minisign -Vm tasks/MANIFEST.lock -P "$(yq .pubkey agentfund.yaml)"
```

Verifiers MUST check both the file signature and the global signature over
`signature || trusted_comment`, and MUST reject the legacy non-prehashed `Ed` variant. The
trusted comment written by `agentfund sign` is `agentfund lock v1 key:<key_id_hex>`; verifiers
do not interpret it.

### Key rotation

To rotate, the maintainer signs a rotation statement **with the old key**:

```
agentfund-key-rotation-v1\n
from: <old pubkey>\n
to: <new pubkey>\n
```

(three lines, each terminated by a single `\n`; the signed message is those exact UTF-8 bytes).
The resulting minisign signature text is appended to `rotations` as
`{from, to, signature}`, `agentfund.yaml` is updated to the new key, and the lock is re-signed
with the new key.

A verifier holding pinned key `P` accepts a lock when there is a sequence
`P = K0 → K1 → … → Kn` (n ≥ 0, n ≤ 16) of entries in `rotations` in order, each link's
signature valid under its `from` key, and the lock signature valid under `Kn`. No other key is
ever accepted — in particular not the key currently in `agentfund.yaml`.

## 4. Verification chain (worker, before any execution)

Given a claim naming commit `C` and content hash `H` for task `T`, and the donor's approval
record `{pubkey P, approved_commit A, approved_lock_sha256 L}`:

1. **Fetch** the repo and resolve `C`. `C` must be a full 40-hex commit id that exists.
2. **Signature.** Read `tasks/MANIFEST.lock` and `.minisig` *at `C`* and verify per §3 against
   `P` (following rotations).
3. **Content.** Validate the lock against its schema; check every `tasks/*.yaml` at `C` is
   listed and matches its `sha256`; check `T`'s entry hash equals `H`; parse and schema-validate
   `T`'s manifest; check `id` matches the path.
4. **Approval.** Accept `C` only if one of:
   - `C` is `A` or an ancestor of `A`; or
   - policy `follow_unchanged_lock` is on and the lock bytes at `C` hash to `L` (the reviewed
     task set is byte-identical; only code moved); or
   - policy `auto_follow_signed_updates` is on (any validly signed lock is accepted).
   Both policies default to **off**.
5. **Policy.** Apply donor caps (task ceiling, daily/weekly budgets, schedule, allowed git hosts).

Any failure of steps 1–4 → the worker refuses loudly, reports `verification_failed`, and never
executes anything from the repo. A step-5 refusal releases the claim instead.

The server runs steps 2–3 itself when indexing (so the UI never lists a task set that does not
verify), but nothing in the system relies on the server having done so.

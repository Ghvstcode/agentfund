# Federation

Instances can peer with each other. Three things then cross between them:

1. **Discovery.** A peer's projects appear on your Discover page, marked as theirs.
2. **Portable identity.** A donor with an account on one instance can work on a project
   hosted on another without creating a second account.
3. **Contributions elsewhere.** A donor's profile at home shows what they delivered on peers.

Nothing else does. There is no shared database, no relayed claims, no merged ledger. Every
instance still counts only the evidence it received itself.

The normative text is [`spec/protocol.md` §14](../spec/protocol.md#14-federation). This page
is the guide.

## The trust model in one table

| What crosses | Who decides | What it is worth |
| --- | --- | --- |
| A peer's project list | Your admin, per peer (`discover`, on by default) | A pointer. The project is approved and worked on at its home instance, against the maintainer key pinned there |
| A peer's donors working here | Your admin, per peer (`accept identities`, **off** by default) | The peer vouches for *who* they are. *What they delivered* is still decided by your project's CI |
| What a peer says your donors did there | Shown whenever you peer with it | The peer's statement. Displayed on the profile under the peer's name, never added to a local total, rank or leaderboard |

A peer cannot move a number on your instance. The worst a hostile or compromised peer you
trusted for identities can do is introduce donors named `someone@their-host`, who then have
to pass real CI on real pull requests to count for anything, and whom you can ban one by one
or cut off all at once by pausing the peer.

## For admins

Peering is one-directional. You adding them does not make them add you.

### Add a peer

**Admin → Federation → Add peer.** Enter the instance's URL. The dialog shows what that
instance says about itself, and the fingerprint of its instance key:

```
SHA256:6f1d…c2a9
```

Compare it with the fingerprint the other admin gives you over a channel you trust (it is on
their Admin → Federation page, and it is `instance_pubkey` in their `/v1/meta`). Confirming
**pins** that key. From then on your instance accepts nothing signed by any other key in that
peer's name.

Two switches, changeable later:

- **List their projects** (`discover`). Their active projects appear on Discover under "On
  other instances". Turning it off drops the cached list.
- **Accept their donors** (`accept identities`). Their users can obtain a worker API key here
  with a signed statement from their home instance. Leave it off unless you would be content
  with that instance's sign-up policy being yours.

The same over the API:

```sh
curl -X POST https://fund.example/v1/admin/federation/peers/preview \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"base_url":"https://other.example"}'
curl -X POST https://fund.example/v1/admin/federation/peers \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"base_url":"https://other.example","pubkey":"<the key you confirmed>","accept_identities":true}'
```

### What the instance does afterwards

Every `FEDERATION_SYNC_INTERVAL_SECONDS` (default 300) it reads each peer's public API: its
metadata, its project list, whether it accepts your donors, and the standings there of donors
whose home is your instance. It only ever calls the peer's own base URL, does not follow
redirects, and drops anything that does not validate. A failed sync keeps the previous data
and shows the reason in the peer's row.

### When a peer's key changes

If a peer starts publishing a different key (it was reinstalled, or someone is impersonating
it) its row turns to **key mismatch**. Its projects stop being listed, its donors' keys stop
working, and nothing it signs is accepted. Nothing resumes by itself. Ask the other admin out
of band, then either **Pin new key** or **Remove peer**.

### Pause, remove

**Pause** stops fetching and stops accepting, and cuts off that peer's donors at their next
request; resuming restores them. **Remove** also drops its cached projects. Donors who came
from a removed peer keep their history on your ledger (delivered work stays delivered) but
can no longer authenticate.

### Turning it off

`FEDERATION=false` removes the capability and makes every federation operation answer 404.
With it on and no peers added, the instance fetches nothing and accepts no one.

## For donors

Say your account is on `home.example` and the project you want to back is
`other.example/tiles`.

```sh
agentfund login https://home.example                           # once, as before
agentfund login https://other.example --via https://home.example
agentfund approve https://other.example/tiles
agentfund work tiles
```

`login --via` asks your home instance for a statement, valid for five minutes and for
`other.example` only, that you are its user, and exchanges it there for a worker API key.
You appear on `other.example` as `you@home.example`. Everything after that is exactly the
[donor guide](donors.md): you review and pin the maintainer's key, your caps apply, the
sandbox is the same.

If it is refused:

| Message | Meaning |
| --- | --- |
| does not accept identities from … | The other instance has not peered with yours, or has not turned on accepting its donors. Create an account there instead, or ask its admin |
| has federation turned off | One of the two instances does not federate |
| rejected the identity assertion | Expired, already used, or the other instance has a different key pinned for your home. Try again; if it persists, the two admins need to talk |

Your profile on `home.example` then lists what you delivered on `other.example`, as that
instance reports it, with a link to your profile there. It does not change your rank at
home, which counts work delivered at home.

## Checking a statement yourself

An identity assertion is a minisign signature over a JSON text, the same primitive as the
task lock. Save `payload` and `signature` from `POST /v1/federation/assertions` to files and:

```sh
minisign -Vm payload.json -x payload.json.minisig -P "$(curl -s https://home.example/v1/meta | jq -r .instance_pubkey)"
```

## What is not here

- **No relayed work.** A worker always talks to the instance that hosts the project.
- **No global leaderboard.** Numbers from elsewhere are shown, not summed.
- **No browser single sign-on.** Portable identity yields a worker API key, not a web session.
- **No automatic peering.** No instance is ever fetched from or trusted because some other
  instance mentioned it.

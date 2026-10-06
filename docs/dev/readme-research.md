# README research

Working notes for the README and docs rewrite. Researched 2026-10-06 by fetching the raw READMEs
and GitHub docs listed below, plus three direct checks against GitHub (see section 5). Anything not
confirmed is marked **unverified**.

## 1. What the best READMEs do

Patterns we are adopting. Each is one thing, one repo that shows it, and what it means here.

| # | Pattern | Seen in | For AgentFund |
| --- | --- | --- | --- |
| 1 | One sentence that says what it is, in nouns, with the surprising part included. | [uv](https://github.com/astral-sh/uv): "An extremely fast Python package and project manager, written in Rust." [age](https://github.com/FiloSottile/age): "a simple, modern and secure file encryption tool, format, and Go library." | Keep "Fund open source with inference, not money." It is already the strongest line; the sentence after it must name the three actors (maintainer, backer, server) and nothing else. |
| 2 | One piece of proof directly under the tagline, captioned with exactly what it shows. | [uv](https://github.com/astral-sh/uv) and [ruff](https://github.com/astral-sh/ruff): a single benchmark chart in `<picture>` with an italic caption ("Installing Trio's dependencies with a warm cache."). | Our proof is the ledger, not speed: one image of a real project page (tokens pledged / delivered / tasks merged) with a caption naming the project and date. |
| 3 | Claims link to the method. | [uv](https://github.com/astral-sh/uv): "10-100x faster than pip" links to `BENCHMARKS.md`. [biome](https://github.com/biomejs/biome): "97% compatibility with Prettier". | Every number links to the public ledger entry or the PR. No number without a URL. |
| 4 | Install and first command on the first screen. | [bun](https://github.com/oven-sh/bun) and [ollama](https://github.com/ollama/ollama): install one-liner, then `ollama run ...`, before any feature list. | `install` then `agentfund approve <url>` then `agentfund work <url> --budget ...`, above "How it works". |
| 5 | Show the real terminal, generated from a script so it cannot drift. | [vhs](https://github.com/charmbracelet/vhs) prints the `.tape` next to the GIF it produced; [gum](https://github.com/charmbracelet/gum) alternates command and result. | Commit `docs/assets/demo.tape`; the GIF of `agentfund work` is a build artifact of it. The transcript in the README is the same run. |
| 6 | Caption the demo with the one thing the reader should notice. | [tRPC](https://github.com/trpc/trpc): GIF in a `<figure>` captioned "The client above is **not** importing any code from the server, only its type declarations." | Caption: "The server never sees the backer's login. The signature and hashes are checked on the backer's machine before anything runs." |
| 7 | Motivation as a short list of pointed questions or principles, not a manifesto. | [htmx](https://github.com/bigskysoftware/htmx): four "Why should only...?" questions. [Let's Encrypt 2014](https://letsencrypt.org/2014/11/18/announcing-lets-encrypt/): six one-word principles, one sentence each. | "Why this exists" is 4-5 bold words with one sentence each (Signed, Sandboxed, Capped, Counted-after-CI, Self-hostable). |
| 8 | Light/dark hero via `<picture>`, centered with `<p align="center">`. | [age](https://github.com/FiloSottile/age), [biome](https://github.com/biomejs/biome), [caddy](https://github.com/caddyserver/caddy), [uv](https://github.com/astral-sh/uv). | Two SVG files per diagram (`-light.svg`, `-dark.svg`). Replaces the ASCII architecture box, which wraps on mobile. |
| 9 | Say what is not included, in the same place as what is. | [tailscale](https://github.com/tailscale/tailscale): "this repo doesn't contain the mobile GUI code"; GUI wrappers "are themselves not open source". [age](https://github.com/FiloSottile/age) notes SSH recipients embed a tag "making it possible to track files". | State limits next to the feature: what the sandbox does not stop, what a signature does not prove, which agent CLIs are supported today. |
| 10 | A named "caveats" section in the README itself. | [cosign](https://github.com/sigstore/cosign): "Caveats" covers tags vs digests and a known race condition, in plain words. | "Risks and limits" is a top-level section, not buried in SECURITY.md. |
| 11 | A scale caveat on the self-host one-liner. | [PostHog](https://github.com/PostHog/posthog): hobby deploy command plus the note that it holds to roughly 100k events/month. | `docker compose up` plus one honest line on what the single-node setup is and is not suitable for. |
| 12 | One callout to prevent the most likely misreading. | [libsql](https://github.com/tursodatabase/libsql): an IMPORTANT block separating libSQL from Turso. | One `> [!NOTE]`: "AgentFund never holds your credentials or your money. The server is a scoreboard." The working-name note moves out of the hero. |

## 2. Anti-patterns we are avoiding

- **Badge walls.** Caddy's README opens with seven badges and a sponsor block before the first feature; excalidraw has six. The best-regarded ones carry three (uv, gum, bubbletea) or none (ollama). Budget: at most three, each answering a question a backer has (release, CI, license). No follower counts, no "PRs welcome".
- **Emoji bullet soup.** excalidraw ("💯 Free & open-source", "🎨 Infinite, canvas-based whiteboard") and tRPC ("🧙‍♂️", "🐎") lists scan as marketing and make every item weigh the same. We use plain bullets that each contain a checkable fact.
- **Adjectives instead of facts.** "Well-tested and production ready", "blazing", "seamless". Replace with a number and a link, or delete.
- **Wall of text before any demo.** If the first screen has no command and no image, readers leave. Zed's README has no screenshot at all and gets away with it only because the product is already known. We are not.
- **Unverifiable claims.** A token total with no link to the ledger, "secure sandbox" with no statement of what it blocks. Every trust claim gets a command that checks it.
- **Install steps that do not work.** Commands for a tap, registry or URL that does not exist yet. Only publish install paths that CI exercises; mark the rest "planned" or leave them out.
- **Hand-drawn ASCII architecture.** Breaks in narrow viewports and in translation tools, and cannot follow the theme. Use SVG via `<picture>`.
- **Placeholder media.** Commented-out "launch GIF goes here". Ship the image or omit the slot.
- **Internal caveats in the hero.** "Working name" above the fold tells the reader the project is not ready. Move to the FAQ or CONTRIBUTING.
- **Sponsor and hiring blocks above the content** (Caddy sponsor, PostHog hiring). Not relevant yet; if ever, they go last.
- **Repo-tour tables as the pitch.** A path/stack table is contributor material. It belongs under "Repository layout" near the end.
- **Consecutive or decorative alerts.** GitHub's own docs say to avoid stacking them. One, maybe two, in the whole file.

## 3. Explaining a trust model

What the security-tool READMEs and docs do that we should copy:

- **Name the adversary and say what it can do.** Tailscale's [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock) doc writes about itself as the threat: "If Tailscale were malicious, and stealthily inserted new nodes into your network...", then the guarantee: "Even if Tailscale were malicious or Tailscale infrastructure hacked, attackers can't send or receive traffic in your tailnet." Our equivalent is a small table: *a compromised server / a malicious maintainer / a malicious task / a compromised backer machine* against *can* and *cannot*.
- **Give the verify command, with the key inline.** [minisign](https://github.com/jedisct1/minisign) shows `minisign -Vm file.txt -P RWQf6LRC...` with its release key printed in the README. AgentFund already signs `MANIFEST.lock` with minisign, so the README can show the exact command a backer runs without our binary, and say that `agentfund approve` does the same thing.
- **Three commands, start to finish.** [age](https://github.com/FiloSottile/age) opens usage with keygen, encrypt, decrypt. Ours: `approve`, `work`, and a `verify`-style command that re-checks a ledger entry against the PR and CI run.
- **Explain what the proof proves and what it does not.** [cosign](https://github.com/sigstore/cosign) lists the checks performed on verify, then warns to sign digests, not tags, "because otherwise you might sign something you didn't intend to". Ours: the signature proves the maintainer's key approved these task files at this commit. It does not prove the tasks are safe or the code is good; CI and human review cover that.
- **Accountability by public log.** age's [SIGSUM.md](https://github.com/FiloSottile/age/blob/main/SIGSUM.md) frames proofs as "signatures with extra transparency" so the project "can be held accountable for every binary release". [Let's Encrypt](https://letsencrypt.org/2014/11/18/announcing-lets-encrypt/) promised that "all records of certificate issuance and revocation will be available to anyone who wishes to inspect them." This is the framing for the ledger: delivered tokens are a public, re-derivable record, not a number the operator asserts.
- **State residual risk plainly, with the user's own responsibility.** Tailnet Lock: "keys are stored on the device. If the device is compromised, the key can be obtained." fly.io's [architecture doc](https://docs.fly.io/reference/architecture) says "best-effort" where it means best-effort. We say what Docker isolation does not cover and that the backer's budget cap is the hard stop.
- **Voice.** Stripe and fly.io docs use second person, imperative steps, and values the reader can run immediately. Short declaratives; "we" for the project, "you" for the reader; no hedging adverbs.

## 4. Crowdfunding page anatomy

Kickstarter's own pages returned HTTP 403 to our fetcher, so the layout below is from memory and
secondary sources (**unverified** against the live site). The "Risks and challenges" requirement
(mandatory since September 2012: state the risks and what qualifies you to overcome them) is
confirmed by [contemporary coverage](https://www.nbcnews.com/news/amp/wbna49239491). Open
Collective describes itself as "fully transparent (you can see where money comes from and where it
goes)" ([docs](https://docs.opencollective.com/help/about/introduction)).

| Crowdfunding element | What it does | README mapping |
| --- | --- | --- |
| Title + one-line blurb + hero media | Decide in five seconds whether to keep reading | Tagline, one sentence, demo image |
| Pledged / goal / backers / time left | Momentum and social proof in four numbers | A live strip for the demo project: tokens delivered / goal, tasks merged / total, backers. Linked to the ledger. If it is a static image, date it. |
| "Back this project" button | One obvious action | The install + `approve` + `work` block |
| Story: who, what, why now | The reason to care | "Why this exists" (short), then "How it works" |
| Reward tiers | What a given pledge buys | What a budget buys: "200M tokens is roughly N tasks of this size", with real figures from the demo project |
| Risks and challenges | Honesty builds trust; names what could fail | "Risks and limits" section |
| Updates | Evidence the project is alive | Link to CHANGELOG and the ledger's recent activity; no hand-maintained news |
| Backer list | Recognition | Backers on the project page, not in the README |
| Transparent budget (Open Collective) | Every contribution and expense is public | The ledger: each entry links to a PR and a CI run; "delivered" only after CI passes |

What does not transfer: countdown urgency, stretch goals, and reward scarcity. They read as
manipulation in an open-source README.

## 5. GitHub rendering facts

Sources: GitHub docs (linked), plus three checks run on 2026-10-06: (A) a test document rendered
through `POST https://api.github.com/markdown` in `gfm` mode, which is the closest public proxy for
the README pipeline; (B) the served HTML and CSS of live repo pages; (C) response headers for an SVG
served from `raw.githubusercontent.com`.

| Feature | Syntax | Caveat | Source |
| --- | --- | --- | --- |
| Light/dark image | `<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><source media="(prefers-color-scheme: light)" srcset="light.svg"><img alt="..." src="light.svg"></picture>` | Documented method. GitHub wraps it in a `<themed-picture>` element (seen in A and B). That it follows the GitHub theme setting rather than the OS is inferred from the wrapper and the changelog wording; **unverified** in a browser. Always include the fallback `<img>` with `alt`. | [quickstart](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/quickstart-for-writing-on-github), [changelog 2022-05-19](https://github.blog/changelog/2022-05-19-specify-theme-context-for-images-in-markdown-beta/) |
| `#gh-dark-mode-only` / `#gh-light-mode-only` | `<img src="x.png#gh-dark-mode-only">` | Still works: the rule is in GitHub's current global CSS, keyed on `data-color-mode` for `.readme` (B), and vhs and supabase still use it. No longer in the docs. Breaks outside github.com (both images show). Prefer `<picture>`. | check B |
| Alerts | `> [!NOTE]` then `> text` | Exactly five: NOTE, TIP, IMPORTANT, WARNING, CAUTION. "Alerts cannot be nested within other elements"; avoid placing them consecutively. | [basic syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts) |
| Mermaid | fenced block with language `mermaid` | Rendered client-side in an iframe from `viewscreen.githubusercontent.com` (A). Docs say nothing about theming. Dark-mode behaviour is **unverified**; secondary reports say it adapts automatically and that custom fills or `init` themes can become unreadable. Shows as a code block off GitHub. Do not use for the hero. | [creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) |
| Collapsible | `<details><summary>...</summary>` blank line, content, `</details>` | Survives, including `open` (A). Leave a blank line after `<summary>` so Markdown inside is parsed. | check A |
| Stripped | `style="..."`, `class`, `bgcolor`, `target` on links; `<style>`, `<script>`, `<iframe>` (shown as literal text); `<video>` and inline `<svg>` (removed) | No CSS of any kind. Layout is limited to attributes below. | check A; [github/markup](https://github.com/github/markup#github-markup) ("inline-styles, and `class` or `id` attributes") |
| Survives | `align` on `p`, `div`, `h1`, `img`; `width`, `height` on `img`, `table`, `td`; `valign`; `<kbd>`, `<sub>`, `<br clear>`, `<span title>` | `id` and `name` are kept but rewritten with a `user-content-` prefix. Images get `max-width: 100%` and an auto-wrapping link. | check A |
| Centering and sizing | `<p align="center"><img src="..." width="600"></p>` | Works (A). `width` accepts pixels or percent; set `width`, not `height`, so it scales on mobile. | check A |
| Relative image paths | `![alt](docs/assets/x.svg)` or `<img src="docs/assets/x.svg">` | Recommended by GitHub; resolved per branch. Break on npm, Docker Hub, and other mirrors, which need absolute URLs. | [basic syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#relative-links) |
| SVG via `<img>` | any committed `.svg` | Renders. Served with `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (C): inline `<style>` works; scripts, external fonts, external images and external stylesheets do not. Use system font stacks or convert text to paths. | check C |
| `prefers-color-scheme` inside an SVG | `@media (prefers-color-scheme: dark)` in the SVG's `<style>` | An SVG loaded as an image evaluates the query against the browser/OS, not the GitHub theme. A user with a light OS and dark GitHub theme gets a light image on a dark page. Reported not to switch in the GitHub mobile apps. Not GitHub-documented and not re-tested by us: **unverified**, but treat as true and ship two files in `<picture>`. | [write-up](https://dev.to/grahamthedev/take-your-github-readme-to-the-next-level-responsive-and-light-and-dark-modes--3kpc) |
| `<foreignObject>` in SVG | HTML inside the SVG | Reported to render in `<img>` context with inline CSS only. Text wrapping varies by browser. **Unverified**; avoid for anything that must be legible. | same |
| Inline `<svg>` in Markdown | `<svg>...</svg>` | Removed entirely. | check A |
| Video | `<video src="docs/demo.mp4">`, or a bare `docs/demo.mp4` | `<video>` is removed and a bare repo path stays plain text (A). `raw.githubusercontent.com` is not in github.com's `media-src` CSP (C), so repo-hosted video cannot play inline. A bare `https://github.com/user-attachments/assets/...` URL from a drag-and-drop upload is widely reported to render a player in READMEs; the API left it as a link and we found no live example: **unverified**. Use a GIF or animated SVG and link to the video. | check A, C |
| Upload limits | drag-and-drop in issues, PRs, comments, discussions | Images and GIFs 10 MB; video 10 MB on free plans, 100 MB on paid; other files 25 MB. H.264 recommended. The docs do not list README files as an upload target. | [attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) |
| Committed GIF size | `![demo](docs/assets/demo.gif)` | No documented display limit for images committed to the repo: **unverified**. Target under 2-3 MB and about 800 px wide for load time. | none |
| README size | - | Content beyond 500 KiB is truncated. Lookup order: `.github/`, root, `docs/`. Table of contents is generated automatically. | [about READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) |
| Social preview | repo Settings | PNG, JPG or GIF under 1 MB; "at least 640 by 320 pixels (1280 by 640 pixels for best display)". Use a solid background. | [social preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) |

## 6. Resulting README outline

1. **Hero** - centered wordmark via `<picture>`, tagline, one sentence naming maintainer, backer and server; at most three badges. *Five-second test.*
2. **Demo** - one terminal capture of `agentfund work` generated from a committed tape, with a one-line caption stating what to notice. *Proof before prose.*
3. **Live numbers** - delivered / goal, tasks merged, backers for the demo project, linked to its ledger. *The Kickstarter strip; makes the idea concrete and checkable.*
4. **Back a project in three commands** - install, `approve`, `work --budget`. Only commands CI runs. *The single call to action.*
5. **How it works** - light/dark SVG of the four parts, then four numbered steps. *Replaces the ASCII diagram and the repo table.*
6. **Trust the artifacts, not the operator** - the can / cannot table per compromised party, followed by the verify-it-yourself commands (plain `minisign`, then ours). *This is the differentiator; it gets the most care.*
7. **Risks and limits** - what the sandbox, signature and CI gate do not cover; what is alpha. *Honesty section; cosign and Kickstarter both do this.*
8. **For maintainers** - split, sign, publish in a short block; link to `docs/maintainers.md`. *Second audience, kept below the backer path.*
9. **Self-host the server** - `docker compose up`, one scale caveat, link to `docs/self-hosting.md`. *Supports "not the operator".*
10. **Why this exists** - five bold principles, one sentence each. *Movement framing, placed after the reader has seen it work.*
11. **Repository layout, contributing, security, license** - the current path/stack table lives here, inside `<details>` if long. *Contributor material last.*

## 7. What shipped, and where it departs from the outline

Written after the rewrite, so the notes above stay an honest record of the research rather than
a description of the result.

- **Tagline.** The research favoured keeping "Fund open source with inference, not money." The
  README leads with "Kickstarter for LLMs" as the hook and "Back open source with tokens, not
  money." as the sentence: *back* is the crowdfunding verb, *tokens* is the word backers use.
- **Hero.** A PNG rendered from HTML in the web UI's own fonts and tokens
  (`scripts/readme-brand.mjs`), not an SVG: repository SVGs cannot load fonts, and the wordmark
  should match the product. Its right-hand panel is the ledger's four columns, the one idea a
  reader must leave with. Diagrams are SVG pairs with system font stacks (`scripts/readme-diagrams.py`).
- **Proof under the tagline.** Two recordings from one real session instead of one image: the
  terminal (`docs/assets/tapes/demo.tape`) and that instance's project page, cut to the same
  length so the loops stay in step. The "live numbers strip" for gridrs waits until gridrs has
  numbers; the README says the counter starts at zero.
- **First command.** `make demo`, not install-approve-work, because no release exists yet and
  an install line that fails is the worst first impression. The three real paths follow under
  Quickstart, each from a checkout.
- **Mermaid** is not used anywhere, for the theming reasons in section 5.
- **Badges.** Three: CI, license, spec version. The CI badge is the only one that depends on
  the repository slug; it is defined once at the bottom of the README.
- **Alerts.** None in the README. One or two per guide, for things that cost tokens or keys.
- **Risks.** "What it does not protect you from" sits directly under the trust table, and
  Status is its own section with one row per claim so a single line can be updated.
- **Checked, not asserted.** `scripts/check-docs.sh` verifies links, anchors, every
  `agentfund` subcommand and flag, and every `make` target the docs mention.

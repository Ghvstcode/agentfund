# AgentFund web UI

The browser interface of AgentFund: discover projects, watch tokens being delivered live, back a
project with your own worker, audit everything.

It is a static single-page app (React, Vite, TypeScript) that talks **only** to the public v1 API
described in [`spec/openapi.yaml`](../spec/openapi.yaml). There are no private endpoints, so
anyone can host this UI, or a fork of it, against any AgentFund instance.

## Develop

```sh
pnpm install
pnpm --filter web dev:mock     # UI on :5173 against a built-in mock API on :8788
pnpm --filter web dev          # UI on :5173 against VITE_API_BASE_URL (default: same origin)
```

The mock API (`dev/mock-api.mjs`, no dependencies) serves every endpoint in the OpenAPI shapes
and a live stream that simulates workers. Add `?scenario=` to any page URL to switch data sets;
the choice sticks for the tab:

| Scenario | What you see |
| --- | --- |
| `many` (default) | 14 projects in every state, live activity |
| `one` | an instance with a single project |
| `empty` | a brand-new instance: no projects, no donors |
| `error` | every request fails |
| `loading` | requests never answer, so skeletons stay up |

In the mock, "Continue with GitHub" signs you in as `ada` (an admin), and dev login accepts any
handle.

| Script | Does |
| --- | --- |
| `dev`, `dev:mock` | development servers |
| `build` | production build into `web/dist` |
| `preview` | serve the build locally |
| `test` | Vitest + Testing Library |
| `lint` | ESLint and `tsc --noEmit` |
| `gen:api` | regenerate `src/api/schema.d.ts` from the spec |
| `check:api` | fail if the generated types are stale (also part of `test`) |
| `screenshots` | every page × theme × viewport × state into `dev/screenshots/` |
| `audit` | Lighthouse and axe against the production build, reports in `dev/reports/` |

`src/api/schema.d.ts` is generated and committed, so a build needs nothing but `pnpm install`.
After changing the spec, run `pnpm --filter web gen:api` and commit the result.

## Host it standalone

The build is a folder of static files. Point it at an instance and put it on any static host.

```sh
VITE_API_BASE_URL=https://fund.example.org pnpm --filter web build
# upload web/dist
```

1. **API base URL.** `VITE_API_BASE_URL` is the only required setting. Leave it empty when the
   UI is served from the same origin as the API.
2. **Single-page fallback.** Serve `index.html` for any path that is not a file (`/gridrs`,
   `/u/ada`, …). On most hosts this is a "rewrite everything to /index.html" rule.
3. **Sign-in.** The instance must allow your UI's origin as an OAuth redirect target; ask its
   operator to add it to the allow-list. The UI sends visitors to
   `<api>/v1/auth/github/start?redirect=<your origin>/auth/callback`.
4. **CORS.** The instance must allow your origin for `/v1/*`, including the event stream.

### Runtime configuration

A server that serves `index.html` itself can configure the UI without rebuilding it, by defining
a global before the app script runs. The reference server injects this at the `<!--app-head-->`
marker in `index.html`, together with per-route title, description, OpenGraph and JSON-LD tags:

```html
<script>
  window.__AGENTFUND__ = { apiBase: '' }; // '' = same origin; overrides VITE_API_BASE_URL
</script>
```

| Key | Build-time equivalent | Meaning |
| --- | --- | --- |
| `apiBase` | `VITE_API_BASE_URL` | API origin |
| `installCommand` | `VITE_INSTALL_COMMAND` | the worker install one-liner shown in "Back with tokens" |
| `sourceUrl` | `VITE_SOURCE_URL` | the "Source" link in the footer |

Keep the `<!--app-head-->` marker inside `<head>` if you edit `index.html`. Without a server
that fills it, the static title and description in the file are used.

The software name is the constant `APP_NAME` in `src/config.ts`. The instance's own display name
comes from `GET /v1/meta`.

## Restyle it

The interface is built on [shadcn/ui](https://ui.shadcn.com): Tailwind CSS v4 and Radix
primitives, with the components vendored into `src/components/ui/` (add more with
`pnpm dlx shadcn@latest add <name>`; `components.json` holds the setup).

The whole theme is the block of CSS variables at the top of
[`src/index.css`](src/index.css): `:root` is the light palette, `.dark` the dark one. They are
shadcn's standard tokens (`--background`, `--card`, `--muted-foreground`, `--border`,
`--primary`, `--radius`, ...) plus four of our own:

| Variable | Meaning |
| --- | --- |
| `--live`, `--live-foreground` | The one accent. Used only for live values and progress. |
| `--shadow-card`, `--shadow-raised` | Elevation of cards and of overlays |
| `--highlight` | The inner top edge on raised surfaces |

Change a value there and every page follows; nothing else hard-codes a colour, radius or font.
Open `/styleguide` in the running app to see each token and every component in every state
while you edit. Any theme from the shadcn theme generator can be pasted over the two blocks.

- **Dark mode** follows the system setting; the header toggle overrides it per device.
- **Accent.** Keep 4.5:1 contrast for `--live` against `--background` and `--card` in both
  palettes, and against its own 8% tint: it is used for small text.
- **Fonts.** Geist and Geist Mono, self-hosted (the app makes no third-party requests). Change
  `--font-sans` / `--font-mono` in the `@theme` block and the `@font-face` rules in
  `src/styles/fonts.css`. Every number, hash, commit and key uses the mono face with tabular
  figures through the `.num` class.
- **Avatars** are generated from the handle (`src/components/HandleAvatar.tsx`); no image is
  ever fetched.

After a restyle, run `pnpm --filter web build && pnpm --filter web audit` to confirm contrast and
the other accessibility checks still pass.

## Layout

```
src/
  index.css         the theme (CSS variables), Tailwind setup, the few hand-written classes
  api/              generated types, typed client, query hooks
  lib/              formatting, odometer maths, live stream, series, session, theme (no React)
  hooks/            React bindings for the above
  components/ui/    shadcn/ui components, vendored
  components/       ours: TokenCounter, FundingBar, Sparkline, Dialog, CommandPalette, …
  pages/            one file per route; project/ holds the project page and its tabs
dev/                mock API, screenshot and audit scripts
```

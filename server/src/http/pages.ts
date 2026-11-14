/** Non-API public routes (protocol.md §12): health, sitemap, feed, OG cards and the built SPA. */
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { APP_NAME, VERSION } from "../constants.js";
import type { AppContext } from "../context.js";
import { iso, num, rows } from "../db/client.js";
import { PROBLEM_CODES, problemInfo, type ProblemCode } from "../lib/problem.js";
import { recentFeedEvents } from "../services/events.js";
import { getInstance } from "../services/instance.js";
import { taskCounts, totals } from "../services/ledger.js";
import { renderOgCard } from "../services/og.js";
import { getProjectRow } from "../services/projects.js";

const MARKER = "<!--app-head-->";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
};

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** JSON safe to embed in a <script> element. */
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

interface Head {
  title: string;
  description: string;
  url: string;
  image?: string;
  type: "website" | "profile";
  noindex?: boolean;
  jsonLd?: Record<string, unknown>;
}

function headTags(ctx: AppContext, instanceName: string, h: Head): string {
  const tags = [
    `<title>${esc(h.title)}</title>`,
    `<meta name="description" content="${esc(h.description)}">`,
    h.noindex ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${esc(h.url)}">`,
    `<link rel="alternate" type="application/atom+xml" title="${esc(instanceName)}" href="${esc(ctx.config.baseUrl)}/feed.atom">`,
    `<meta property="og:site_name" content="${esc(instanceName)}">`,
    `<meta property="og:type" content="${h.type}">`,
    `<meta property="og:title" content="${esc(h.title)}">`,
    `<meta property="og:description" content="${esc(h.description)}">`,
    `<meta property="og:url" content="${esc(h.url)}">`,
    `<meta name="twitter:card" content="${h.image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(h.title)}">`,
    `<meta name="twitter:description" content="${esc(h.description)}">`,
  ];
  if (h.image) {
    tags.push(`<meta property="og:image" content="${esc(h.image)}">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`, `<meta name="twitter:image" content="${esc(h.image)}">`);
  }
  if (h.jsonLd) tags.push(`<script type="application/ld+json">${scriptJson(h.jsonLd)}</script>`);
  // Runtime config: the same built SPA works on any instance without a rebuild.
  tags.push(`<script>window.__AGENTFUND__=${scriptJson({ apiBase: "", baseUrl: ctx.config.baseUrl, appName: APP_NAME, instanceName, version: VERSION })}</script>`);
  return tags.join("\n    ");
}

/** Single-segment UI routes with no sub-paths, and prefixes whose sub-paths belong to the UI (web/src/App.tsx). */
const UI_EXACT = new Set(["donors", "settings", "maintain", "admin", "styleguide"]);
const UI_PREFIX = new Set(["maintain", "admin", "styleguide"]);
const PROJECT_TABS = new Set(["activity", "donors", "audit"]);

/**
 * Head tags for a path, and whether the path is a real page. Unknown projects, donors, tasks
 * and paths outside the UI's routes still get the SPA shell (it renders its own "not found"),
 * but with status 404 and `noindex`, so crawlers do not see soft 404s.
 */
async function headFor(ctx: AppContext, path: string): Promise<{ head: Head; instanceName: string; found: boolean }> {
  const instance = await getInstance(ctx.db);
  const base = ctx.config.baseUrl;
  const url = `${base}${path === "/" ? "" : path}`;
  const generic: Head = { title: instance.name, description: instance.description, url: url || base, type: "website" };
  const home: Head = { ...generic, jsonLd: { "@context": "https://schema.org", "@type": "WebSite", name: instance.name, description: instance.description, url: base } };
  const missing = { instanceName: instance.name, found: false, head: { ...generic, title: `Not found · ${instance.name}`, description: "This page does not exist.", noindex: true } };
  const segments = path.split("/").filter(Boolean);
  const [first, second, third] = segments;
  if (!first) return { head: home, instanceName: instance.name, found: true };
  if ((segments.length === 1 && UI_EXACT.has(first)) || (segments.length > 1 && UI_PREFIX.has(first)) || (first === "auth" && second === "callback" && segments.length === 2)) {
    // App screens (settings, admin, …) are real pages but nothing a crawler should index.
    return { head: { ...generic, noindex: first !== "donors" }, instanceName: instance.name, found: true };
  }
  if (first === "u") {
    if (segments.length !== 2 || !second || !/^[a-z0-9][a-z0-9-]{0,38}(@[a-z0-9.-]{1,253}(:[0-9]{1,5})?)?$/.test(second)) return missing;
    const [user] = await rows<{ handle: string; avatar_url: string | null }>(ctx.db, sql`SELECT handle, avatar_url FROM users WHERE handle = ${second} AND NOT banned`);
    if (!user) return missing;
    const description = `${user.handle}'s delivered and merged agent work on ${instance.name}.`;
    return {
      instanceName: instance.name,
      found: true,
      head: { title: `${user.handle} · ${instance.name}`, description, url, type: "profile", jsonLd: { "@context": "https://schema.org", "@type": "ProfilePage", url: `${base}/u/${user.handle}`, mainEntity: { "@type": "Person", name: user.handle, identifier: `${base}/u/${user.handle}`, ...(user.avatar_url ? { image: user.avatar_url } : {}) } } },
    };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(first)) return missing;
  const p = await getProjectRow(ctx.db, first);
  // Pending and removed projects are not public; their maintainer still reaches them in the app.
  if (!p || (p.status !== "active" && p.status !== "paused")) return missing;
  if (segments.length === 2 && !PROJECT_TABS.has(second!)) return missing;
  if (segments.length === 3) {
    if (second !== "tasks" || !third) return missing;
    const [task] = await rows<{ id: string }>(ctx.db, sql`SELECT id FROM manifests WHERE project_id = ${p.id} AND manifest_id = ${third}`);
    if (!task) return missing;
  }
  if (segments.length > 3) return missing;
  return {
    instanceName: instance.name,
    found: true,
    head: {
      title: `${p.name} · ${instance.name}`,
      description: p.description,
      url,
      image: `${base}/og/${p.slug}.png`,
      type: "website",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name: p.name,
        description: p.description,
        url: `${base}/${p.slug}`,
        codeRepository: p.repoUrl,
        ...(p.language ? { programmingLanguage: p.language } : {}),
        ...(p.tags.length ? { keywords: p.tags.join(", ") } : {}),
        dateCreated: p.createdAt.toISOString(),
      },
    },
  };
}

function placeholder(ctx: AppContext, head: string, instanceName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${head}
    <style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:15vh auto;padding:0 1.5rem;color:#0b0b0c}code{font-family:ui-monospace,monospace;background:#f4f4f5;padding:.1em .3em}a{color:inherit}</style>
  </head>
  <body>
    <h1>${esc(instanceName)}</h1>
    <p>The ${esc(APP_NAME)} API is running, but no web UI build was found at <code>WEB_DIST</code>.</p>
    <p>API: <a href="/v1/meta"><code>/v1/meta</code></a> · <a href="/v1/projects"><code>/v1/projects</code></a> · <a href="/healthz"><code>/healthz</code></a></p>
  </body>
</html>
`;
}

/**
 * Puts the per-route head into the SPA shell: at the marker, else before </head>.
 * The shell's own build-time title, description, canonical, OpenGraph and Twitter tags are
 * dropped first, so crawlers never see two competing sets.
 */
export function injectHead(shell: string, head: string): string | null {
  const strip = (s: string) =>
    s
      .replace(/<title>[\s\S]*?<\/title>[ \t]*\n?/gi, "")
      .replace(/[ \t]*<meta\s+[^>]*?(?:name|property)\s*=\s*["'](?:description|robots|og:[^"']*|twitter:[^"']*)["'][^>]*>[ \t]*\n?/gi, "")
      .replace(/[ \t]*<link\s+[^>]*?rel\s*=\s*["']canonical["'][^>]*>[ \t]*\n?/gi, "");
  if (shell.includes(MARKER)) return strip(shell).replace(MARKER, head);
  if (/<\/head>/i.test(shell)) return strip(shell).replace(/<\/head>/i, `${head}\n  </head>`);
  return null;
}

export function registerPages(app: Hono, ctx: AppContext): void {
  const root = resolve(ctx.config.webDist);
  let shell: { mtimeMs: number; html: string } | null = null;
  const readShell = (): string | null => {
    const file = join(root, "index.html");
    try {
      const st = statSync(file);
      if (!shell || shell.mtimeMs !== st.mtimeMs) shell = { mtimeMs: st.mtimeMs, html: readFileSync(file, "utf8") };
      return shell.html;
    } catch {
      return null;
    }
  };

  app.get("/healthz", async (c) => {
    try {
      await ctx.db.execute(sql`SELECT 1`);
      return c.json({ status: "ok", app: APP_NAME, version: VERSION });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /v1/\nSitemap: ${ctx.config.baseUrl}/sitemap.xml\n`));

  app.get("/problems/:code", (c) => {
    const code = c.req.param("code") as ProblemCode;
    if (!PROBLEM_CODES.includes(code)) return c.json({ error: "unknown problem code" }, 404);
    return c.json({ code, ...problemInfo(code), documentation: "spec/protocol.md §11" });
  });

  app.get("/sitemap.xml", async (c) => {
    const base = ctx.config.baseUrl;
    const list = await rows<{ slug: string; at: string }>(
      ctx.db,
      sql`SELECT p.slug, coalesce((SELECT max(at) FROM events WHERE project_id = p.id AND public), p.created_at) AS at
          FROM projects p WHERE p.status IN ('active', 'paused') ORDER BY p.id LIMIT 45000`,
    );
    const donors = await rows<{ handle: string }>(
      ctx.db,
      sql`SELECT DISTINCT u.handle FROM users u JOIN reports r ON r.user_id = u.id WHERE r.delivered_at IS NOT NULL AND NOT u.banned ORDER BY u.handle LIMIT 4000`,
    );
    const urls = [
      `<url><loc>${esc(base)}/</loc></url>`,
      ...list.map((p) => `<url><loc>${esc(`${base}/${p.slug}`)}</loc><lastmod>${iso(p.at)}</lastmod></url>`),
      ...donors.map((d) => `<url><loc>${esc(`${base}/u/${d.handle}`)}</loc></url>`),
    ];
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" });
  });

  app.get("/feed.atom", async (c) => {
    const base = ctx.config.baseUrl;
    const instance = await getInstance(ctx.db);
    const events = await recentFeedEvents(ctx, 50);
    const names = new Map<string, string>();
    for (const p of await rows<{ slug: string; name: string }>(ctx.db, sql`SELECT slug, name FROM projects WHERE status IN ('active', 'paused')`)) names.set(p.slug, p.name);
    const entries = events.map((e) => {
      const slug = e.project ?? "";
      const name = names.get(slug) ?? slug;
      const payload = e.payload ?? {};
      const created = e.action === "project.created";
      const title = created ? `New project: ${name}` : `Delivered: ${e.task_id ?? slug} (${num(payload.tokens as number | undefined).toLocaleString("en-US")} tokens${typeof payload.donor === "string" ? ` by ${payload.donor}` : ""})`;
      const link = `${base}/${slug}`;
      const summary = created ? `${name} is now open for agent-time pledges.` : `CI confirmed work on ${e.task_id ?? slug} in ${name}.`;
      return `  <entry>\n    <id>${esc(`${base}/events/${e.public_id}`)}</id>\n    <title>${esc(title)}</title>\n    <updated>${iso(e.at)}</updated>\n    <link rel="alternate" href="${esc(link)}"/>\n    <author><name>${esc(e.actor ?? instance.name)}</name></author>\n    <category term="${created ? "project" : "delivery"}"/>\n    <summary>${esc(summary)}</summary>\n  </entry>`;
    });
    const updated = events[0] ? iso(events[0].at) : instance.createdAt.toISOString();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <id>${esc(base)}/</id>\n  <title>${esc(instance.name)}</title>\n  <subtitle>${esc(instance.description)}</subtitle>\n  <updated>${updated}</updated>\n  <link rel="self" href="${esc(base)}/feed.atom"/>\n  <link rel="alternate" href="${esc(base)}/"/>\n  <generator version="${esc(VERSION)}">${esc(APP_NAME)}</generator>\n${entries.join("\n")}\n</feed>\n`;
    return c.body(xml, 200, { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=120" });
  });

  app.get("/og/:file", async (c) => {
    const m = /^([a-z0-9][a-z0-9-]{0,62})\.png$/.exec(c.req.param("file"));
    const p = m ? await getProjectRow(ctx.db, m[1]!) : undefined;
    if (!p || (p.status !== "active" && p.status !== "paused")) return c.text("Not found", 404);
    const [instance, t, counts] = await Promise.all([getInstance(ctx.db), totals(ctx.db, p.id), taskCounts(ctx.db, p.id)]);
    const { png, etag } = await renderOgCard({
      instance: instance.name,
      slug: p.slug,
      name: p.name,
      description: p.description,
      language: p.language,
      pledged: t.pledged,
      delivered: t.delivered,
      merged: t.merged,
      goal: p.tokenGoal,
      tasksMerged: counts.merged,
      tasksTotal: counts.open + counts.claimed + counts.delivered + counts.merged,
    });
    const headers = { etag, "cache-control": "public, max-age=300", "content-type": "image/png" };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(png), 200, headers);
  });

  const spa = async (c: Context): Promise<Response> => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Not found", 404);
    }
    if (path.split("/").includes("..") || path.includes("\0") || path.includes("\\")) return c.text("Not found", 404);
    if (path !== "/" && existsSync(root)) {
      const file = normalize(join(root, path));
      if (file.startsWith(root + sep) && extname(file) && file !== join(root, "index.html")) {
        try {
          if (statSync(file).isFile()) {
            const immutable = path.startsWith("/assets/");
            return c.body(new Uint8Array(await readFile(file)), 200, {
              "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
              "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
            });
          }
        } catch {
          /* fall through to 404 / history fallback */
        }
      }
    }
    // Anything that looks like a file but is not there is a real 404, not the app shell.
    // A federated donor's profile, /u/alice@fund.example, ends in a host name, not a file extension.
    const profile = /^\/u\/[^/]+@[^/]+$/.test(path);
    if (extname(path) && !path.endsWith(".html") && !profile) return c.text("Not found", 404);
    const { head, instanceName, found } = await headFor(ctx, path.replace(/\/+$/, "") || "/");
    const tags = headTags(ctx, instanceName, head);
    const html = readShell();
    const page = (html && injectHead(html, tags)) ?? placeholder(ctx, tags, instanceName);
    return c.html(page, found ? 200 : 404, { "cache-control": "no-cache" });
  };
  app.get("*", spa);
}

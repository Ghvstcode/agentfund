import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectHead } from "../src/http/pages.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { claim, genericCi, reportCompleted, setupProject } from "./helpers/scenario.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  const { repo } = await setupProject(t, "gridrs", [{ id: "0001-a" }, { id: "0002-b" }]);
  const d = await t.donor("paula");
  await t.call("createPledge", { token: d.key, path: { slug: "gridrs" }, body: { token_amount: 700_000 } });
  const c = await claim(t, d.key, "gridrs:0001-a");
  const r = await reportCompleted(t, d.key, c);
  await genericCi(t, repo.url, r, { conclusion: "success" });
});
afterAll(async () => {
  await t.close();
});

describe("non-API public routes", () => {
  it("/healthz", async () => {
    const res = await t.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("/sitemap.xml lists the home page, projects and donors with deliveries", async () => {
    const res = await t.request("/sitemap.xml");
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<loc>http://af.test/</loc>");
    expect(xml).toContain("<loc>http://af.test/gridrs</loc>");
    expect(xml).toContain("<loc>http://af.test/u/paula</loc>");
    expect(xml).toMatch(/<lastmod>\d{4}-\d\d-\d\dT/);
  });

  it("/feed.atom has new projects and completed deliveries", async () => {
    const res = await t.request("/feed.atom");
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<title>New project: gridrs</title>");
    expect(xml).toMatch(/<title>Delivered: gridrs:0001-a \(100,000 tokens by paula\)<\/title>/);
    expect(xml.match(/<entry>/g)).toHaveLength(2);
    expect(xml).toContain('<link rel="alternate" href="http://af.test/gridrs"/>');
  });

  it("/og/<slug>.png renders a 1200×630 PNG, cached by what it shows", async () => {
    const res = await t.request("/og/gridrs.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(png.length).toBeGreaterThan(5_000);
    const etag = res.headers.get("etag")!;
    const again = await t.request("/og/gridrs.png", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    // Totals change → new card.
    const d = await t.donor("og-pledger");
    await t.call("createPledge", { token: d.key, path: { slug: "gridrs" }, body: { token_amount: 1 } });
    const fresh = await t.request("/og/gridrs.png", { headers: { "if-none-match": etag } });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).not.toBe(etag);
    expect((await t.request("/og/unknown-project.png")).status).toBe(404);
    expect((await t.request("/og/..%2f..%2fetc.png")).status).toBe(404);
  }, 60_000);

  it("unknown API paths are problems, never the SPA shell", async () => {
    for (const [path, method] of [["/v1/nope", "GET"], ["/v1", "GET"], ["/v1/meta", "DELETE"], ["/v1/projects/gridrs/unknown", "POST"]] as const) {
      const res = await t.request(path, { method });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(((await res.json()) as { type: string }).type).toBe("http://af.test/problems/not-found");
    }
    const code = await t.request("/problems/task-not-open");
    expect(await code.json()).toMatchObject({ code: "task-not-open", status: 409 });
  });

  it("without a web build, serves a placeholder that still carries meta tags and the API links", async () => {
    const res = await t.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("no web UI build was found");
    expect(html).toContain("/v1/meta");
    expect(html).toContain("window.__AGENTFUND__=");
  });
});

describe("serving the built SPA", () => {
  let w: TestApp;
  let dist: string;
  beforeAll(async () => {
    w = await createTestApp();
    dist = w.config.webDist;
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <title>build-time title</title>\n    <!--app-head-->\n    <script type="module" src="/assets/app-abc123.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n`);
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log('app')\n");
    writeFileSync(join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await setupProject(w, "gridrs", [{ id: "0001-a" }], { repo: undefined });
    await w.login("some-donor");
  });
  afterAll(async () => {
    await w.close();
  });

  it("serves static files with the right types and cache headers, and refuses path traversal", async () => {
    const js = await w.request("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toContain("console.log");
    const svg = await w.request("/favicon.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("cache-control")).not.toContain("immutable");
    expect((await w.request("/assets/missing.js")).status).toBe(404);
    for (const path of ["/..%2f..%2f..%2fetc%2fpasswd", "/assets/..%2f..%2fpackage.json"]) {
      const res = await w.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  it("history fallback injects per-route title, description, OpenGraph, Twitter and JSON-LD at the marker", async () => {
    const home = await (await w.request("/")).text();
    expect(home).not.toContain("<!--app-head-->");
    expect(home).not.toContain("build-time title");
    expect(home).toContain("<title>AgentFund</title>");
    expect(home).toContain('<meta property="og:type" content="website">');
    expect(home).toContain('"@type":"WebSite"');
    expect(home).toMatch(/<script>window\.__AGENTFUND__=\{"apiBase":"","baseUrl":"http:\/\/af\.test"/);
    expect(home).toContain('<script type="module" src="/assets/app-abc123.js"></script>');
    expect(home.match(/<title>/g)).toHaveLength(1);

    for (const path of ["/gridrs", "/gridrs/tasks/0001-a", "/gridrs/audit", "/gridrs/"]) {
      const res = await w.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("<title>gridrs · AgentFund</title>");
      expect(html).toContain('<meta name="description" content="A demo project for tests.">');
      expect(html).toContain('<meta property="og:image" content="http://af.test/og/gridrs.png">');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]!) as Record<string, unknown>;
      expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "SoftwareSourceCode", name: "gridrs", url: "http://af.test/gridrs", programmingLanguage: "python" });
      expect(String(ld.codeRepository)).toMatch(/^file:\/\//);
    }
    const donor = await (await w.request("/u/some-donor")).text();
    expect(donor).toContain("<title>some-donor · AgentFund</title>");
    expect(donor).toContain('"@type":"ProfilePage"');
    expect(donor).not.toContain("noindex");
  });

  it("no soft 404s: unknown projects, donors, tasks and routes get the shell with status 404 and noindex", async () => {
    for (const path of ["/nope", "/no-such-project/audit", "/u/nobody-here", "/u/ghost@peer.example", "/u", "/u/some-donor/extra", "/gridrs/unknown-tab", "/gridrs/tasks", "/gridrs/tasks/0099-missing", "/gridrs/tasks/0001-a/more", "/some/spa/route", "/donors/extra", "/auth/nope", "/Not_A_Slug"]) {
      const res = await w.request(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('<div id="root"></div>'); // still the app shell
      expect(html).toContain("window.__AGENTFUND__=");
      expect(html).not.toContain('rel="canonical"');
      expect(html).not.toContain("application/ld+json");
    }
    // Every route the UI has is 200.
    for (const path of ["/", "/donors", "/maintain", "/maintain/new", "/settings", "/admin", "/admin/users", "/styleguide", "/styleguide/buttons", "/privacy", "/terms", "/auth/callback", "/u/some-donor", "/gridrs", "/gridrs/activity", "/gridrs/donors", "/gridrs/audit", "/gridrs/tasks/0001-a"]) {
      expect((await w.request(path)).status, path).toBe(200);
    }
    // App screens are real pages but not for indexing; public pages are.
    expect(await (await w.request("/settings")).text()).toContain("noindex");
    expect(await (await w.request("/donors")).text()).not.toContain("noindex");
    for (const path of ["/privacy", "/terms"]) expect(await (await w.request(path)).text(), path).not.toContain("noindex");
    expect(await (await w.request("/privacy")).text()).toContain("<title>Privacy policy · ");
    expect((await w.request("/privacy/extra")).status).toBe(404);
    // A project that is not public is a 404 to crawlers.
    const admin = await w.login("gridrs-owner");
    await w.call("adminUpdateProject", { token: admin, path: { slug: "gridrs" }, body: { status: "removed" } });
    expect((await w.request("/gridrs")).status).toBe(404);
    await w.call("adminUpdateProject", { token: admin, path: { slug: "gridrs" }, body: { status: "active" } });
    expect((await w.request("/gridrs")).status).toBe(200);
  });

  it("escapes instance and project text in the head", async () => {
    const admin = await w.login("gridrs-owner");
    await w.call("adminUpdateInstance", { token: admin, body: { name: `Fund "</title><script>alert(1)</script>`, description: "a & b </script>" } });
    const html = await (await w.request("/")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<\/script>\s*"/);
    const cfg = /window\.__AGENTFUND__=(\{.*?\})<\/script>/.exec(html)![1]!;
    expect((JSON.parse(cfg) as { instanceName: string }).instanceName).toBe(`Fund "</title><script>alert(1)</script>`);
  });

  it("injectHead falls back to </head> when the marker is missing, and gives up without a head", () => {
    expect(injectHead("<html><head><title>x</title></head><body></body></html>", "<title>y</title>")).toBe("<html><head><title>y</title>\n  </head><body></body></html>");
    expect(injectHead("<div>no head at all</div>", "<title>y</title>")).toBeNull();
  });

  it("injectHead drops the shell's build-time SEO tags so only one set remains", () => {
    const shell = `<head>\n    <meta charset="utf-8" />\n    <meta\n      name="description"\n      content="static"\n    />\n    <meta property="og:title" content="static" />\n    <meta name="twitter:card" content="summary" />\n    <link rel="canonical" href="https://static.example/" />\n    <meta name="theme-color" content="#fff" />\n    <!--app-head-->\n  </head>`;
    const out = injectHead(shell, '<title>dyn</title>\n    <meta name="description" content="dyn">')!;
    expect(out).not.toContain("static");
    expect(out.match(/name="description"/g)).toHaveLength(1);
    expect(out).toContain('<meta charset="utf-8" />');
    expect(out).toContain('<meta name="theme-color" content="#fff" />');
    expect(out).toContain("<title>dyn</title>");
  });
});

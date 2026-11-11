import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { clientIp } from "../src/http/middleware.js";
import { friendlyGitMessage, parseRepoUrl } from "../src/lib/git.js";
import { validateAgentfund, validateManifest } from "../src/lib/schemas.js";
import { parseStrictYaml } from "../src/lib/yaml.js";
import { streakDays } from "../src/services/ledger.js";
import { formatTokens } from "../src/services/og.js";
import { commitUrl } from "../src/services/projects.js";

const root = join(import.meta.dirname, "..");
const spec = join(root, "..", "spec");

describe("bundled spec copy", () => {
  it("server/spec is byte-identical to spec/ (run `pnpm --filter server spec:sync` if this fails)", () => {
    const files = ["openapi.yaml", ...readdirSync(join(spec, "schemas")).map((f) => `schemas/${f}`)];
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) expect(readFileSync(join(root, "spec", f)).equals(readFileSync(join(spec, f))), `${f} drifted from spec/`).toBe(true);
    expect(readdirSync(join(root, "spec", "schemas")).sort()).toEqual(readdirSync(join(spec, "schemas")).sort());
  });

  it("generated TypeScript types are up to date with the OpenAPI document", () => {
    const fresh = execFileSync(join(root, "node_modules/.bin/openapi-typescript"), [join(spec, "openapi.yaml")], { encoding: "utf8", cwd: root });
    expect(readFileSync(join(root, "src/generated/openapi.d.ts"), "utf8")).toBe(fresh);
  });

  it("the example project validates against the bundled schemas", () => {
    const ex = join(root, "..", "examples", "hello-project");
    expect(validateAgentfund(parseStrictYaml(readFileSync(join(ex, "agentfund.yaml"), "utf8"))).name).toBe("hello-project");
    for (const f of readdirSync(join(ex, "tasks")).filter((x) => x.endsWith(".yaml"))) {
      expect(validateManifest(parseStrictYaml(readFileSync(join(ex, "tasks", f), "utf8"))).id).toBe(f.replace(".yaml", ""));
    }
  });
});

describe("strict YAML", () => {
  it("parses plain documents", () => {
    expect(parseStrictYaml("a: 1\nb: [x, y]\nc: |\n  hi\n")).toEqual({ a: 1, b: ["x", "y"], c: "hi\n" });
    expect(parseStrictYaml("---\na: true\n")).toEqual({ a: true });
  });
  it.each([
    ["anchors", "a: &x 1\n"],
    ["aliases", "a: &x 1\nb: *x\n"],
    ["tags", "a: !!str 1\n"],
    ["custom tags", "a: !foo 1\n"],
    ["multiple documents", "a: 1\n---\nb: 2\n"],
    ["merge keys", "a: {x: 1}\nb:\n  <<: {y: 1}\n"],
    ["directives", "%YAML 1.2\n---\na: 1\n"],
    ["duplicate keys", "a: 1\na: 2\n"],
    ["empty input", ""],
  ])("rejects %s", (_name, text) => {
    expect(() => parseStrictYaml(text)).toThrow();
  });
});

describe("manifest schema", () => {
  const base = { spec_version: 1, id: "0001-a", title: "t", prompt: "p", scope: { write: ["src/**"] }, verify: "true", max_tokens: 1000 };
  it("accepts a minimal manifest and rejects bad globs / unknown keys", () => {
    expect(validateManifest(base).id).toBe("0001-a");
    expect(() => validateManifest({ ...base, scope: { write: ["../x"] } })).toThrow();
    expect(() => validateManifest({ ...base, scope: { write: ["/abs"] } })).toThrow();
    expect(() => validateManifest({ ...base, scope: { write: [".git/config"] } })).toThrow();
    expect(() => validateManifest({ ...base, extra: 1 })).toThrow();
    expect(() => validateManifest({ ...base, spec_version: 2 })).toThrow();
  });
});

describe("repo URL validation", () => {
  const p = (u: string, allowFile = false) => parseRepoUrl(u, { allowFile });
  it("canonicalises https URLs", () => {
    expect(p("https://github.com/Owner/Repo.git/")).toMatchObject({ url: "https://github.com/Owner/Repo", key: "https://github.com/owner/repo", github: "owner/repo" });
    expect(p("https://gitlab.com/a/b/c").github).toBeNull();
  });
  it.each([
    "http://github.com/a/b", "git@github.com:a/b.git", "ssh://git@github.com/a/b", "ext::sh -c id", "https://user:pw@github.com/a/b",
    "https://github.com/a/b?x=1", "https://localhost/a/b", "https://127.0.0.1/a/b", "https://10.0.0.8/a/b", "https://192.168.1.2/a/b",
    "https://intranet/a/b", "--upload-pack=x", "https://github.com/a/../b", "file:///tmp/x", "https://github.com/a",
  ])("rejects %s", (u) => {
    expect(() => p(u)).toThrow();
  });
  it("allows file:// only when enabled", () => {
    expect(p("file:///tmp/af-repo-1", true).scheme).toBe("file");
    expect(() => p("file:///tmp/../etc", true)).toThrow();
  });
});

describe("git failures are reported in plain words", () => {
  it.each([
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", false, "repository not found or no access"],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", false, "repository not found or no access"],
    ["fatal: unable to access 'https://gitlab.com/a/b/': The requested URL returned error: 403", false, "repository not found or no access"],
    ["fatal: '/nonexistent/x' does not appear to be a git repository", false, "repository not found or no access"],
    ["fatal: unable to access 'https://nope.invalid/a/b/': Could not resolve host: nope.invalid", false, "could not reach host"],
    ["fatal: unable to access 'https://h.example/a/b/': Failed to connect to h.example port 443", false, "could not reach host"],
    ["", true, "timed out"],
    ["fatal: unable to access 'https://h.example/a/b/': Operation timed out after 30000 milliseconds", false, "timed out"],
    ["something nobody has seen before", false, "could not read the repository"],
  ])("%s", (stderr, timedOut, message) => {
    expect(friendlyGitMessage(stderr, timedOut)).toBe(message);
  });
});

describe("config", () => {
  const env = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };
  it("has sane defaults with nothing but a database", () => {
    const c = loadConfig(env);
    expect(c.port).toBe(8787);
    expect(c.baseUrl).toBe("http://localhost:8787");
    expect(c.authDevLogin).toBe(true);
    expect(c.warnings.join(" ")).toMatch(/DEV LOGIN IS ENABLED/);
    expect(c.webOrigins).toEqual(["http://localhost:5173"]);
    expect(c.sourceUrl).toBe("https://github.com/ghvstcode/agentfund");
    expect(c.docsUrl).toBeUndefined();
    expect(loadConfig({ ...env, SOURCE_URL: "https://git.example/fork", INSTALL_COMMAND: "brew install x", DOCS_URL: "https://docs.example" })).toMatchObject({ sourceUrl: "https://git.example/fork", installCommand: "brew install x", docsUrl: "https://docs.example" });
    expect(() => loadConfig({ ...env, DOCS_URL: "javascript:alert(1)" })).toThrow(/DOCS_URL/);
  });
  it("reads the client IP from CLIENT_IP_HEADER, never from a forgeable X-Forwarded-For", () => {
    const ip = (vars: Record<string, string>, headers: Record<string, string>) => {
      const ctx = { config: loadConfig({ ...env, ...vars }) } as unknown as AppContext;
      const c = { req: { header: (n: string) => headers[n.toLowerCase()] }, env: { incoming: { socket: { remoteAddress: "10.0.0.1" } } } } as unknown as Context;
      return clientIp(ctx, c);
    };
    const forged = { "x-forwarded-for": "6.6.6.6, 1.2.3.4", "fly-client-ip": "1.2.3.4" };
    expect(ip({}, forged)).toBe("10.0.0.1");
    expect(ip({ TRUST_PROXY: "true" }, forged)).toBe("6.6.6.6");
    expect(ip({ TRUST_PROXY: "true", CLIENT_IP_HEADER: "Fly-Client-IP" }, forged)).toBe("1.2.3.4");
    expect(ip({ CLIENT_IP_HEADER: "fly-client-ip" }, {})).toBe("10.0.0.1");
    expect(() => loadConfig({ ...env, CLIENT_IP_HEADER: "fly client ip" })).toThrow(/CLIENT_IP_HEADER/);
  });
  it("turns dev login off by default once GitHub OAuth is configured", () => {
    const c = loadConfig({ ...env, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", BASE_URL: "https://fund.example/" });
    expect(c.authDevLogin).toBe(false);
    expect(c.baseUrl).toBe("https://fund.example");
    expect(c.webOrigins).toEqual([]);
    expect(c.warnings.join(" ")).toMatch(/LEGAL_CONTACT is not set/);
  });
  it("takes the operator's own legal pages and contact", () => {
    const oauth = { ...env, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
    const c = loadConfig({ ...oauth, PRIVACY_URL: "https://fund.example/privacy.html", TERMS_URL: "https://fund.example/terms.html", LEGAL_CONTACT: "privacy@fund.example" });
    expect(c).toMatchObject({ privacyUrl: "https://fund.example/privacy.html", termsUrl: "https://fund.example/terms.html", legalContact: "privacy@fund.example" });
    expect(c.warnings.join(" ")).not.toMatch(/LEGAL_CONTACT/);
    expect(() => loadConfig({ ...env, TERMS_URL: "javascript:alert(1)" })).toThrow(/TERMS_URL/);
    expect(() => loadConfig({ ...env, LEGAL_CONTACT: "not an address" })).toThrow(/LEGAL_CONTACT/);
  });
  it("fails clearly on bad values", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...env, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...env, GITHUB_CLIENT_ID: "x" })).toThrow(/both or neither/);
    expect(() => loadConfig({ ...env, WEB_ORIGINS: "not a url" })).toThrow(/WEB_ORIGINS/);
    expect(() => loadConfig({ ...env, WEBHOOK_SECRET: "short" })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...env, BASE_URL: "ftp://x" })).toThrow(/BASE_URL/);
    expect(() => loadConfig({ ...env, CI_POLL: "maybe" })).toThrow(/CI_POLL/);
  });
});

describe("small pure helpers", () => {
  it("streakDays counts consecutive UTC days ending today or yesterday", () => {
    expect(streakDays(["2026-01-15", "2026-01-14", "2026-01-13"], "2026-01-15")).toBe(3);
    expect(streakDays(["2026-01-14", "2026-01-13"], "2026-01-15")).toBe(2);
    expect(streakDays(["2026-01-13"], "2026-01-15")).toBe(0);
    expect(streakDays(["2026-01-15", "2026-01-13"], "2026-01-15")).toBe(1);
    expect(streakDays([], "2026-01-15")).toBe(0);
  });
  it("commitUrl is built for GitHub only", () => {
    expect(commitUrl("https://github.com/acme/widgets", "a".repeat(40))).toBe(`https://github.com/acme/widgets/commit/${"a".repeat(40)}`);
    expect(commitUrl("https://gitlab.com/acme/widgets", "a".repeat(40))).toBeNull();
    expect(commitUrl("file:///tmp/x", "a".repeat(40))).toBeNull();
  });
  it("formatTokens abbreviates", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(3_000_000)).toBe("3M");
    expect(formatTokens(60_000_000)).toBe("60M");
    expect(formatTokens(1_250_000_000)).toBe("1.25B");
  });
});

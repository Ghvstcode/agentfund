import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Schemas } from "../src/lib/openapi.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { claim, setupProject } from "./helpers/scenario.js";

interface Frame {
  event: string;
  data: unknown;
}

/** Minimal EventSource over a fetch Response body. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private readonly decoder = new TextDecoder();
  readonly frames: Frame[] = [];
  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }
  private parse(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      this.frames.push({ event, data: JSON.parse(data.join("\n") || "null") });
    }
  }
  /** Reads until a frame matching `pred` (not yet returned) shows up. */
  async next(pred: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      for (; seen < this.frames.length; seen++) {
        if (pred(this.frames[seen]!)) return this.frames.splice(seen, 1)[0]!;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching SSE frame; got ${JSON.stringify(this.frames)}`);
      const chunk = await Promise.race([this.reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (chunk === null) continue;
      if (chunk.done) throw new Error("stream ended");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      this.parse();
    }
  }
  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const open = async (query: Record<string, string> = {}) => {
  const res = await t.call<Response>("stream", { query });
  expect(res.status).toBe(200);
  return { res, sse: new SseReader(res.body) };
};

describe("GET /v1/stream", () => {
  it("has proxy-safe SSE headers", async () => {
    const { res, sse } = await open();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await sse.close();
  });

  it("project scope: totals on connect, then events and fresh totals after a claim and a heartbeat with tokens", async () => {
    await setupProject(t, "live", [{ id: "0001-a" }]);
    await setupProject(t, "elsewhere", [{ id: "0001-a" }]);
    const d = await t.donor("streamer");
    const { sse } = await open({ project: "live" });
    const totalsSchema = t.ctx.spec.schema("StreamTotals");
    const eventSchema = t.ctx.spec.schema("Event");

    const first = await sse.next((f) => f.event === "totals");
    expect(totalsSchema(first.data), JSON.stringify(totalsSchema.errors)).toBe(true);
    expect(first.data).toMatchObject({ scope: "project", project: "live", token_goal: 1_000_000, totals: { pledged: 0, in_flight: 0 }, tasks: { open: 1, claimed: 0, claimable: 1 } });

    // Activity in another project never reaches this stream.
    await t.call("createPledge", { token: d.key, path: { slug: "elsewhere" }, body: { token_amount: 9 } });

    const c = await claim(t, d.key, "live:0001-a");
    const claimed = await sse.next((f) => f.event === "event");
    expect(eventSchema(claimed.data), JSON.stringify(eventSchema.errors)).toBe(true);
    expect(claimed.data).toMatchObject({ action: "task.claimed", project: "live", task_id: "live:0001-a", actor: "streamer" });
    expect((await sse.next((f) => f.event === "totals" && (f.data as Schemas["StreamTotals"]).tasks?.claimed === 1)).data).toMatchObject({ tasks: { open: 0, claimed: 1 } });

    // A heartbeat carries no audit event, only in-flight tokens.
    await t.call("heartbeatClaim", { token: d.key, path: { claim_id: c.claim_id }, body: { tokens_in: 12_000, tokens_out: 345, phase: "agent" } });
    const inflight = await sse.next((f) => f.event === "totals" && (f.data as Schemas["StreamTotals"]).totals.in_flight > 0);
    expect(totalsSchema(inflight.data)).toBe(true);
    expect((inflight.data as Schemas["StreamTotals"]).totals).toMatchObject({ in_flight: 12_345, reported: 0 });

    await t.call("releaseClaim", { token: d.key, path: { claim_id: c.claim_id }, body: { tokens_in: 12_000, tokens_out: 345 } });
    expect((await sse.next((f) => f.event === "event")).data).toMatchObject({ action: "claim.released" });
    expect((await sse.next((f) => f.event === "totals" && (f.data as Schemas["StreamTotals"]).totals.reported > 0)).data).toMatchObject({ totals: { in_flight: 0, reported: 12_345 }, tasks: { open: 1 } });
    expect(sse.frames.filter((f) => f.event === "event" && (f.data as Schemas["Event"]).project === "elsewhere")).toEqual([]);
    await sse.close();
    await expect.poll(() => t.ctx.hub.size, { timeout: 5_000 }).toBe(0);
  });

  it("instance scope: sees every project's public events and instance totals", async () => {
    const { sse } = await open();
    const first = await sse.next((f) => f.event === "totals");
    expect(first.data).toMatchObject({ scope: "instance", project: null, tasks: null, token_goal: null });
    const d = await t.donor("wide");
    await t.call("createPledge", { token: d.key, path: { slug: "live" }, body: { token_amount: 1_000 } });
    await t.call("createPledge", { token: d.key, path: { slug: "elsewhere" }, body: { token_amount: 2_000 } });
    const a = await sse.next((f) => f.event === "event" && (f.data as Schemas["Event"]).project === "live");
    const b = await sse.next((f) => f.event === "event" && (f.data as Schemas["Event"]).project === "elsewhere");
    expect([a.data, b.data]).toMatchObject([{ action: "pledge.created" }, { action: "pledge.created" }]);
    const totals = await sse.next((f) => f.event === "totals" && (f.data as Schemas["StreamTotals"]).totals.pledged >= 3_009);
    expect((totals.data as Schemas["StreamTotals"]).totals.pledged).toBe(3_009);
    await sse.close();
  });

  it("coalesces bursts: many changes produce few totals frames", async () => {
    const { sse } = await open({ project: "elsewhere" });
    await sse.next((f) => f.event === "totals");
    const d = await t.donor("bursty");
    const started = Date.now();
    for (let i = 0; i < 20; i++) await t.call("createPledge", { token: d.key, path: { slug: "elsewhere" }, body: { token_amount: 1 } });
    await sse.next((f) => f.event === "totals" && (f.data as Schemas["StreamTotals"]).totals.pledged === 2_029);
    const elapsed = Date.now() - started;
    const frames = sse.frames.filter((f) => f.event === "totals").length + 1;
    expect(frames).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 2);
    expect(sse.frames.filter((f) => f.event === "event")).toHaveLength(20);
    await sse.close();
  });

  it("404s for an unknown project", async () => {
    expect((await t.call("stream", { query: { project: "no-such-project" } })).status).toBe(404);
  });
});

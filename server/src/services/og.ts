/** `/og/<slug>.png` — a 1200×630 card rendered with satori + resvg, cached by a hash of what it shows. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

const require = createRequire(import.meta.url);
const INK = "#0b0b0c";
const MUTED = "#6b6b70";
const HAIRLINE = "#e4e4e7";
const PAPER = "#ffffff";
/** The one accent colour: solid for delivered, tinted for pledged. */
const ACCENT = /^#[0-9a-fA-F]{6}$/.test(process.env.OG_ACCENT ?? "") ? (process.env.OG_ACCENT as string) : "#2563eb";

type FontWeight = 400 | 500 | 600 | 700;
interface Font {
  name: string;
  data: Buffer;
  weight: FontWeight;
  style: "normal";
}

let fonts: Font[] | undefined;
function loadFonts(): Font[] {
  if (fonts) return fonts;
  const load = (pkg: string, file: string) => readFileSync(require.resolve(`@fontsource/${pkg}/files/${file}`));
  fonts = [
    { name: "Inter", data: load("inter", "inter-latin-400-normal.woff"), weight: 400, style: "normal" },
    { name: "Inter", data: load("inter", "inter-latin-600-normal.woff"), weight: 600, style: "normal" },
    { name: "Inter", data: load("inter", "inter-latin-700-normal.woff"), weight: 700, style: "normal" },
    { name: "JetBrains Mono", data: load("jetbrains-mono", "jetbrains-mono-latin-400-normal.woff"), weight: 400, style: "normal" },
    { name: "JetBrains Mono", data: load("jetbrains-mono", "jetbrains-mono-latin-700-normal.woff"), weight: 700, style: "normal" },
  ];
  return fonts;
}

export interface OgCard {
  instance: string;
  slug: string;
  name: string;
  description: string;
  language: string | null;
  pledged: number;
  delivered: number;
  merged: number;
  goal: number;
  tasksMerged: number;
  tasksTotal: number;
}

export function formatTokens(n: number): string {
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}${suffix}`;
    }
  }
  return String(n);
}

type El = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown): El => ({ type, props: { style, children } });

function stat(label: string, value: string, strong = false): El {
  return h("div", { display: "flex", flexDirection: "column", gap: 6 }, [
    h("div", { fontFamily: "JetBrains Mono", fontSize: 44, fontWeight: 700, color: strong ? ACCENT : INK, letterSpacing: -1 }, value),
    h("div", { fontSize: 20, color: MUTED, textTransform: "uppercase", letterSpacing: 2 }, label),
  ]);
}

function tree(card: OgCard): El {
  const scale = Math.max(card.goal, card.pledged, card.delivered, 1);
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100)).toFixed(2)}%`;
  const funded = card.goal > 0 ? Math.round((card.delivered / card.goal) * 100) : 0;
  const description = card.description.length > 150 ? `${card.description.slice(0, 147)}…` : card.description;
  return h(
    "div",
    { width: 1200, height: 630, display: "flex", flexDirection: "column", justifyContent: "space-between", backgroundColor: PAPER, color: INK, fontFamily: "Inter", padding: 64, border: `1px solid ${HAIRLINE}` },
    [
      h("div", { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 22, color: MUTED }, [
        h("div", { display: "flex", fontWeight: 600, color: INK }, card.instance),
        h("div", { display: "flex", fontFamily: "JetBrains Mono" }, `${card.language ? `${card.language} · ` : ""}${card.tasksMerged}/${card.tasksTotal} tasks merged`),
      ]),
      h("div", { display: "flex", flexDirection: "column", gap: 18 }, [
        h("div", { display: "flex", fontSize: card.name.length > 24 ? 64 : 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }, card.name),
        h("div", { display: "flex", fontSize: 30, color: MUTED, lineHeight: 1.35 }, description),
      ]),
      h("div", { display: "flex", flexDirection: "column", gap: 28 }, [
        h("div", { display: "flex", justifyContent: "space-between", alignItems: "flex-end" }, [
          h("div", { display: "flex", gap: 64 }, [stat("delivered", formatTokens(card.delivered), true), stat("pledged", formatTokens(card.pledged)), stat("goal", formatTokens(card.goal))]),
          h("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 44, fontWeight: 700 }, `${funded}%`),
        ]),
        h("div", { display: "flex", position: "relative", width: "100%", height: 20, border: `1px solid ${HAIRLINE}`, backgroundColor: PAPER }, [
          h("div", { position: "absolute", left: 0, top: 0, bottom: 0, width: pct(card.pledged), backgroundColor: ACCENT, opacity: 0.22 }),
          h("div", { position: "absolute", left: 0, top: 0, bottom: 0, width: pct(card.delivered), backgroundColor: ACCENT }),
          h("div", { position: "absolute", left: pct(card.goal), top: -8, bottom: -8, width: 2, marginLeft: -2, backgroundColor: INK }),
        ]),
      ]),
    ],
  );
}

const cache = new Map<string, { hash: string; png: Buffer }>();

export async function renderOgCard(card: OgCard): Promise<{ png: Buffer; etag: string }> {
  const hash = createHash("sha256").update(JSON.stringify(card)).update(ACCENT).digest("hex").slice(0, 32);
  const hit = cache.get(card.slug);
  if (hit && hit.hash === hash) return { png: hit.png, etag: `"${hash}"` };
  const svg = await satori(tree(card) as unknown as Parameters<typeof satori>[0], { width: 1200, height: 630, fonts: loadFonts() });
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
  if (cache.size > 500) cache.clear();
  cache.set(card.slug, { hash, png });
  return { png, etag: `"${hash}"` };
}

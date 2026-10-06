import { validation } from "./problem.js";

/** Opaque pagination cursors: base64url JSON. Clients never construct them. */
export const encodeCursor = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw validation("/cursor", "cursor is not valid");
}

export function offsetOf(cursor: string | undefined): number {
  const c = decodeCursor(cursor);
  if (!c) return 0;
  const o = c.o;
  if (typeof o !== "number" || !Number.isInteger(o) || o < 0 || o > 1_000_000) throw validation("/cursor", "cursor is not valid");
  return o;
}

/** Trims an over-fetched page (limit + 1 rows) and derives the next offset cursor. */
export function pageByOffset<T>(rowsPlusOne: T[], limit: number, offset: number): { items: T[]; next_cursor: string | null } {
  const more = rowsPlusOne.length > limit;
  return { items: more ? rowsPlusOne.slice(0, limit) : rowsPlusOne, next_cursor: more ? encodeCursor({ o: offset + limit }) : null };
}

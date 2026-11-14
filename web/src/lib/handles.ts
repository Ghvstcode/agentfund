export interface HandleParts {
  /** The handle on the donor's home instance. */
  name: string;
  /** Host (and port) of the home instance, or null for a donor whose home is this instance. */
  host: string | null;
}

/**
 * Split `alice@fund.example:8443` into its name and home host. A handle without a host part is
 * local. Hosts can carry a port, so only the first `@` separates.
 */
export function splitHandle(handle: string): HandleParts {
  const at = handle.indexOf('@');
  if (at <= 0 || at === handle.length - 1) return { name: handle, host: null };
  return { name: handle.slice(0, at), host: handle.slice(at + 1) };
}

/** Whether the handle belongs to a donor whose home is a peer instance. */
export function isRemoteHandle(handle: string): boolean {
  return splitHandle(handle).host !== null;
}

/** In-app path of a donor profile. `@` and `:` are escaped so the handle stays one path segment. */
export function profilePath(handle: string): string {
  return `/u/${encodeURIComponent(handle)}`;
}

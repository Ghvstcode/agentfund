/** Software name. Change it here to rebrand a fork; instance names come from `GET /v1/meta`. */
export const APP_NAME = 'AgentFund';

/** Name of the worker binary, used in every CLI line the UI prints. */
export const CLI_NAME = 'agentfund';

export interface RuntimeConfig {
  /** API origin. Empty string means "same origin as this page". */
  apiBase?: string;
  /** Shell one-liner that installs the worker CLI, used when `meta.links` has none. */
  installCommand?: string;
  /** Where the source of this software lives, used when `meta.links` has none. */
  sourceUrl?: string;
}

declare global {
  interface Window {
    /** Injected by the reference server into index.html; overrides build-time config. */
    __AGENTFUND__?: RuntimeConfig;
  }
}

interface BuildEnv {
  VITE_API_BASE_URL?: string;
  VITE_INSTALL_COMMAND?: string;
  VITE_SOURCE_URL?: string;
}

// Build from source: it works before any release exists. Instances override it in meta.links.
const DEFAULT_INSTALL_COMMAND = 'git clone https://github.com/agentfund/agentfund && make -C agentfund/worker build images';
const DEFAULT_SOURCE_URL = 'https://github.com/agentfund/agentfund';

/**
 * Resolve the API base URL: runtime override first (an empty string is a valid override and
 * means same-origin), then the build-time variable, then same-origin.
 */
export function resolveApiBase(runtime: RuntimeConfig | undefined, env: BuildEnv): string {
  const chosen = typeof runtime?.apiBase === 'string' ? runtime.apiBase : (env.VITE_API_BASE_URL ?? '');
  return chosen.trim().replace(/\/+$/, '');
}

const runtime = typeof window === 'undefined' ? undefined : window.__AGENTFUND__;
const env = import.meta.env as BuildEnv;

export const API_BASE = resolveApiBase(runtime, env);
/** Fallbacks for when the instance's `meta.links` does not name them. */
export const FALLBACK_INSTALL_COMMAND = runtime?.installCommand ?? env.VITE_INSTALL_COMMAND ?? DEFAULT_INSTALL_COMMAND;
export const FALLBACK_SOURCE_URL = runtime?.sourceUrl ?? env.VITE_SOURCE_URL ?? DEFAULT_SOURCE_URL;

/** Absolute URL of an API or server path, for plain links and EventSource. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

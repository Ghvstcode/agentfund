/** Software name. Change it here to rebrand a fork; instance names come from `GET /v1/meta`. */
export const APP_NAME = 'AgentFund';

/** Name of the worker binary, used in every CLI line the UI prints. */
export const CLI_NAME = 'agentfund';

export interface RuntimeConfig {
  /** API origin. Empty string means "same origin as this page". */
  apiBase?: string;
  /** Shell one-liner that installs the worker CLI. */
  installCommand?: string;
  /** Where the source of this software lives. */
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

const DEFAULT_INSTALL_COMMAND = 'curl -fsSL https://agentfund.dev/install.sh | sh';
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
export const INSTALL_COMMAND = runtime?.installCommand ?? env.VITE_INSTALL_COMMAND ?? DEFAULT_INSTALL_COMMAND;
export const SOURCE_URL = runtime?.sourceUrl ?? env.VITE_SOURCE_URL ?? DEFAULT_SOURCE_URL;

/** Absolute URL of an API or server path, for plain links and EventSource. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

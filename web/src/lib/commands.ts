import type { FederatedProject, Meta } from '../api/types';
import { CLI_NAME, FALLBACK_INSTALL_COMMAND, FALLBACK_SOURCE_URL } from '../config';

export interface CommandLine {
  label: string;
  /** What happens when it runs, in a sentence. */
  note?: string;
  command: string;
}

export interface InstanceLinks {
  installCommand: string;
  sourceUrl: string;
  docsUrl: string | null;
}

/** Operator-configured links from `/v1/meta`, with this build's fallbacks where absent. */
export function instanceLinks(meta: Pick<Meta, 'links'> | undefined): InstanceLinks {
  return {
    installCommand: meta?.links?.install_command || FALLBACK_INSTALL_COMMAND,
    sourceUrl: meta?.links?.source_url || FALLBACK_SOURCE_URL,
    docsUrl: meta?.links?.docs_url || null,
  };
}

const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

export function loginCommand(baseUrl: string): string {
  return `${CLI_NAME} login ${trimBase(baseUrl)}`;
}

/** Non-interactive login for scripts: the key arrives on stdin, never in the argument list. */
export function loginFromStdinCommand(baseUrl: string): string {
  return `printf '%s\\n' "$KEY" | ${CLI_NAME} login ${trimBase(baseUrl)} --key-stdin`;
}

/** The exact lines a donor runs to back a project, built from the instance's canonical URL. */
export function backCommands(meta: Pick<Meta, 'base_url' | 'links'>, slug: string): CommandLine[] {
  const project = `${trimBase(meta.base_url)}/${slug}`;
  return [
    { label: 'Get the worker', command: instanceLinks(meta).installCommand },
    {
      label: 'Sign in to this instance',
      note: 'Prompts for an API key. Create one under Settings.',
      command: loginCommand(meta.base_url),
    },
    {
      label: 'Review and approve',
      note: 'Shows the key fingerprint and every task in a pager, then asks you to confirm.',
      command: `${CLI_NAME} approve ${project}`,
    },
    {
      label: 'See what would run',
      note: 'Prints the next task it would take. Nothing is executed.',
      command: `${CLI_NAME} dry-run ${project}`,
    },
    {
      label: 'Start working',
      note: 'Stops at the budget, and only runs inside the schedule.',
      command: `${CLI_NAME} work ${project} --budget 200m --schedule "02:00-06:00"`,
    },
  ];
}

/** `fund.example.org` or `localhost:8787`: how an instance is named in handles and peer lists. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return trimBase(baseUrl).replace(/^https?:\/\//, '');
  }
}

/**
 * The lines a donor with an account here runs to work on a project hosted on a peer: sign in
 * there through this instance, then approve as usual. Only meaningful when the peer accepts
 * this instance's identities.
 */
export function federatedBackCommands(
  meta: Pick<Meta, 'base_url'>,
  project: Pick<FederatedProject, 'instance' | 'slug'>,
): CommandLine[] {
  const there = trimBase(project.instance.base_url);
  const here = trimBase(meta.base_url);
  return [
    {
      label: `Sign in to ${project.instance.host} with your account here`,
      note: `Uses the sign-in your worker already has for ${hostOf(here)}. You need no account and no API key on ${project.instance.host}.`,
      command: `${CLI_NAME} login ${there} --via ${here}`,
    },
    {
      label: 'Review and approve',
      note: 'Shows the key fingerprint and every task in a pager, then asks you to confirm.',
      command: `${CLI_NAME} approve ${there}/${project.slug}`,
    },
  ];
}

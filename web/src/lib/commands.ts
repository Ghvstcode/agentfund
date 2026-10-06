import { CLI_NAME, INSTALL_COMMAND } from '../config';

export interface CommandLine {
  label: string;
  command: string;
}

/** The exact lines a donor runs to back a project, built from the instance's canonical URL. */
export function backCommands(baseUrl: string, slug: string, budget = '200m'): CommandLine[] {
  const base = baseUrl.replace(/\/+$/, '');
  return [
    { label: 'Install the worker', command: INSTALL_COMMAND },
    { label: 'Sign in to this instance', command: loginCommand(base) },
    { label: 'Review and approve the project key', command: `${CLI_NAME} approve ${base}/${slug}` },
    { label: 'Start working', command: `${CLI_NAME} work ${base}/${slug} --budget ${budget}` },
  ];
}

export function loginCommand(baseUrl: string): string {
  return `${CLI_NAME} login ${baseUrl.replace(/\/+$/, '')}`;
}

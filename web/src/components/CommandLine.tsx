import { CopyButton } from './CopyButton';

interface CommandLineProps {
  command: string;
  /** What the command does, for the copy button's accessible name. */
  label: string;
}

/** One copyable shell line. */
export function CommandLine({ command, label }: CommandLineProps) {
  return (
    <div className="command">
      {/* Scrollable so a long line never widens the page; focusable so keyboards can scroll it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre className="command__text" tabIndex={0} aria-label={`Command: ${command}`}>
        <span className="command__prompt" aria-hidden="true">
          ${' '}
        </span>
        <code>{command}</code>
      </pre>
      <CopyButton text={command} label={`the command: ${label}`} />
    </div>
  );
}

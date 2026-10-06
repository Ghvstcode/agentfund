import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';

interface CommandLineProps {
  command: string;
  /** What the command does, for the copy button's accessible name. */
  label: string;
  className?: string;
}

/**
 * One copyable shell line, set like a terminal row in both themes. Long commands wrap inside
 * the block (breaking anywhere if they must) rather than scrolling or pushing their container
 * wider; the copy button always yields the command on one line.
 */
export function CommandLine({ command, label, className }: CommandLineProps) {
  return (
    <div
      className={cn(
        'dark flex max-w-full min-w-0 items-start gap-2 rounded-lg border border-white/10 bg-[#0b0b0d] py-1.5 pr-1.5 pl-3 text-zinc-100 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]',
        className,
      )}
    >
      <pre className="min-w-0 flex-1 py-1 text-[0.8125rem] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
        <span className="text-zinc-500 select-none" aria-hidden="true">
          ${' '}
        </span>
        <code>{command}</code>
      </pre>
      <CopyButton
        text={command}
        label={`the command: ${label}`}
        className="border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
      />
    </div>
  );
}

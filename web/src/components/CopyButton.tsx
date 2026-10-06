import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

/** State for a copy action: `copied` is true for two seconds after a successful copy. */
export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => setCopied(await copyText(text));
  return { copied, copy };
}

interface CopyButtonProps {
  text: string;
  /** What is being copied, for screen readers: "Copy <label>". */
  label: string;
  /** Visible caption next to the icon. Without one the button is icon-only. */
  caption?: string;
  className?: string;
}

/** Copies `text`; the icon turns into a check for two seconds as confirmation. */
export function CopyButton({ text, label, caption, className }: CopyButtonProps) {
  const { copied, copy } = useCopy(text);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border bg-background text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        caption ? 'px-2.5' : 'w-7',
        copied && 'text-foreground',
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      {caption && <span aria-hidden="true">{copied ? 'Copied' : caption}</span>}
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';

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
  /** Visible caption; defaults to "Copy". */
  caption?: string;
}

export function CopyButton({ text, label, caption = 'Copy' }: CopyButtonProps) {
  const { copied, copy } = useCopy(text);
  return (
    <button type="button" className="copy-button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
      <span aria-hidden="true">{copied ? 'Copied' : caption}</span>
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

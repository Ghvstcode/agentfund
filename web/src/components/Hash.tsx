import { shortHash } from '../lib/format';
import { useCopy } from './CopyButton';

interface HashProps {
  /** Full value; this is what lands on the clipboard and in the tooltip. */
  value: string;
  /** What the value is, e.g. "commit" or "key fingerprint". */
  label: string;
  /** Characters of the hash body to show. Pass `Infinity` to show it whole. */
  length?: number;
}

/** A short hash that copies its full value on click. */
export function Hash({ value, label, length = 7 }: HashProps) {
  const { copied, copy } = useCopy(value);
  return (
    <button
      type="button"
      className="hash mono"
      title={`${value} (click to copy)`}
      aria-label={`Copy ${label} ${shortHash(value, 12)}`}
      data-copied={copied || undefined}
      onClick={() => void copy()}
    >
      <span aria-hidden="true">{shortHash(value, length)}</span>
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

import { groupHex } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';

interface FingerprintProps {
  /** `SHA256:<hex>`, or any other string to compare character by character. */
  value: string;
  /** What it is the fingerprint of, for the copy button: "Copy <label>". */
  label: string;
  className?: string;
}

/**
 * A key fingerprint in full, set in groups of four so two people can compare it aloud or by
 * eye. Unlike `Hash` it is never shortened: this is for the moments where every character counts.
 */
export function Fingerprint({ value, label, className }: FingerprintProps) {
  const separator = value.indexOf(':');
  const prefix = separator === -1 ? '' : value.slice(0, separator + 1);
  const body = value.slice(prefix.length);
  const groups = /^[0-9a-f]+$/i.test(body) ? groupHex(body) : [body];
  return (
    <div className={cn('flex min-w-0 items-start gap-2 border bg-muted/50 py-2 pr-2 pl-3.5', className)}>
      <p className="num flex min-w-0 flex-1 flex-wrap gap-x-2 py-1 text-[0.8125rem] leading-5 [overflow-wrap:anywhere]">
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        {groups.map((group, index) => (
          <span key={index}>{group}</span>
        ))}
      </p>
      <CopyButton text={value} label={label} />
    </div>
  );
}

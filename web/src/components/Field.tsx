import { ChevronDown } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Hide the label visually (it stays available to screen readers). */
  hideLabel?: boolean;
}

interface FieldParts {
  id: string;
  describedBy: string | undefined;
}

function FieldShell({ label, hint, error, hideLabel, children }: FieldShellProps & { children: (parts: FieldParts) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </Label>
      {children({ id, describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined })}
      {hint && (
        <p id={hintId} className="text-xs text-pretty text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

type TextFieldProps = FieldShellProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { mono?: boolean };

export function TextField({ label, hint, error, hideLabel, mono, className, ...input }: TextFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel}>
      {({ id, describedBy }) => (
        <Input
          type="text"
          {...input}
          id={id}
          className={cn('h-9', mono && 'num text-[0.8125rem]', className)}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        />
      )}
    </FieldShell>
  );
}

type SelectFieldProps = FieldShellProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>;

/** A native select in the house style: best on phones and in dense tables. */
export function SelectField({ label, hint, error, hideLabel, children, className, ...select }: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel}>
      {({ id, describedBy }) => (
        // Sizing classes go on the wrapper, so the chevron always sits inside the control.
        <span className={cn('relative block h-9', className)}>
          <select
            {...select}
            id={id}
            aria-describedby={describedBy}
            className="size-full appearance-none rounded-lg border border-input bg-transparent pr-8 pl-2.5 text-sm transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
          >
            {children}
          </select>
          <ChevronDown
            className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </span>
      )}
    </FieldShell>
  );
}

interface SwitchFieldProps {
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** A labelled on/off switch. */
export function SwitchField({ label, checked, onCheckedChange, disabled, className }: SwitchFieldProps) {
  const id = useId();
  return (
    <div className={cn('flex min-h-9 items-center gap-2.5', className)}>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      <Label htmlFor={id} className="text-sm leading-snug font-normal">
        {/* One child, so the label's flex gap cannot split a sentence around inline code. */}
        <span>{label}</span>
      </Label>
    </div>
  );
}

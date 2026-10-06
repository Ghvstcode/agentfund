import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';

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

function FieldShell({
  label,
  hint,
  error,
  hideLabel,
  children,
}: FieldShellProps & { children: (parts: FieldParts) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field" data-invalid={error ? true : undefined}>
      <label className={hideLabel ? 'sr-only' : 'field__label'} htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined })}
      {hint && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errorId} role="alert">
          <strong>Error:</strong> {error}
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
        <input
          type="text"
          {...input}
          id={id}
          className={['input', mono && 'mono', className].filter(Boolean).join(' ')}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        />
      )}
    </FieldShell>
  );
}

type SelectFieldProps = FieldShellProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>;

export function SelectField({ label, hint, error, hideLabel, children, ...select }: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel}>
      {({ id, describedBy }) => (
        <select {...select} id={id} className="input input--select" aria-describedby={describedBy}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode };

export function Checkbox({ label, ...input }: CheckboxProps) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...input} />
      <span>{label}</span>
    </label>
  );
}

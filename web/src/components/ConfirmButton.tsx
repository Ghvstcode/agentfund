import { useState } from 'react';
import { Button } from './Button';

interface ConfirmButtonProps {
  /** The action, e.g. "Revoke". */
  label: string;
  /** Shown on the second click target, e.g. "Revoke key". */
  confirmLabel: string;
  /** Extra context for screen readers, e.g. the name of the thing acted on. */
  subject: string;
  onConfirm: () => void;
  busy?: boolean;
}

/** A destructive action that takes two deliberate clicks instead of a browser confirm box. */
export function ConfirmButton({ label, confirmLabel, subject, onConfirm, busy }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <Button size="sm" onClick={() => setArmed(true)} aria-label={`${label} ${subject}`} busy={busy} busyLabel="Working…">
        {label}
      </Button>
    );
  }
  return (
    <span className="button-row button-row--tight">
      <Button
        size="sm"
        variant="primary"
        // The first click moved focus here by replacing the button; keep the keyboard user in place.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        aria-label={`${confirmLabel}: ${subject}`}
      >
        {confirmLabel}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
}

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  title: string;
  onClose: () => void;
  /** `modal` is centred; `drawer` slides over from the right edge for detail views. */
  variant?: 'modal' | 'drawer';
  /** Optional line under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
}

/**
 * An accessible modal surface. Focus moves in on open, Tab cycles inside, Escape and the
 * scrim close it, the page behind is inert and does not scroll, and focus returns to
 * whatever opened it.
 */
export function Dialog({ title, onClose, variant = 'modal', subtitle, children }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const page = document.getElementById('root');
    const overflow = document.body.style.overflow;
    page?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      page?.removeAttribute('inert');
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    // The scrim is a pointer convenience; keyboard users close with Escape or the button.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={`dialog-scrim dialog-scrim--${variant}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={panel}
        className={`dialog dialog--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog__header">
          <div>
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            {subtitle && <p className="dialog__subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="dialog__close" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="dialog__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

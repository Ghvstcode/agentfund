import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../hooks/useMediaQuery';
import { formatExact } from '../lib/format';
import { approach, digitCount, slotLayout, wheelOpacity, wheelPosition } from '../lib/odometer';

/** Time for the displayed number to close ~63% of the gap to a new value. */
const TIME_CONSTANT_MS = 380;
const STRIP = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

interface TokenCounterProps {
  /** The value to show. `undefined` renders a static placeholder of the same height. */
  value: number | undefined;
  /** What the number counts, for screen readers: "tokens delivered". */
  label: string;
  size?: 'hero' | 'xl' | 'lg' | 'md' | 'sm';
  /** `accent` is reserved for live, in-flight amounts. */
  tone?: 'default' | 'accent';
  /** Wheels shown by the placeholder before data arrives. */
  placeholderDigits?: number;
}

/**
 * The live token counter: an odometer of fixed-width digit wheels with thin gaps between
 * thousands. It glides between successive values rather than jumping, never changes
 * height, and grows by a wheel smoothly when the number gains a digit. Screen readers get
 * the exact value as plain text, updated without announcements.
 */
export function TokenCounter({ value, label, size = 'lg', tone = 'default', placeholderDigits = 7 }: TokenCounterProps) {
  const reducedMotion = usePrefersReducedMotion();
  const shown = useRef<number | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const [digits, setDigits] = useState(() => (value === undefined ? placeholderDigits : digitCount(value)));

  /** Move every wheel to where it belongs for `current`. */
  const paint = useCallback((current: number) => {
    const slots = root.current?.querySelectorAll<HTMLElement>('[data-place]') ?? [];
    for (const slot of slots) {
      const place = Number(slot.dataset.place);
      const opacity = wheelOpacity(current, place);
      slot.style.opacity = String(opacity);
      if (slot.dataset.kind === 'separator') {
        slot.style.width = `${opacity * 0.26}em`;
        continue;
      }
      slot.style.width = `${opacity}ch`;
      const strip = slot.firstElementChild as HTMLElement | null;
      if (strip) strip.style.transform = `translateY(${(-wheelPosition(current, place) / STRIP.length) * 100}%)`;
    }
  }, []);

  // A layout effect, so the first value is in place before the browser paints the wheels.
  useLayoutEffect(() => {
    if (value === undefined) return;
    const settle = () => {
      shown.current = value;
      setDigits(digitCount(value));
      paint(value);
    };
    if (shown.current === null || reducedMotion) {
      settle();
      return;
    }
    // Make room for the larger of the two numbers for the duration of the glide.
    setDigits(Math.max(digitCount(value), digitCount(shown.current)));
    let frame = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const next = approach(shown.current ?? value, value, now - previous, TIME_CONSTANT_MS);
      previous = now;
      if (next === value) {
        settle();
        return;
      }
      shown.current = next;
      paint(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reducedMotion, paint]);

  // Wheels that mount when the digit count changes need their position before first paint.
  useLayoutEffect(() => {
    if (shown.current !== null) paint(shown.current);
  }, [digits, paint]);

  const className = `counter counter--${size} counter--${tone}`;

  if (value === undefined) {
    return (
      <span className={`${className} counter--placeholder`} aria-busy="true">
        <span className="sr-only">Loading {label}</span>
        <span aria-hidden="true" className="counter__digits">
          {slotLayout(placeholderDigits).map((slot) =>
            slot.kind === 'separator' ? (
              <span key={`s${slot.place}`} className="counter__separator" />
            ) : (
              <span key={slot.place} className="counter__wheel">
                0
              </span>
            ),
          )}
        </span>
      </span>
    );
  }

  return (
    <span className={className} ref={root}>
      <span className="sr-only">
        {formatExact(value)} {label}
      </span>
      <span aria-hidden="true" className="counter__digits" title={`${formatExact(value)} ${label}`}>
        {slotLayout(digits).map((slot) =>
          slot.kind === 'separator' ? (
            <span key={`s${slot.place}`} className="counter__separator" data-kind="separator" data-place={slot.place} />
          ) : (
            <span key={slot.place} className="counter__wheel" data-kind="digit" data-place={slot.place}>
              <span className="counter__strip">
                {STRIP.map((digit, index) => (
                  <span key={index}>{digit}</span>
                ))}
              </span>
            </span>
          ),
        )}
      </span>
    </span>
  );
}

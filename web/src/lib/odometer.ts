/**
 * Pure maths behind the token counter. The component tweens one real number toward the
 * latest value and asks these functions where each digit wheel sits for that number.
 */

export type Slot = { kind: 'digit'; place: number } | { kind: 'separator'; place: number };

/** How many decimal digits an integer needs (0 needs one). */
export function digitCount(value: number): number {
  return String(Math.max(0, Math.trunc(value))).length;
}

/**
 * Slots for a counter with `digits` wheels, most significant first, with a separator before
 * every group of three. `place` is the power of ten the wheel shows.
 */
export function slotLayout(digits: number): Slot[] {
  const slots: Slot[] = [];
  for (let place = digits - 1; place >= 0; place -= 1) {
    slots.push({ kind: 'digit', place });
    if (place > 0 && place % 3 === 0) slots.push({ kind: 'separator', place });
  }
  return slots;
}

/**
 * Position of the wheel at `place` for a (possibly fractional) value, in digit heights
 * from the top of a 0–9 strip. Like a mechanical odometer: the ones wheel turns
 * continuously, every other wheel rests on its digit and only rolls while the wheel to its
 * right passes from 9 to 0. Integer values always land on whole digits.
 */
export function wheelPosition(value: number, place: number): number {
  const clamped = Math.max(0, value);
  const unit = 10 ** place;
  const whole = Math.floor(clamped / unit);
  const digit = whole % 10;
  if (place === 0) return digit + (clamped - whole);
  // Work in tokens, not fractions of `unit`, so whole numbers stay exact.
  const carry = clamped - whole * unit - (unit - 1);
  return digit + Math.min(1, Math.max(0, carry));
}

/**
 * Opacity of a wheel: leading wheels are hidden until the number reaches them and fade in
 * while they roll from blank to 1.
 */
export function wheelOpacity(value: number, place: number): number {
  if (place === 0) return 1;
  const threshold = 10 ** place;
  if (value >= threshold) return 1;
  return wheelPosition(value, place);
}

/**
 * Exponential approach of `current` toward `target` over `elapsedMs`; `timeConstantMs` is
 * the time to close ~63% of the gap. Snaps when the gap is under half a token so the
 * counter comes to rest on the exact value.
 */
export function approach(current: number, target: number, elapsedMs: number, timeConstantMs: number): number {
  const gap = target - current;
  if (Math.abs(gap) < 0.5 || timeConstantMs <= 0) return target;
  const next = current + gap * (1 - Math.exp(-elapsedMs / timeConstantMs));
  return Math.abs(target - next) < 0.5 ? target : next;
}

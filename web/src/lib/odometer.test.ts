import { describe, expect, it } from 'vitest';
import { approach, digitCount, slotLayout, wheelOpacity, wheelPosition } from './odometer';

describe('slotLayout', () => {
  it('puts a separator before every group of three', () => {
    const kinds = (digits: number) => slotLayout(digits).map((slot) => (slot.kind === 'digit' ? 'd' : '|')).join('');
    expect(kinds(1)).toBe('d');
    expect(kinds(3)).toBe('ddd');
    expect(kinds(4)).toBe('d|ddd');
    expect(kinds(7)).toBe('d|ddd|ddd');
    expect(kinds(9)).toBe('ddd|ddd|ddd');
  });

  it('labels wheels with their power of ten, most significant first', () => {
    const places = slotLayout(4).filter((slot) => slot.kind === 'digit').map((slot) => slot.place);
    expect(places).toEqual([3, 2, 1, 0]);
  });

  it('counts digits', () => {
    expect(digitCount(0)).toBe(1);
    expect(digitCount(9)).toBe(1);
    expect(digitCount(10)).toBe(2);
    expect(digitCount(999_999)).toBe(6);
    expect(digitCount(1_000_000)).toBe(7);
  });
});

describe('wheelPosition', () => {
  it('rests every wheel on its digit for whole numbers', () => {
    const value = 4_071_959;
    const shown = [6, 5, 4, 3, 2, 1, 0].map((place) => wheelPosition(value, place));
    expect(shown).toEqual([4, 0, 7, 1, 9, 5, 9]);
  });

  it('turns the ones wheel continuously', () => {
    expect(wheelPosition(12.25, 0)).toBeCloseTo(2.25);
    expect(wheelPosition(19.5, 0)).toBeCloseTo(9.5);
  });

  it('rolls a higher wheel only while the one below passes 9 to 0', () => {
    expect(wheelPosition(18.9, 1)).toBe(1);
    expect(wheelPosition(19.0, 1)).toBe(1);
    expect(wheelPosition(19.5, 1)).toBeCloseTo(1.5);
    expect(wheelPosition(20, 1)).toBe(2);
    expect(wheelPosition(199.5, 2)).toBeCloseTo(1.5);
    expect(wheelPosition(198.5, 2)).toBe(1);
  });

  it('carries 9 over the top of the strip rather than snapping back', () => {
    expect(wheelPosition(99.75, 1)).toBeCloseTo(9.75);
    expect(wheelPosition(100, 1)).toBe(0);
  });

  it('never goes negative', () => {
    expect(wheelPosition(-5, 0)).toBe(0);
  });
});

describe('wheelOpacity', () => {
  it('hides leading wheels and fades them in as the number reaches them', () => {
    expect(wheelOpacity(5, 0)).toBe(1);
    expect(wheelOpacity(5, 1)).toBe(0);
    expect(wheelOpacity(9.5, 1)).toBeCloseTo(0.5);
    expect(wheelOpacity(10, 1)).toBe(1);
    expect(wheelOpacity(999.5, 3)).toBeCloseTo(0.5);
    expect(wheelOpacity(1234, 3)).toBe(1);
  });
});

describe('approach', () => {
  it('closes about 63% of the gap per time constant', () => {
    expect(approach(0, 1000, 380, 380)).toBeCloseTo(632.1, 0);
  });

  it('moves down as well as up', () => {
    expect(approach(1000, 0, 380, 380)).toBeCloseTo(367.9, 0);
  });

  it('lands exactly on the target', () => {
    expect(approach(999.7, 1000, 16, 380)).toBe(1000);
    let value = 0;
    for (let frame = 0; frame < 600 && value !== 1_000_000; frame += 1) value = approach(value, 1_000_000, 16, 380);
    expect(value).toBe(1_000_000);
  });

  it('is monotonic and never overshoots', () => {
    let value = 0;
    for (let frame = 0; frame < 200; frame += 1) {
      const next = approach(value, 5000, 16, 380);
      expect(next).toBeGreaterThanOrEqual(value);
      expect(next).toBeLessThanOrEqual(5000);
      value = next;
    }
  });
});

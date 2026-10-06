import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenCounter } from './TokenCounter';

const wheels = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-kind="digit"]')];
const separators = (container: HTMLElement) => container.querySelectorAll('[data-kind="separator"]');

/** The digit a wheel is resting on, read back from its transform. */
function restingDigit(wheel: HTMLElement): number {
  const strip = wheel.firstElementChild as HTMLElement;
  const percent = Number(/translateY\((-?[\d.]+)%\)/.exec(strip.style.transform)?.[1] ?? 0);
  // `+ 0` turns the -0 of an untranslated strip into 0.
  return Math.round((-percent / 100) * 11 * 1000) / 1000 + 0;
}

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduced && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('TokenCounter', () => {
  let frames: FrameRequestCallback[] = [];
  let clock = 0;

  /** Run queued animation frames, advancing the clock 16 ms each. */
  const runFrames = (count: number) => {
    act(() => {
      for (let i = 0; i < count && frames.length > 0; i += 1) {
        clock += 16;
        const batch = frames;
        frames = [];
        batch.forEach((callback) => callback(clock));
      }
    });
  };

  beforeEach(() => {
    frames = [];
    clock = 0;
    stubReducedMotion(false);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders a static placeholder before data arrives', () => {
    const { container } = render(<TokenCounter value={undefined} label="tokens delivered" placeholderDigits={7} />);
    expect(screen.getByText('Loading tokens delivered')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('.counter__wheel')).toHaveLength(7);
    expect(frames).toHaveLength(0);
  });

  it('shows the first value at once, with no count-up from zero', () => {
    const { container } = render(<TokenCounter value={1_234_567} label="tokens delivered" />);
    expect(frames).toHaveLength(0);
    expect(wheels(container).map(restingDigit)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(separators(container)).toHaveLength(2);
  });

  it('gives screen readers the exact value without a live region', () => {
    const { container } = render(<TokenCounter value={12_400_000} label="tokens delivered" />);
    expect(screen.getByText('12,400,000 tokens delivered')).toHaveClass('sr-only');
    expect(container.querySelector('[aria-live], [role="status"]')).toBeNull();
    expect(container.querySelector('.counter__digits')).toHaveAttribute('aria-hidden', 'true');
  });

  it('glides to a new value across frames and lands on it exactly', () => {
    const { container, rerender } = render(<TokenCounter value={1000} label="tokens" />);
    rerender(<TokenCounter value={1480} label="tokens" />);

    runFrames(3);
    const midway = restingDigit(wheels(container)[1] as HTMLElement) * 100;
    expect(midway).toBeGreaterThanOrEqual(0);
    expect(midway).toBeLessThan(480);
    expect(frames.length).toBeGreaterThan(0);

    runFrames(400);
    expect(frames).toHaveLength(0);
    expect(wheels(container).map(restingDigit)).toEqual([1, 4, 8, 0]);
    expect(screen.getByText('1,480 tokens')).toBeInTheDocument();
  });

  it('retargets mid-glide when another frame arrives', () => {
    const { container, rerender } = render(<TokenCounter value={100} label="tokens" />);
    rerender(<TokenCounter value={300} label="tokens" />);
    runFrames(5);
    rerender(<TokenCounter value={250} label="tokens" />);
    runFrames(400);
    expect(wheels(container).map(restingDigit)).toEqual([2, 5, 0]);
  });

  it('adds a wheel when the number gains a digit, and every wheel keeps a fixed width', () => {
    const { container, rerender } = render(<TokenCounter value={999} label="tokens" />);
    expect(wheels(container)).toHaveLength(3);
    expect(separators(container)).toHaveLength(0);

    rerender(<TokenCounter value={1002} label="tokens" />);
    expect(wheels(container)).toHaveLength(4);
    runFrames(400);

    expect(wheels(container).map(restingDigit)).toEqual([1, 0, 0, 2]);
    expect(wheels(container).map((wheel) => wheel.style.width)).toEqual(['1ch', '1ch', '1ch', '1ch']);
    expect(separators(container)).toHaveLength(1);
  });

  it('drops leading wheels once a falling number has settled', () => {
    const { container, rerender } = render(<TokenCounter value={1_200_000} label="tokens in flight" />);
    rerender(<TokenCounter value={0} label="tokens in flight" />);
    expect(wheels(container)).toHaveLength(7);
    runFrames(1000);
    expect(wheels(container)).toHaveLength(1);
    expect(wheels(container).map(restingDigit)).toEqual([0]);
  });

  it('jumps straight to the value when reduced motion is requested', () => {
    stubReducedMotion(true);
    const { container, rerender } = render(<TokenCounter value={1000} label="tokens" />);
    rerender(<TokenCounter value={98_765} label="tokens" />);
    expect(frames).toHaveLength(0);
    expect(wheels(container).map(restingDigit)).toEqual([9, 8, 7, 6, 5]);
  });
});

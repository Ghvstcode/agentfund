/** Injectable time source so leases, streaks and day windows are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string = "2026-01-15T12:00:00.000Z") {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
  set(at: Date | string): void {
    this.t = new Date(at).getTime();
  }
}

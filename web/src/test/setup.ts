import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  // Some suites opt into the node environment, where there is no DOM to reset.
  if (typeof window === 'undefined') return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

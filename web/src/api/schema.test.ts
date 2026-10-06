// @vitest-environment node
import { describe, expect, it } from 'vitest';
// The CI-facing script exports the same check it runs from the command line.
import { isUpToDate } from '../../scripts/check-api-types.mjs';

describe('generated API types', () => {
  it('match spec/openapi.yaml (run `pnpm --filter web gen:api` if this fails)', async () => {
    expect(await isUpToDate()).toBe(true);
  });
});

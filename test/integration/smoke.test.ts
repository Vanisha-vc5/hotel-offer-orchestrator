import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSmoke } from '../../scripts/lib/smoke';
import { startTestApp } from '../helpers/app';
import type { TestApp } from '../helpers/app';

/** The smoke checks used against the live deployment, proven against a local app first. */
describe('scripts/lib/smoke.ts', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
    for (const c of ['delhi']) await t.repository.deleteCity(c);
  });
  afterAll(() => t.close());

  it('passes every check against a healthy deployment', async () => {
    const results = await runSmoke(t.baseUrl);
    expect(results.map((r) => [r.check, r.ok, r.detail])).toEqual(
      results.map((r) => [r.check, true, r.detail]),
    );
    expect(results).toHaveLength(5);
  });

  it('fails the contract check when the body differs', async () => {
    t.runner.mode = 'B-down'; // partial: 6 hotels, not the 7-hotel contract
    try {
      const results = await runSmoke(t.baseUrl);
      const contract = results.find((r) => r.check.includes('exact 7-hotel'));
      expect(contract?.ok).toBe(false);
    } finally {
      t.runner.mode = 'ok';
    }
  });
});

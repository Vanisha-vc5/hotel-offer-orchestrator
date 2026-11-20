import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PossibleDuplicate } from '../../src/domain/duplicates';
import { selectBestOffers } from '../../src/domain/selectBestOffers';
import type { Decision } from '../../src/domain/types';
import { supplierAHotels } from '../../src/mocks/supplierA.data';
import { supplierBHotels } from '../../src/mocks/supplierB.data';
import type { DuplicateActivities } from '../../src/temporal/activities/duplicate.activities';
import type { duplicateReviewWorkflow } from '../../src/temporal/workflows';

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const jaipur = selectBestOffers({
  A: supplierAHotels.filter((h) => h.city === 'jaipur'),
  B: supplierBHotels.filter((h) => h.city === 'jaipur'),
}).decisions;

describe('duplicateReviewWorkflow (time-skipping, mocked LLM activity)', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    try {
      Runtime.install({
        logger: silent,
        telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } },
      });
    } catch {
      // already installed by another test file in this process
    }
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  async function review(decisions: Decision[] | null) {
    const judged: string[] = [];
    const saved: PossibleDuplicate[][] = [];
    const activities: DuplicateActivities = {
      async loadDecisions() {
        return decisions;
      },
      async judgeDuplicate(a, b) {
        judged.push(`${a.name}|${b.name}`);
        return {
          verdict: 'different',
          decidedBy: 'llm',
          reason: 'Different properties of the same brand',
        };
      },
      async saveDuplicateReview(_city, r) {
        saved.push(r);
        return true;
      },
    };
    const taskQueue = `dup-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await bundleWorkflowCode({
        workflowsPath: path.resolve(__dirname, '../../src/temporal/workflows/index.ts'),
        logger: silent,
      }),
      activities,
    });
    const result = await worker.runUntil(
      env.client.workflow.execute<typeof duplicateReviewWorkflow>('duplicateReviewWorkflow', {
        taskQueue,
        workflowId: `dup-${randomUUID()}`,
        args: [{ city: 'jaipur' }],
      }),
    );
    return { result, judged, saved };
  }

  it('decides clear pairs by similarity and sends only the ambiguous one to the LLM activity', async () => {
    const { result, judged, saved } = await review(jaipur);
    expect(judged).toEqual(['Taj Rambagh Palace|Taj Jai Mahal Palace']);
    expect(result.map((r) => [r.a.name, r.verdict, r.decidedBy])).toEqual([
      ['Hotel Pearl Palace', 'likely_same', 'similarity'],
      ['Radisson Blu', 'likely_same', 'similarity'],
      ['The Leela Palace', 'likely_same', 'similarity'],
      ['Taj Rambagh Palace', 'different', 'llm'],
    ]);
    expect(result.find((r) => r.a.name === 'Taj Rambagh Palace')).toMatchObject({
      reason: 'Different properties of the same brand',
      potentialSavings: 3000,
    });
    expect(saved).toEqual([result]);
  });

  it('returns [] when the city has no cached data', async () => {
    const { result, saved } = await review(null);
    expect(result).toEqual([]);
    expect(saved).toEqual([]);
  });
});

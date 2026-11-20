/**
 * One Schedule tick: refresh the cache for every warm-up city in parallel.
 *
 * Each city runs as a CHILD hotelOffersWorkflow with the same ID a user request
 * would use (`hotel-offers-<city>`), so warm-ups and user traffic coalesce:
 *  - user request during a warm-up → the client's USE_EXISTING attaches to our child;
 *  - warm-up while a user run is in flight → the child start is rejected as
 *    already-started; that city is reported `coalesced` (it is being refreshed anyway).
 * Child workflows cannot use USE_EXISTING themselves (not in ChildWorkflowOptions).
 *
 * parentClosePolicy ABANDON: user requests may be attached to a child, so if the
 * warm-up parent is terminated or times out, the children must keep running.
 */
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { executeChild, log, workflowInfo } from '@temporalio/workflow';
import { workflowIdForCity } from '../shared';
import type { WarmupCityResult, WarmupInput, WarmupResult } from '../shared';
import type { hotelOffersWorkflow } from './hotelOffers.workflow';

export async function cacheWarmupWorkflow(input: WarmupInput): Promise<WarmupResult> {
  const { runId } = workflowInfo();
  const cities = await Promise.all(
    input.cities.map(async (city): Promise<WarmupCityResult> => {
      try {
        const result = await executeChild<typeof hotelOffersWorkflow>('hotelOffersWorkflow', {
          workflowId: workflowIdForCity(city),
          args: [{ city, requestId: `warmup-${runId}`, tuning: input.tuning }],
          parentClosePolicy: 'ABANDON',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          workflowExecutionTimeout: input.workflowExecutionTimeout ?? '30s',
        });
        return {
          city,
          status: 'refreshed',
          resultStatus: result.resultStatus,
          offers: result.offers.length,
          suppliersStatus: result.suppliersStatus,
        };
      } catch (err) {
        if (err instanceof WorkflowExecutionAlreadyStartedError)
          return { city, status: 'coalesced' };
        const message =
          err instanceof Error
            ? ((err.cause as Error | undefined)?.message ?? err.message)
            : String(err);
        return { city, status: 'failed', error: message };
      }
    }),
  );
  log.info('cache warm-up finished', {
    refreshed: cities.filter((c) => c.status === 'refreshed').length,
    coalesced: cities.filter((c) => c.status === 'coalesced').length,
    failed: cities.filter((c) => c.status === 'failed').length,
  });
  return { cities };
}

/**
 * Workflow code runs in Temporal's deterministic sandbox: no I/O, no Node
 * built-ins. All side effects happen in activities.
 */
import {
  ApplicationFailure,
  defineQuery,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import { FailureTypes } from '../../domain/errors';
import { selectBestOffers } from '../../domain/selectBestOffers';
import type { SupplierHotel, SupplierId, SuppliersStatus } from '../../domain/types';
import type { HotelActivities } from '../activities';
import { DEFAULT_TUNING, STATUS_QUERY } from '../shared';
import type {
  HotelOffersWorkflowInput,
  HotelOffersWorkflowResult,
  WorkflowStatus,
} from '../shared';

/** Live progress of a run: `temporal workflow query --type status` or the UI's Queries tab. */
export const statusQuery = defineQuery<WorkflowStatus>(STATUS_QUERY);

const SUPPLIERS: readonly SupplierId[] = ['A', 'B'];

export async function hotelOffersWorkflow(
  input: HotelOffersWorkflowInput,
): Promise<HotelOffersWorkflowResult> {
  const { city, requestId } = input;
  const tuning = input.tuning ?? DEFAULT_TUNING;
  const { workflowId, runId } = workflowInfo();

  const { fetchSupplierHotels } = proxyActivities<HotelActivities>({
    startToCloseTimeout: tuning.supplierStartToCloseTimeout,
    retry: {
      ...tuning.supplierRetry,
      nonRetryableErrorTypes: [
        FailureTypes.SupplierClientError,
        FailureTypes.SupplierInvalidPayload,
      ],
    },
  });
  const { persistOffers } = proxyActivities<HotelActivities>({
    startToCloseTimeout: tuning.persistStartToCloseTimeout,
    retry: {
      initialInterval: '200ms',
      backoffCoefficient: 2,
      maximumInterval: '2s',
      maximumAttempts: tuning.persistMaximumAttempts,
    },
  });

  const status: WorkflowStatus = {
    step: 'fetching',
    city,
    suppliers: { A: 'pending', B: 'pending' },
  };
  setHandler(statusQuery, () => status);
  log.info('fetching suppliers', { city, requestId });

  // Both suppliers in parallel. allSettled: one failure must not cancel the other.
  const settled = await Promise.allSettled(
    SUPPLIERS.map((supplier) =>
      fetchSupplierHotels(supplier, city, requestId).then(
        (hotels) => {
          status.suppliers[supplier] = 'up';
          return hotels;
        },
        (err: unknown) => {
          status.suppliers[supplier] = 'down';
          log.warn('supplier marked down after retries', {
            supplier,
            city,
            requestId,
            error:
              err instanceof Error
                ? ((err.cause as Error | undefined)?.message ?? err.message)
                : String(err),
          });
          throw err;
        },
      ),
    ),
  );

  const lists: Partial<Record<SupplierId, SupplierHotel[]>> = {};
  const suppliersStatus: SuppliersStatus = { A: 'down', B: 'down' };
  settled.forEach((outcome, i) => {
    const supplier = SUPPLIERS[i] as SupplierId;
    if (outcome.status === 'fulfilled') {
      lists[supplier] = outcome.value;
      suppliersStatus[supplier] = 'up';
    }
  });

  if (suppliersStatus.A === 'down' && suppliersStatus.B === 'down') {
    status.step = 'failed';
    throw ApplicationFailure.create({
      type: FailureTypes.AllSuppliersUnavailable,
      message: 'All suppliers are unavailable',
      nonRetryable: true,
      details: settled.map((s) => (s.status === 'rejected' ? String(s.reason) : null)),
    });
  }

  status.step = 'selecting';
  const { offers, decisions } = selectBestOffers(lists);
  const resultStatus =
    suppliersStatus.A === 'up' && suppliersStatus.B === 'up' ? 'complete' : 'partial';
  const result: HotelOffersWorkflowResult = { offers, suppliersStatus, resultStatus, decisions };

  status.step = 'persisting';
  try {
    await persistOffers(city, { ...result, workflowId, runId, requestId });
  } catch (err) {
    status.step = 'failed';
    throw ApplicationFailure.create({
      type: FailureTypes.CacheUnavailable,
      message: 'Could not persist offers to Redis',
      nonRetryable: true,
      cause: err instanceof Error ? err : undefined,
    });
  }

  status.step = 'done';
  log.info('workflow completed', {
    city,
    requestId,
    winners: offers.length,
    resultStatus,
    suppliers: suppliersStatus,
  });
  return result;
}

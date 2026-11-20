import type { Client } from '@temporalio/client';
import type { PossibleDuplicate } from '../domain/duplicates';
import type { Config } from '../infra/config';
import { TASK_QUEUE } from './shared';
import type { duplicateReviewWorkflow } from './workflows';

/**
 * Starts (or joins, USE_EXISTING) the duplicate review for a city and waits for
 * it. Concurrent insights requests for the same city share one review.
 */
export async function runDuplicateReview(
  client: Client,
  city: string,
  cfg: Config,
): Promise<PossibleDuplicate[]> {
  const handle = await client.connection.withDeadline(
    Date.now() + cfg.TEMPORAL_START_TIMEOUT_MS,
    () =>
      client.workflow.start<typeof duplicateReviewWorkflow>('duplicateReviewWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId: `duplicate-review-${city}`,
        args: [{ city }],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        workflowExecutionTimeout: '1m',
      }),
  );
  return client.connection.withDeadline(Date.now() + 65_000, () => handle.result());
}

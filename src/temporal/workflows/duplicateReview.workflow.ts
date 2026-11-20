/**
 * Report-only near-duplicate review for a cached city: pure similarity scoring
 * in the workflow; ambiguous pairs go to an LLM judge ACTIVITY (non-deterministic
 * work never runs in workflow code); the result is cached in the city's Redis meta.
 */
import { proxyActivities } from '@temporalio/workflow';
import {
  LIKELY_SAME_THRESHOLD,
  findDuplicatePairs,
  similarityVerdict,
  withVerdict,
} from '../../domain/duplicates';
import type { PossibleDuplicate } from '../../domain/duplicates';
import type { DuplicateActivities } from '../activities/duplicate.activities';

const { loadDecisions, saveDuplicateReview } = proxyActivities<DuplicateActivities>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 3 },
});
const { judgeDuplicate } = proxyActivities<DuplicateActivities>({
  // The judge never throws (it falls back to `uncertain`); the timeout covers a hung call.
  startToCloseTimeout: '15s',
  retry: { maximumAttempts: 2 },
});

export async function duplicateReviewWorkflow(input: {
  city: string;
}): Promise<PossibleDuplicate[]> {
  const decisions = await loadDecisions(input.city);
  if (!decisions) return [];
  const pairs = findDuplicatePairs(decisions, input.city);
  const review = await Promise.all(
    pairs.map(async (pair) => {
      if (pair.similarity >= LIKELY_SAME_THRESHOLD) return similarityVerdict(pair);
      const j = await judgeDuplicate(pair.a, pair.b, input.city, pair.similarity);
      return withVerdict(pair, j.verdict, j.decidedBy, j.reason);
    }),
  );
  await saveDuplicateReview(input.city, review);
  return review;
}

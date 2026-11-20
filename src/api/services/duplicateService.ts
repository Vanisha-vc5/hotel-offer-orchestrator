import type { PossibleDuplicate } from '../../domain/duplicates';
import type { HotelRepository } from '../../infra/hotelRepository';

/** Runs the duplicate review (a Temporal workflow in production). */
export type DuplicateReviewRunner = (city: string) => Promise<PossibleDuplicate[]>;

/**
 * Enhancement 6 (FEATURE_DUPLICATES): possible near-duplicates for a city's
 * current cached data. Served from Redis meta when present, otherwise reviewed
 * on demand. The review is cleared automatically with the meta on refresh.
 */
export class DuplicateService {
  constructor(
    private readonly repository: HotelRepository,
    private readonly runReview: DuplicateReviewRunner,
  ) {}

  async get(city: string): Promise<PossibleDuplicate[]> {
    const cached = await this.repository.getPossibleDuplicates(city);
    return cached ?? this.runReview(city);
  }
}

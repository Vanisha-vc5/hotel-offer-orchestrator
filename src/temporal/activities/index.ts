import type { Config } from '../../infra/config';
import type { HotelRepository } from '../../infra/hotelRepository';

export interface ActivityDeps {
  repository: HotelRepository;
  cfg: Config;
}

export function createActivities(_deps: ActivityDeps): Record<string, never> {
  return {};
}

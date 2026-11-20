import type { Redis } from 'ioredis';

/** All Redis read/write logic lives here (filled in during phase 3). */
export class HotelRepository {
  constructor(private readonly redis: Redis) {}

  async ping(): Promise<string> {
    return this.redis.ping();
  }
}

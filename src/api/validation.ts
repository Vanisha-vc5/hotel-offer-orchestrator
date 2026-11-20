import { z } from 'zod';

/**
 * `city`: required, trimmed, inner whitespace collapsed, lowercased.
 * Letters (any script), spaces and hyphens only; max 50 chars.
 */
export const CitySchema = z
  .string({ error: 'city is required' })
  .transform((v) => v.trim().replace(/\s+/g, ' ').toLowerCase())
  .pipe(
    z
      .string()
      .min(1, 'city is required')
      .max(50, 'city must be at most 50 characters')
      .regex(/^[\p{L} -]+$/u, 'city may contain only letters, spaces and hyphens')
      .regex(/\p{L}/u, 'city must contain at least one letter'),
  );

/** Non-negative finite number from a query string. Rejects '', 'abc', 'Infinity', '1e999'. */
const PriceSchema = (name: string): z.ZodType<number | undefined> =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const n = v === '' ? Number.NaN : Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `${name} must be a finite number` });
        return z.NEVER;
      }
      if (n < 0) {
        ctx.addIssue({ code: 'custom', message: `${name} must be >= 0` });
        return z.NEVER;
      }
      return n;
    });

const BoolFlag = z
  .enum(['true', 'false', '1', '0'], { error: 'refresh must be true or false' })
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** Query for GET /api/hotels. Unknown parameters are rejected (strict). */
export const HotelsQuerySchema = z
  .object({
    city: CitySchema,
    minPrice: PriceSchema('minPrice'),
    maxPrice: PriceSchema('maxPrice'),
    refresh: BoolFlag,
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.minPrice !== undefined && q.maxPrice !== undefined && q.minPrice > q.maxPrice) {
      ctx.addIssue({ code: 'custom', path: ['minPrice'], message: 'minPrice must be <= maxPrice' });
    }
  });
export type HotelsQuery = z.infer<typeof HotelsQuerySchema>;

export const InsightsQuerySchema = z.object({ city: CitySchema, refresh: BoolFlag }).strict();

export const CityParamSchema = z.object({ city: CitySchema });

/** Mock supplier endpoints accept an optional, lenient city filter. */
export const SupplierQuerySchema = z.object({
  city: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v.replace(/\s+/g, ' ').toLowerCase() : undefined)),
});

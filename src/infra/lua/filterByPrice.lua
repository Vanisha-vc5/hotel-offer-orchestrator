-- filterByPrice.lua
-- Atomically answers "which offers for this city fall inside [min, max]?" in ONE round trip.
--
-- KEYS[1] hotels:{city}:by_price  sorted set (member = normalized name, score = price)
-- KEYS[2] hotels:{city}:offers    hash (normalized name -> offer JSON)
-- KEYS[3] hotels:{city}:meta      hash (fetchedAt, workflowId, ...)
-- ARGV[1] min score (inclusive; number or "-inf")
-- ARGV[2] max score (inclusive; number or "+inf")
-- ARGV[3..] meta fields to return alongside the offers
--
-- Returns nil when the city is not cached (MISS). An existing meta key with no
-- offers is a valid, cached empty result (HIT with an empty list).

if redis.call('EXISTS', KEYS[3]) == 0 then
  return false
end

local meta = {}
if #ARGV > 2 then
  meta = redis.call('HMGET', KEYS[3], unpack(ARGV, 3))
end

-- ZRANGEBYSCORE is inclusive by default and orders by (score, member) ascending.
local names = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2])
if #names == 0 then
  return { meta, {} }
end

return { meta, redis.call('HMGET', KEYS[2], unpack(names)) }

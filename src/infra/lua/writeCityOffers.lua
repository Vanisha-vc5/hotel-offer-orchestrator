-- writeCityOffers.lua
-- Atomically replaces one city's cached result, with two guards. Same steps the
-- earlier MULTI/EXEC did (DEL → ZADD → HSET offers → HSET meta → EXPIRE), plus
-- conditions MULTI cannot express. Runs as ONE atomic script: readers never see a
-- half-written city, and two writers can never interleave.
--
-- KEYS[1] hotels:{city}:by_price   KEYS[2] hotels:{city}:offers   KEYS[3] hotels:{city}:meta
-- ARGV[1] generation (ms; ordering of the data, newer = larger)
-- ARGV[2] resultStatus ('complete' | 'partial')
-- ARGV[3] ttl seconds (applied to all three keys)
-- ARGV[4] number of meta field/value pairs (n), then 2n meta args
-- then repeated triples: member (normalized name), score (price), offer JSON
--
-- Returns 'written' | 'stale' | 'kept_complete'.

local generation = tonumber(ARGV[1])
local status = ARGV[2]
local ttl = tonumber(ARGV[3])

if redis.call('EXISTS', KEYS[3]) == 1 then
  local current = redis.call('HMGET', KEYS[3], 'generation', 'resultStatus')
  local currentGeneration = tonumber(current[1]) or 0
  -- Version check: an older run (late retry, out-of-order finish) never overwrites newer data.
  if currentGeneration > generation then
    return 'stale'
  end
  -- Cache policy: a partial result never replaces a still-valid COMPLETE result.
  -- (The complete entry expires by its own TTL; the API still returns the fresh
  -- partial result to the caller that ran the workflow.)
  if status == 'partial' and current[2] == 'complete' then
    return 'kept_complete'
  end
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])

local n = tonumber(ARGV[4])
local meta = {}
local i = 5
for _ = 1, n do
  meta[#meta + 1] = ARGV[i]
  meta[#meta + 1] = ARGV[i + 1]
  i = i + 2
end
redis.call('HSET', KEYS[3], unpack(meta))

while i <= #ARGV do
  redis.call('ZADD', KEYS[1], ARGV[i + 1], ARGV[i])
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 2])
  i = i + 3
end

-- EXPIRE on a key that was not created (empty city) is a no-op; meta always exists.
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('EXPIRE', KEYS[3], ttl)
return 'written'

-- Token bucket for one gateway key (README section 13), run atomically inside Redis.
--
-- Reading the bucket, refilling it and taking a token happen in one step, so two
-- requests arriving together can never both take the last token.
--
-- KEYS[1]  the bucket, a hash { tokens, ts }       e.g. rl:key:<gateway key id>
-- ARGV[1]  capacity: the most tokens it can hold    e.g. 60
-- ARGV[2]  refill rate, in tokens per millisecond   e.g. 0.001 (60 per minute)
-- ARGV[3]  cost of this request, in tokens          1
--
-- Returns { allowed (1 or 0), tokens left (a string, since Redis would truncate a
-- fraction), milliseconds until enough tokens are back (0 when allowed) }.

local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

-- Redis's own clock, so every LLMux instance agrees on the time.
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local bucket = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil or ts == nil then
  -- A new (or expired) bucket starts full.
  tokens = capacity
  ts = now
end

tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / rate)
end

redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "ts", tostring(now))
-- Once the bucket would be full again, it is the same as no bucket: let it expire.
redis.call("PEXPIRE", KEYS[1], math.ceil(capacity / rate) + 1000)

return { allowed, tostring(tokens), wait }

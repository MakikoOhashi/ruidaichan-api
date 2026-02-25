export type FreeQuotaDecision = {
  allowed: boolean;
  limit: number;
  used: number;
  used_after: number;
  reset_at: string;
  check_failed: boolean;
  error?: string;
};

type RedisCommandResult = {
  result?: unknown;
  error?: string;
};

const INSTALL_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const FREE_FIRST_MONTH_LIMIT = 10;
const FREE_LATER_MONTH_LIMIT = 5;
const FREE_REQUEST_COST = 1;

const CONSUME_SCRIPT = `
local first = redis.call("GET", KEYS[1])
if not first then
  redis.call("SET", KEYS[1], ARGV[1], "NX")
  first = redis.call("GET", KEYS[1])
end

local first_limit = tonumber(ARGV[2])
local later_limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl_seconds = tonumber(ARGV[5])
local limit = later_limit
if first == ARGV[1] then
  limit = first_limit
end

local current = tonumber(redis.call("GET", KEYS[2]) or "0")
if current + cost > limit then
  return {0, current, limit, first, redis.call("TTL", KEYS[2])}
end

local updated = redis.call("INCRBY", KEYS[2], cost)
redis.call("EXPIRE", KEYS[2], ttl_seconds)
return {1, updated, limit, first, redis.call("TTL", KEYS[2])}
`;

function monthKeyUtc(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}

function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function ttlUntil(date: Date, now: Date): number {
  const seconds = Math.floor((date.getTime() - now.getTime()) / 1000);
  return Math.max(seconds, 1);
}

async function runUpstashCommand(args: Array<string | number>): Promise<RedisCommandResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { error: "upstash_env_missing" };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  let json: RedisCommandResult;
  try {
    json = (await response.json()) as RedisCommandResult;
  } catch {
    return { error: `upstash_invalid_json:${response.status}` };
  }

  if (!response.ok) {
    return { error: `upstash_http_${response.status}` };
  }
  if (typeof json?.error === "string" && json.error.length > 0) {
    return { error: `upstash_error:${json.error}` };
  }
  return json;
}

export function validateInstallId(installId: string): boolean {
  return INSTALL_ID_PATTERN.test(installId);
}

export async function consumeMonthlyFreeQuota(params: {
  installId: string;
  now?: Date;
}): Promise<FreeQuotaDecision> {
  const now = params.now ?? new Date();
  const month = monthKeyUtc(now);
  const resetAtDate = nextMonthStartUtc(now);
  const resetAt = resetAtDate.toISOString();
  const ttlSeconds = ttlUntil(resetAtDate, now);

  const firstMonthKey = `ruidaichan:first_month:${params.installId}`;
  const countKey = `ruidaichan:free:count:${params.installId}:${month}`;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      allowed: true,
      limit: FREE_LATER_MONTH_LIMIT,
      used: 0,
      used_after: 0,
      reset_at: resetAt,
      check_failed: false
    };
  }

  try {
    const result = await runUpstashCommand([
      "EVAL",
      CONSUME_SCRIPT,
      "2",
      firstMonthKey,
      countKey,
      month,
      String(FREE_FIRST_MONTH_LIMIT),
      String(FREE_LATER_MONTH_LIMIT),
      String(FREE_REQUEST_COST),
      String(ttlSeconds)
    ]);

    if (result.error) {
      return {
        allowed: true,
        limit: FREE_LATER_MONTH_LIMIT,
        used: 0,
        used_after: 0,
        reset_at: resetAt,
        check_failed: true,
        error: result.error
      };
    }

    const rows = Array.isArray(result.result) ? result.result : null;
    if (!rows || rows.length < 3) {
      return {
        allowed: true,
        limit: FREE_LATER_MONTH_LIMIT,
        used: 0,
        used_after: 0,
        reset_at: resetAt,
        check_failed: true,
        error: "upstash_bad_eval_result"
      };
    }

    const allowed = Number(rows[0]) === 1;
    const rawUsed = Number(rows[1]);
    const limit = Number(rows[2]);
    const usedAfter = Number.isFinite(rawUsed) ? rawUsed : 0;
    const used = allowed ? Math.max(usedAfter - FREE_REQUEST_COST, 0) : usedAfter;

    return {
      allowed,
      limit: Number.isFinite(limit) ? limit : FREE_LATER_MONTH_LIMIT,
      used,
      used_after: usedAfter,
      reset_at: resetAt,
      check_failed: false
    };
  } catch (error) {
    return {
      allowed: true,
      limit: FREE_LATER_MONTH_LIMIT,
      used: 0,
      used_after: 0,
      reset_at: resetAt,
      check_failed: true,
      error: error instanceof Error ? error.message : "quota_unknown_error"
    };
  }
}

export const __freeQuotaInternals = {
  monthKeyUtc,
  nextMonthStartUtc,
  ttlUntil
};

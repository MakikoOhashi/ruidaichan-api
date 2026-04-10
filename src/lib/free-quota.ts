export type PlanId = "free" | "light" | "premium";
export type PlanProductId = "ruidaichan.light.monthly" | "ruidaichan.premium.monthly";

export type FreeQuotaDecision = {
  plan_id: PlanId;
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

type StoredPlanRecord = {
  plan_id: PlanId;
  product_id: PlanProductId;
  expires_at: string;
  updated_at: string;
};

const INSTALL_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const FREE_FIRST_MONTH_LIMIT = 10;
const FREE_LATER_MONTH_LIMIT = 5;
const LIGHT_MONTH_LIMIT = 50;
const PREMIUM_MONTH_LIMIT = 300;
const FREE_REQUEST_COST = 1;
const PLAN_GRACE_SECONDS = 0;

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

function quotaLimitForPlan(planId: PlanId, firstMonth: boolean): number {
  if (planId === "light") return LIGHT_MONTH_LIMIT;
  if (planId === "premium") return PREMIUM_MONTH_LIMIT;
  return firstMonth ? FREE_FIRST_MONTH_LIMIT : FREE_LATER_MONTH_LIMIT;
}

function planIdForProductId(productId: string): PlanId | null {
  if (productId === "ruidaichan.light.monthly") return "light";
  if (productId === "ruidaichan.premium.monthly") return "premium";
  return null;
}

function resolveCountKey(installId: string, planId: PlanId, month: string): string {
  if (planId === "free") {
    return `ruidaichan:free:count:${installId}:${month}`;
  }
  return `ruidaichan:count:${installId}:${planId}:${month}`;
}

function resolvePlanKey(installId: string): string {
  return `ruidaichan:plan:${installId}`;
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

function decodeStoredPlanRecord(value: unknown): StoredPlanRecord | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredPlanRecord>;
    if (
      (parsed.plan_id === "light" || parsed.plan_id === "premium") &&
      (parsed.product_id === "ruidaichan.light.monthly" || parsed.product_id === "ruidaichan.premium.monthly") &&
      typeof parsed.expires_at === "string" &&
      parsed.expires_at.length > 0 &&
      typeof parsed.updated_at === "string" &&
      parsed.updated_at.length > 0
    ) {
      return parsed as StoredPlanRecord;
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolvePlanId(installId: string, now: Date = new Date()): Promise<PlanId> {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return "free";
  }

  try {
    const result = await runUpstashCommand(["GET", resolvePlanKey(installId)]);
    if (result.error) return "free";
    const record = decodeStoredPlanRecord(result.result);
    if (!record) return "free";
    const expiresAtMs = Date.parse(record.expires_at);
    if (!Number.isFinite(expiresAtMs)) return "free";
    if (expiresAtMs <= now.getTime()) return "free";
    return record.plan_id;
  } catch {
    return "free";
  }
}

export async function syncSubscriptionPlan(params: {
  installId: string;
  productId: string;
  expiresAt: string;
  now?: Date;
}): Promise<
  | { ok: true; plan_id: PlanId; product_id: PlanProductId; expires_at: string }
  | { ok: false; error: string }
> {
  const planId = planIdForProductId(params.productId);
  if (!planId) return { ok: false, error: "unsupported_product_id" };

  const expiresAtMs = Date.parse(params.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return { ok: false, error: "invalid_expires_at" };

  const now = params.now ?? new Date();
  const ttlSeconds = Math.max(Math.floor((expiresAtMs - now.getTime()) / 1000) + PLAN_GRACE_SECONDS, 1);
  const record: StoredPlanRecord = {
    plan_id: planId,
    product_id: params.productId as PlanProductId,
    expires_at: new Date(expiresAtMs).toISOString(),
    updated_at: now.toISOString()
  };

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { ok: false, error: "upstash_env_missing" };
  }

  const result = await runUpstashCommand([
    "SET",
    resolvePlanKey(params.installId),
    JSON.stringify(record),
    "EX",
    String(ttlSeconds)
  ]);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, plan_id: planId, product_id: record.product_id, expires_at: record.expires_at };
}

export async function consumeMonthlyFreeQuota(params: {
  installId: string;
  planId?: PlanId;
  now?: Date;
}): Promise<FreeQuotaDecision> {
  const now = params.now ?? new Date();
  const month = monthKeyUtc(now);
  const resetAtDate = nextMonthStartUtc(now);
  const resetAt = resetAtDate.toISOString();
  const ttlSeconds = ttlUntil(resetAtDate, now);
  const planId = params.planId ?? (await resolvePlanId(params.installId, now));
  const firstMonthLimit = quotaLimitForPlan(planId, true);
  const laterMonthLimit = quotaLimitForPlan(planId, false);

  const firstMonthKey = `ruidaichan:first_month:${params.installId}`;
  const countKey = resolveCountKey(params.installId, planId, month);
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      plan_id: planId,
      allowed: true,
      limit: laterMonthLimit,
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
      String(firstMonthLimit),
      String(laterMonthLimit),
      String(FREE_REQUEST_COST),
      String(ttlSeconds)
    ]);

    if (result.error) {
      return {
        plan_id: planId,
        allowed: true,
        limit: laterMonthLimit,
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
        plan_id: planId,
        allowed: true,
        limit: laterMonthLimit,
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
      plan_id: planId,
      allowed,
      limit: Number.isFinite(limit) ? limit : laterMonthLimit,
      used,
      used_after: usedAfter,
      reset_at: resetAt,
      check_failed: false
    };
  } catch (error) {
    return {
      plan_id: planId,
      allowed: true,
      limit: laterMonthLimit,
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
  ttlUntil,
  quotaLimitForPlan,
  planIdForProductId,
  resolveCountKey,
  resolvePlanId,
  resolvePlanKey,
  decodeStoredPlanRecord
};

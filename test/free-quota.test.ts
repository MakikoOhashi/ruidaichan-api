import assert from "node:assert/strict";
import test from "node:test";
import { __freeQuotaInternals, consumeMonthlyFreeQuota } from "../src/lib/free-quota.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_URL;
  if (ORIGINAL_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_TOKEN;
});

test("consumeMonthlyFreeQuota is bypassed when upstash env is missing", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const result = await consumeMonthlyFreeQuota({ installId: "install-0001" });
  assert.equal(result.allowed, true);
  assert.equal(result.check_failed, false);
  assert.equal(result.plan_id, "free");
  assert.equal(result.limit, 5);
});

test("consumeMonthlyFreeQuota handles first-month limit=10", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: [1, 1, 10, "202602", 123] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

  const result = await consumeMonthlyFreeQuota({ installId: "install-0001", now: new Date("2026-02-15T10:00:00Z") });
  assert.equal(result.allowed, true);
  assert.equal(result.plan_id, "free");
  assert.equal(result.limit, 10);
  assert.equal(result.used_after, 1);
  assert.equal(result.used, 0);
  assert.equal(result.reset_at, "2026-03-01T00:00:00.000Z");
});

test("consumeMonthlyFreeQuota blocks when exceeded", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: [0, 5, 5, "202601", 3600] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

  const result = await consumeMonthlyFreeQuota({ installId: "install-0001", now: new Date("2026-02-15T10:00:00Z") });
  assert.equal(result.allowed, false);
  assert.equal(result.plan_id, "free");
  assert.equal(result.limit, 5);
  assert.equal(result.used, 5);
  assert.equal(result.used_after, 5);
});

test("consumeMonthlyFreeQuota fail-open when upstash request errors", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";

  globalThis.fetch = (async () => {
    throw new Error("network_down");
  }) as typeof fetch;

  const result = await consumeMonthlyFreeQuota({ installId: "install-0001", now: new Date("2026-02-15T10:00:00Z") });
  assert.equal(result.allowed, true);
  assert.equal(result.check_failed, true);
  assert.equal(result.plan_id, "free");
  assert.equal(result.error, "network_down");
});

test("consumeMonthlyFreeQuota supports light plan monthly limit", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: [1, 1, 50, "202602", 123] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

  const result = await consumeMonthlyFreeQuota({
    installId: "install-0002",
    planId: "light",
    now: new Date("2026-02-15T10:00:00Z")
  });
  assert.equal(result.allowed, true);
  assert.equal(result.plan_id, "light");
  assert.equal(result.limit, 50);
});

test("consumeMonthlyFreeQuota supports premium plan monthly limit", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: [1, 1, 300, "202602", 123] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

  const result = await consumeMonthlyFreeQuota({
    installId: "install-0003",
    planId: "premium",
    now: new Date("2026-02-15T10:00:00Z")
  });
  assert.equal(result.allowed, true);
  assert.equal(result.plan_id, "premium");
  assert.equal(result.limit, 300);
});

test("free quota ttl aligns to next month UTC", () => {
  const now = new Date("2026-02-28T23:59:30Z");
  const next = __freeQuotaInternals.nextMonthStartUtc(now);
  const ttl = __freeQuotaInternals.ttlUntil(next, now);
  assert.equal(next.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(ttl, 30);
  assert.equal(__freeQuotaInternals.monthKeyUtc(now), "202602");
});

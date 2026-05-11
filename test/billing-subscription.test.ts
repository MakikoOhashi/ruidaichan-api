import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createExpressFetch } from "./helpers/express-local-fetch.js";
import { getFetchUrl } from "./helpers/fetch-utils.js";

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  process.env.API_KEY = "test-key";

  const app = createApp();
  const baseUrl = "http://local.test";
  const previousFetch = globalThis.fetch;
  const localFetch = createExpressFetch(app, baseUrl);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = getFetchUrl(input);
    if (String(url).startsWith(baseUrl)) {
      return localFetch(input, init);
    }
    return previousFetch(input, init);
  }) as typeof fetch;

  try {
    await fn(baseUrl);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("/billing/sync_subscription stores light monthly subscription", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  globalThis.fetch = (async (input, init) => {
    const url = getFetchUrl(input);
    if (url === "https://example.upstash.io") {
      return new Response(JSON.stringify({ result: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/billing/sync_subscription`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-key",
          "x-install-id": "test-install-id"
        },
        body: JSON.stringify({
          product_id: "ruidaichan.light.monthly",
          expires_at: "2026-05-10T00:00:00.000Z"
        })
      });

      const body = (await res.json()) as {
        ok: boolean;
        plan_id: string;
        product_id: string;
        expires_at: string;
      };
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.plan_id, "light");
      assert.equal(body.product_id, "ruidaichan.light.monthly");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
});

test("/billing/sync_subscription rejects unsupported product ids", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/billing/sync_subscription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "x-install-id": "test-install-id"
      },
      body: JSON.stringify({
        product_id: "ruidaichan.unknown.monthly",
        expires_at: "2026-05-10T00:00:00.000Z"
      })
    });

    const body = (await res.json()) as { error: string };
    assert.equal(res.status, 400);
    assert.equal(body.error, "unsupported_product_id");
  });
});

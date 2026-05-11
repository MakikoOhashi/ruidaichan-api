import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createExpressFetch } from "./helpers/express-local-fetch.js";
import { getFetchUrl } from "./helpers/fetch-utils.js";

async function startServer() {
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
  return {
    baseUrl,
    close: async () => {
      globalThis.fetch = previousFetch;
    }
  };
}

test("/extract boundary errors are stable", async () => {
  process.env.API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;

  const server = await startServer();

  try {
    const emptyRes = await fetch(`${server.baseUrl}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ ocr_text: "", locale: "ja-JP" })
    });
    assert.equal(emptyRes.status, 400);

    const noiseRes = await fetch(`${server.baseUrl}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ ocr_text: "  --- ...   ", locale: "ja-JP" })
    });
    assert.equal(noiseRes.status, 400);

    const longRes = await fetch(`${server.baseUrl}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ ocr_text: "a".repeat(20001), locale: "ja-JP" })
    });
    assert.equal(longRes.status, 413);

    const upstreamRes = await fetch(`${server.baseUrl}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ ocr_text: "りんごが3こ", locale: "ja-JP" })
    });
    assert.equal(upstreamRes.status, 502);
    const upstreamBody = (await upstreamRes.json()) as { request_id?: string };
    assert.equal(typeof upstreamBody.request_id, "string");
  } finally {
    await server.close();
  }
});

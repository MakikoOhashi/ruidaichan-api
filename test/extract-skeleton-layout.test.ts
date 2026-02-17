import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  process.env.API_KEY = "test-key";

  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("extract_skeleton_layout normal case returns two_column_rows", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({
        image_base64: "a".repeat(128),
        locale: "ja-JP"
      })
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      spec_version: string;
      layout_family: string;
      slot_schema: { rows: number; cols: number };
    };

    assert.equal(body.spec_version, "layout_skeleton_v1");
    assert.equal(body.layout_family, "two_column_rows");
    assert.equal(body.slot_schema.rows >= 1, true);
    assert.equal(body.slot_schema.cols >= 1, true);
  });
});

test("extract_skeleton_layout unknown case returns blocking undefined", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({
        image_base64: "%%%",
        locale: "ja-JP"
      })
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      layout_family: string;
      undefineds: Array<{ severity: string }>;
    };

    assert.equal(body.layout_family, "unknown");
    assert.equal(body.undefineds.length > 0, true);
    assert.equal(body.undefineds[0]?.severity, "blocking");
  });
});

test("extract_skeleton_layout invalid schema input still returns unknown with 200", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ locale: "ja-JP" })
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      layout_family: string;
      undefineds: Array<{ reason: string; severity: string }>;
    };

    assert.equal(body.layout_family, "unknown");
    assert.equal(body.undefineds.some((u) => u.reason === "invalid_request_schema"), true);
    assert.equal(body.undefineds.some((u) => u.severity === "blocking"), true);
  });
});

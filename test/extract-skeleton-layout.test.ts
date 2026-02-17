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

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

test("panel normal: returns two_column_rows", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({
        image_base64: b64("r1c1 r1c2 r2c1 r2c2 ○をかこう"),
        locale: "ja-JP"
      })
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      spec_version: string;
      layout_family: string;
      unknown_reason?: string;
      slot_schema: { rows: number; cols: number };
    };

    assert.equal(body.spec_version, "layout_skeleton_v1");
    assert.equal(body.layout_family, "two_column_rows");
    assert.equal("unknown_reason" in body, false);
    assert.equal(body.slot_schema.rows >= 2, true);
    assert.equal(body.slot_schema.cols, 2);
  });
});

test("word problem + choices: returns unknown and blocking", async () => {
  await withServer(async (baseUrl) => {
    const text = "（1）つぎから1つ選びなさい ① ② ③ ④ （2）つぎから1つ選びなさい ① ② ③";
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ image_base64: b64(text), locale: "ja-JP" })
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      layout_family: string;
      unknown_reason?: string;
      undefineds: Array<{ severity: string }>;
    };

    assert.equal(body.layout_family, "unknown");
    assert.equal(["not_supported_in_v1", "ambiguous"].includes(body.unknown_reason ?? ""), true);
    assert.equal(body.undefineds.some((u) => u.severity === "blocking"), true);
  });
});

test("insufficient signals: returns unknown with insufficient_signals", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ image_base64: b64("hello world"), locale: "ja-JP" })
    });

    const body = (await res.json()) as { layout_family: string; unknown_reason?: string };
    assert.equal(body.layout_family, "unknown");
    assert.equal(body.unknown_reason, "insufficient_signals");
  });
});

test("low confidence: returns unknown with low_confidence", async () => {
  await withServer(async (baseUrl) => {
    const text = "r1c1 r1c2 r2c1 r2c2 ○をかこう LOW_CONFIDENCE";
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ image_base64: b64(text), locale: "ja-JP" })
    });

    const body = (await res.json()) as { layout_family: string; unknown_reason?: string };
    assert.equal(body.layout_family, "unknown");
    assert.equal(body.unknown_reason, "low_confidence");
  });
});

test("backward compatibility: spec_version fixed and contract shape preserved", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/extract_skeleton_layout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key"
      },
      body: JSON.stringify({ image_base64: b64("x"), locale: "ja-JP" })
    });

    const body = (await res.json()) as {
      spec_version: string;
      layout_family: string;
      slot_schema: unknown;
      body_regions: unknown;
      undefineds: unknown;
      debug: unknown;
    };

    assert.equal(body.spec_version, "layout_skeleton_v1");
    assert.equal(typeof body.layout_family, "string");
    assert.equal(typeof body.slot_schema, "object");
    assert.equal(Array.isArray(body.body_regions), true);
    assert.equal(Array.isArray(body.undefineds), true);
    assert.equal(typeof body.debug, "object");
  });
});

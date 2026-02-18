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

test("equation mode returns expression items", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "4 + □ = 10", N: 5, difficulty: "same", seed: "eq" })
    });

    const body = (await res.json()) as {
      spec_version: string;
      detected_mode: string;
      required_items: string[];
      items: Array<{ type: string }>;
      problems: Array<{ items: Array<{ type: string }>; family: string }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.spec_version, "micro_problem_render_v1");
    assert.equal(body.detected_mode, "equation");
    assert.deepEqual(body.required_items, ["expression"]);
    assert.equal(body.items.some((i) => i.type === "expression"), true);
    assert.equal(body.problems.every((p) => p.items.some((i) => i.type === "expression")), true);
  });
});

test("word_problem(compare) returns prompt+choices with correct_index", async () => {
  await withServer(async (baseUrl) => {
    const text = "あかは18こ、きいろは23こ。あか27こ、きいろ12こふえました。どちらが何こ多いですか。あわせて。";
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text, N: 4, difficulty: "same", seed: "cmp" })
    });

    const body = (await res.json()) as {
      detected_mode: string;
      required_items: string[];
      detected: { family: string };
      need_confirm: boolean;
      problems: Array<{ family: string; items: Array<{ type: string; correct_index?: number }> }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected.family, "compare_totals_diff_mc");
    assert.equal(body.detected_mode, "word_problem");
    assert.deepEqual(body.required_items, ["prompt", "choices"]);
    assert.equal(body.need_confirm, false);
    assert.equal(body.problems.every((p) => p.family === "compare_totals_diff_mc"), true);
    assert.equal(
      body.problems.every((p) => p.items.some((i) => i.type === "choices" && Number.isInteger(i.correct_index))),
      true
    );
  });
});

test("count policy enforces max 5 for compare", async () => {
  await withServer(async (baseUrl) => {
    const text = "あかは10こ、きいろは8こ。あか5こ、きいろ2こふえました。どちらが何こ多い？あわせて。";
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text, N: 10, difficulty: "same", seed: "limit" })
    });

    const body = (await res.json()) as {
      meta: { max_count: number; applied_count: number; count_policy: string };
      problems: unknown[];
    };

    assert.equal(res.status, 200);
    assert.equal(body.meta.count_policy, "server_enforced");
    assert.equal(body.meta.max_count, 5);
    assert.equal(body.meta.applied_count, 5);
    assert.equal(body.problems.length, 5);
  });
});

test("fail-closed: mode/items mismatch returns unknown with empty problems", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "AはBの2ばいです。", N: 4, difficulty: "same", seed: "amb" })
    });

    const body = (await res.json()) as {
      detected_mode: string;
      items: unknown[];
      problems: unknown[];
      need_confirm: boolean;
      meta: { note: string };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "unknown");
    assert.equal(body.items.length, 0);
    assert.equal(body.problems.length, 0);
    assert.equal(body.need_confirm, true);
    assert.equal(body.meta.note, "insufficient_signals");
  });
});

test("compatibility: family/params/render_text/answer remain", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "□ + 3 = 9", N: 4, difficulty: "easy", seed: 10 })
    });

    const body = (await res.json()) as {
      schema_version: string;
      request_id: string;
      confidence: number;
      problems: Array<{ family: string; params: Record<string, unknown>; render_text: string; answer: number }>;
      debug?: { deploy_commit?: string };
    };

    assert.equal(res.status, 200);
    assert.equal(body.schema_version, "micro_generate_response_v1");
    assert.equal(typeof body.request_id, "string");
    assert.equal(typeof body.confidence, "number");
    assert.equal(body.problems.length > 0, true);
    assert.equal(typeof body.problems[0].family, "string");
    assert.equal(typeof body.problems[0].params, "object");
    assert.equal(typeof body.problems[0].render_text, "string");
    assert.equal(typeof body.problems[0].answer, "number");
    assert.equal(typeof body.debug?.deploy_commit, "string");
  });
});

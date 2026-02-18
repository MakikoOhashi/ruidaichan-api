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

async function withMockFetch(
  handler: (
    original: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => Promise<Response>,
  fn: () => Promise<void>
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    handler(original, input, init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
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

test("same seed returns same theme_id", async () => {
  await withServer(async (baseUrl) => {
    const payload = {
      text: "あかは18こ、きいろは23こ。あか27こ、きいろ12こふえました。どちらが何こ多いですか。あわせて。",
      N: 4,
      difficulty: "same",
      seed: "apple"
    };
    const headers = { "Content-Type": "application/json", "x-api-key": "test-key" };

    const r1 = await fetch(`${baseUrl}/micro/generate`, { method: "POST", headers, body: JSON.stringify(payload) });
    const r2 = await fetch(`${baseUrl}/micro/generate`, { method: "POST", headers, body: JSON.stringify(payload) });
    const b1 = (await r1.json()) as { meta: { theme_id: string; theme_policy: string } };
    const b2 = (await r2.json()) as { meta: { theme_id: string } };

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(b1.meta.theme_id, b2.meta.theme_id);
    assert.equal(b1.meta.theme_policy, "seed_deterministic");
  });
});

test("different seed changes theme_id for word_problem", async () => {
  await withServer(async (baseUrl) => {
    const text = "あかは18こ、きいろは23こ。あか27こ、きいろ12こふえました。どちらが何こ多いですか。あわせて。";
    const headers = { "Content-Type": "application/json", "x-api-key": "test-key" };

    const r1 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, N: 4, difficulty: "same", seed: "apple" })
    });
    const r2 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, N: 4, difficulty: "same", seed: "banana" })
    });
    const b1 = (await r1.json()) as { meta: { theme_id: string; theme_candidates: string[] } };
    const b2 = (await r2.json()) as { meta: { theme_id: string; theme_candidates: string[] } };

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(b1.meta.theme_id, b2.meta.theme_id);
    assert.equal(b1.meta.theme_candidates.includes(b1.meta.theme_id), true);
    assert.equal(b2.meta.theme_candidates.includes(b2.meta.theme_id), true);
  });
});

test("single generate keeps one theme across all problems", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "あかは18こ、きいろは23こ。あか27こ、きいろ12こふえました。どちらが何こ多いですか。あわせて。",
        N: 5,
        difficulty: "same",
        seed: "apple"
      })
    });

    const body = (await res.json()) as {
      meta: { theme_id: string };
      problems: Array<{ render_text: string; params: Record<string, unknown> }>;
    };
    const subjectASet = new Set(body.problems.map((p) => String(p.params.subject_a ?? "")));
    const subjectBSet = new Set(body.problems.map((p) => String(p.params.subject_b ?? "")));
    const unitSet = new Set(body.problems.map((p) => String(p.params.unit ?? "")));

    assert.equal(res.status, 200);
    assert.equal(typeof body.meta.theme_id, "string");
    assert.equal(subjectASet.size, 1);
    assert.equal(subjectBSet.size, 1);
    assert.equal(unitSet.size, 1);
    assert.equal(body.problems.every((p) => p.render_text.includes(String([...subjectASet][0]))), true);
  });
});

test("compatibility plus items contract remain with theme meta", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "あかは18こ、きいろは23こ。あか27こ、きいろ12こふえました。どちらが何こ多いですか。あわせて。",
        N: 4,
        difficulty: "same",
        seed: "apple"
      })
    });

    const body = (await res.json()) as {
      detected_mode: string;
      required_items: string[];
      items: Array<{ type: string }>;
      meta: { theme_id?: string };
      problems: Array<{ family: string; params: Record<string, unknown>; render_text: string; answer: number }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "word_problem");
    assert.equal(body.required_items.includes("prompt"), true);
    assert.equal(body.items.some((i) => i.type === "choices"), true);
    assert.equal(typeof body.meta.theme_id, "string");
    assert.equal(typeof body.problems[0].family, "string");
    assert.equal(typeof body.problems[0].params, "object");
    assert.equal(typeof body.problems[0].render_text, "string");
    assert.equal(typeof body.problems[0].answer, "number");
  });
});

test("image fixture is stable across two calls (detector path and mode)", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return original(input, init);
    }
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  family: "compare_totals_diff_mc",
                  confidence: 0.91,
                  params: { a: 18, b: 23, c: 27, d: 12 }
                })
              }
            ]
          }
        }
      ]
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await withServer(async (baseUrl) => {
      const bodyPayload = {
        image_base64: "data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==",
        N: 4,
        difficulty: "same",
        seed: "fixed-seed"
      };
      const headers = { "Content-Type": "application/json", "x-api-key": "test-key" };

      const r1 = await fetch(`${baseUrl}/micro/generate`, { method: "POST", headers, body: JSON.stringify(bodyPayload) });
      const r2 = await fetch(`${baseUrl}/micro/generate`, { method: "POST", headers, body: JSON.stringify(bodyPayload) });

      const b1 = (await r1.json()) as { detected_mode: string; debug: { selected_detector_path: string } };
      const b2 = (await r2.json()) as { detected_mode: string; debug: { selected_detector_path: string } };

      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(b1.debug.selected_detector_path, "image_gemini_detector");
      assert.equal(b2.debug.selected_detector_path, "image_gemini_detector");
      assert.equal(b1.detected_mode, b2.detected_mode);
    });
  });
});

test("image detector retries once and succeeds without unknown", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let callCount = 0;

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return original(input, init);
    }
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: "temporary" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }

    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  family: "times_scale_mc",
                  confidence: 0.88,
                  params: { base: 15, multiplier: 2 }
                })
              }
            ]
          }
        }
      ]
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
          image_base64: "data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==",
          N: 4,
          difficulty: "same",
          seed: "retry-seed"
        })
      });

      const body = (await res.json()) as {
        detected_mode: string;
        detected: { family: string };
        meta: { fallback_count: number };
        debug: { selected_detector_path: string; detector_fallback_reason: string | null };
      };

      assert.equal(res.status, 200);
      assert.equal(body.detected.family, "times_scale_mc");
      assert.equal(body.detected_mode, "word_problem");
      assert.equal(body.debug.selected_detector_path, "image_gemini_detector");
      assert.equal(body.debug.detector_fallback_reason, null);
      assert.equal(body.meta.fallback_count, 1);
    });
  });
});

test("image detector fails twice then returns unknown with concrete note", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return original(input, init);
    }
    return new Response(JSON.stringify({ error: "quota" }), { status: 429, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
          image_base64: "data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==",
          N: 4,
          difficulty: "same",
          seed: "retry-fail-seed"
        })
      });

      const body = (await res.json()) as {
        detected_mode: string;
        problems: unknown[];
        meta: { note: string; fallback_count: number };
        debug: { selected_detector_path: string; detector_fallback_reason: string | null; model_http_status: number | null };
      };

      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "unknown");
      assert.equal(body.problems.length, 0);
      assert.equal(body.meta.note, "model_429");
      assert.equal(body.meta.fallback_count, 1);
      assert.equal(body.debug.selected_detector_path, "image_base64_decode_text_detector");
      assert.equal(body.debug.detector_fallback_reason, "model_429");
      assert.equal(body.debug.model_http_status, 429);
    });
  });
});

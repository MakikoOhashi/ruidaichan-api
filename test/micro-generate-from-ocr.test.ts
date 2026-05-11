import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createExpressFetch } from "./helpers/express-local-fetch.js";
import { getFetchBody, getFetchUrl } from "./helpers/fetch-utils.js";

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

test.describe("micro-generate-from-ocr (serial)", { concurrency: 1 }, () => {

async function parseJsonBody<T>(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fallback: string = "{}"
): Promise<T> {
  const text = await getFetchBody(input, init);
  try {
    return JSON.parse(text || fallback) as T;
  } catch {
    return JSON.parse(fallback) as T;
  }
}

function getGeminiPrompt(body: { contents?: Array<{ parts?: Array<{ text?: string }> }> }): string {
  const contents = body.contents ?? [];
  const texts: string[] = [];
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (typeof part.text === "string" && part.text.length > 0) texts.push(part.text);
    }
  }
  return texts.join("\n");
}

function hasRole(prompt: string, role: string): boolean {
  return new RegExp(String.raw`(?:^|\\b)${role}(?:\\b|$)`).test(prompt);
}

function geminiResponse(obj: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("/micro/generate_from_ocr returns renderable items with light checks", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});

    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "まいにち8問ずつれんしゅうします。7日では何問ですか。つぎから1つえらびなさい。",
            choices: ["48", "56", "64", "72", "80"]
          },
          {
            prompt: "1日に6こずつシールをあつめます。5日では何こですか。つぎから1つえらびなさい。",
            choices: ["20", "24", "30", "36", "40"]
          }
        ]
      });
    }

    if (prompt.includes("solver_v") && prompt.includes("8問")) {
      return geminiResponse({ answer_value: 56, correct_index: 1, equation: "8*7", check_trace: "8を7回たす" });
    }

    if (prompt.includes("solver_v") && prompt.includes("6こ")) {
      return geminiResponse({ answer_value: 30, correct_index: 2, equation: "6*5", check_trace: "6を5回たす" });
    }

    return geminiResponse({ answer_value: 10, correct_index: 0, equation: "1+9" });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "けいさんのれんしゅうです。つぎから1つえらびなさい。どうなりますか。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: 123
        })
      });

      const body = (await res.json()) as {
        spec_version: string;
        detected_mode: string;
        required_items: string[];
        items: Array<{ type: string }>;
        applied_count: number;
        requested_count: number;
        need_confirm: boolean;
        problems: Array<{ prompt: string }>;
        meta: { note: string; grade_band_applied: string; plan_id: string };
        debug: { kanji_guard: { checked: boolean; violations_count: number; rewrite_attempts: number } };
      };

      assert.equal(res.status, 200);
      assert.equal(body.spec_version, "micro_problem_render_v1");
      assert.equal(body.detected_mode, "word_problem");
      assert.deepEqual(body.required_items, ["prompt"]);
      assert.equal(body.items.some((i) => i.type === "prompt"), true);
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.requested_count, 4);
      assert.equal(body.need_confirm, false);
      assert.equal(body.problems.length > 0, true);
      assert.equal(body.meta.grade_band_applied === "g1" || body.meta.grade_band_applied === "g2_g3", true);
      assert.equal(body.meta.plan_id, "free");
      assert.equal(body.debug.kanji_guard.checked, true);
      assert.equal(body.meta.note === "ok" || body.meta.note === "partial_success", true);
    });
  });
});

test("Case A: Japanese addition word problem is classified as add_change (not repeat_multiply) and generates locally", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});
    throw new Error("Gemini should not be called for simple addition word problems");
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "【もんだい】こうえんにはとが8わいました。あとから5わとんできました。こうえんにはとがぜんぶでなんわになりましたか。【しき】【こたえ】",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "case-a"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        problems: Array<{ prompt: string }>;
        debug: { source_category: string };
      };

      assert.equal(res.status, 200);
      assert.equal(body.debug.source_category, "add_change");
      assert.notEqual(body.debug.source_category, "repeat_multiply");
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.problems.length > 0, true);
    });
  });
});

test("Case B: Japanese equal sharing division is classified as split_equal and generates locally", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});
    throw new Error("Gemini should not be called for simple split_equal word problems");
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "子どもが8人います。48本のペンを同じ数ずつ分けます。1人分は何本ですか。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "case-b"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        problems: Array<{ prompt: string }>;
        debug: { source_category: string };
      };

      assert.equal(res.status, 200);
      assert.equal(body.debug.source_category, "split_equal");
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.problems.length > 0, true);
    });
  });
});

test("Case C: Gemini 400 returns failure payload and quota is refunded", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";

  let consumeCalls = 0;
  let refundCalls = 0;

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (url === "https://upstash.test") {
      const args = await parseJsonBody<unknown[]>(input, init, "[]");
      const cmd = String(args[0] ?? "");
      if (cmd === "EVAL") {
        const script = String(args[1] ?? "");
        if (script.includes("INCRBY")) {
          consumeCalls += 1;
          return new Response(JSON.stringify({ result: [1, 1, 5, "202605", 1000] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        refundCalls += 1;
        return new Response(JSON.stringify({ result: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ result: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("googleapis.com")) {
      return new Response(JSON.stringify({ error: { message: "schema invalid" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    throw new Error(`Unhandled fetch mock: ${url}`);
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "これはテストです。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "case-c"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        reasons: Record<string, number>;
        meta: { failure_code: string; quota_used_after: number };
      };

      assert.equal(res.status, 200);
      assert.equal(body.applied_count, 0);
      assert.equal(body.meta.failure_code, "generation_failed");
      assert.equal((body.reasons.gemini_http_400 ?? 0) > 0, true);
      assert.equal(consumeCalls >= 1, true);
      assert.equal(refundCalls >= 1, true);
      assert.equal(body.meta.quota_used_after, 0);
    });
  });
});

});

test("/micro/generate_from_ocr returns partial_success when light checks reject invalid outputs", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});

    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "3日で毎日9こずつ。ぜんぶで何こ？",
            choices: ["18", "21", "24", "27", "30"]
          }
        ]
      });
    }

    if (prompt.includes("solver_v")) {
      // Intentionally wrong index/answer mapping to trigger light validation reject.
      return geminiResponse({ answer_value: 27, correct_index: 0, equation: "9*3" });
    }

    return geminiResponse({ answer_value: 10, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "毎日9こ。3日。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "partial"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        requested_count: number;
        need_confirm: boolean;
        meta: { note: string };
        reasons: Record<string, number>;
      };

      assert.equal(res.status, 200);
      assert.equal(body.requested_count, 4);
      assert.equal(body.applied_count < body.requested_count, true);
      assert.equal(body.meta.note === "partial_success" || body.meta.note === "unknown_no_viable_candidate", true);
      if (body.applied_count === 0) {
        assert.equal(body.need_confirm, true);
      }
    });
  });
});

test("/micro/generate_from_ocr uses fill retry to avoid very low applied_count", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let generationCallCount = 0;
  let solverCallCount = 0;

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      generationCallCount += 1;
      if (generationCallCount === 1) {
        return geminiResponse({
          problems: [
            { prompt: "8 + 3 - 2 = □", choices: ["8", "9", "10", "11", "12"] },
            { prompt: "7 + 2 - 1 = □", choices: ["6", "7", "8", "9", "10"] }
          ]
        });
      }
      return geminiResponse({
        problems: [
          { prompt: "10 + 4 - 3 = □", choices: ["9", "10", "11", "12", "13"] },
          { prompt: "9 + 5 - 6 = □", choices: ["6", "7", "8", "9", "10"] },
          { prompt: "12 + 1 - 4 = □", choices: ["7", "8", "9", "10", "11"] }
        ]
      });
    }

    if (prompt.includes("solver_v")) {
      solverCallCount += 1;
      if (solverCallCount <= 2) {
        return geminiResponse({ answer_value: 99, correct_index: 0, equation: "bad" }); // force reject
      }
      if (prompt.includes("10 + 4 - 3")) {
        return geminiResponse({ answer_value: 11, correct_index: 2, equation: "10+4-3" });
      }
      if (prompt.includes("9 + 5 - 6")) {
        return geminiResponse({ answer_value: 8, correct_index: 2, equation: "9+5-6" });
      }
      if (prompt.includes("12 + 1 - 4")) {
        return geminiResponse({ answer_value: 9, correct_index: 2, equation: "12+1-4" });
      }
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "fallback" });
    }

    return geminiResponse({ answer_value: 11, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "8 + 5 - 3 = □",
          count: 5,
          grade_band: "g1_g3",
          language: "ja",
          seed: "fill-retry"
        })
      });

      const body = (await res.json()) as { applied_count: number; meta: { note: string } };
      assert.equal(res.status, 200);
      assert.equal(generationCallCount >= 2, true);
      assert.equal(body.applied_count >= 3, true);
      assert.equal(
        body.meta.note === "partial_success_filled" ||
          body.meta.note === "partial_success" ||
          body.meta.note === "ok" ||
          body.meta.note === "problem_language_fallback",
        true
      );
    });
  });
});

test("/micro/generate_from_ocr caps word_problem count=10 to max 5", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let generatorCalls = 0;

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      generatorCalls += 1;
      return geminiResponse({
        problems: Array.from({ length: 5 }, (_, i) => ({
          prompt: `まいにち${i + 1}こずつあつめます。5にちでなんこですか。`,
          choices: ["5", "10", "15", "20", "25"]
        }))
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 5, correct_index: 0, equation: "1*5" });
    }
    return geminiResponse({ answer_value: 5, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "けいさんのもんだいです。つぎから1つえらびなさい。どうなりますか。",
          count: 10,
          grade_band: "g1",
          language: "ja",
          seed: "cap-word"
        })
      });

      const body = (await res.json()) as {
        requested_count: number;
        applied_count: number;
        meta: { max_count: number; target_count: number };
      };
      assert.equal(res.status, 200);
      assert.equal(body.requested_count, 10);
      assert.equal(body.meta.max_count, 5);
      assert.equal(body.meta.target_count, 5);
      assert.equal(body.applied_count <= 5, true);
      assert.equal(generatorCalls, 1);
    });
  });
});

test("/micro/generate_from_ocr keeps equation count=10", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let generatorCalls = 0;

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      generatorCalls += 1;
      return geminiResponse({
        problems: Array.from({ length: 5 }, (_, i) => ({
          prompt: `${i + 1} + 4 = □`,
          choices: ["5", "6", "7", "8", "9"]
        }))
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 5, correct_index: 0, equation: "1+4" });
    }
    return geminiResponse({ answer_value: 5, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "7 + 9 - 6 = □",
          count: 10,
          grade_band: "g1_g3",
          language: "ja",
          seed: "keep-equation"
        })
      });

      const body = (await res.json()) as {
        requested_count: number;
        applied_count: number;
        meta: { max_count: number; target_count: number };
      };
      assert.equal(res.status, 200);
      assert.equal(body.requested_count, 10);
      assert.equal(body.meta.max_count, 10);
      assert.equal(body.meta.target_count, 10);
      assert.equal(body.applied_count, 10);
      assert.equal(generatorCalls, 2);
    });
  });
});

test("/micro/generate_from_ocr respects multiplication hint from noisy OCR", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});

    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);
    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          { prompt: "5 + 3 = □" },
          { prompt: "7 × 6 = □" },
          { prompt: "12 - 4 = □" },
          { prompt: "9 × 4 = □" }
        ]
      });
    }
    return geminiResponse({ problems: [] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "== x (9)。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "mul-hint"
        })
      });

      const body = (await res.json()) as {
        detected_mode: string;
        problems: Array<{ prompt: string }>;
        reasons: Record<string, number>;
        debug: { arithmetic_hint: string };
      };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.debug.arithmetic_hint, "multiply");
      assert.equal(body.problems.length > 0, true);
      assert.equal(body.problems.every((p) => /[×xX＊*]/.test(p.prompt)), true);
      assert.equal((body.reasons.arithmetic_operator_mismatch ?? 0) > 0, true);
    });
  });
});

test("/micro/generate_from_ocr can fallback to image OCR when text OCR is noisy", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});

    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string; inline_data?: unknown }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("image_ocr")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "7 × 6 =" }] } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [{ prompt: "7 × 6 = □" }, { prompt: "8 × 3 = □" }, { prompt: "9 × 4 = □" }, { prompt: "6 × 5 = □" }]
      });
    }

    return geminiResponse({ problems: [] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "== x (9)。",
          image_base64: "ZmFrZS1pbWFnZS1ieXRlcw==",
          image_mime_type: "image/jpeg",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "image-ocr-fallback"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        debug: {
          ocr_source: string;
          ai_ocr_fallback_used: boolean;
          ai_ocr_text_length: number;
          arithmetic_hint: string;
        };
        problems: Array<{ prompt: string }>;
      };
      assert.equal(res.status, 200);
      assert.equal(body.debug.ocr_source, "image_ocr");
      assert.equal(body.debug.ai_ocr_fallback_used, true);
      assert.equal(body.debug.ai_ocr_text_length > 0, true);
      assert.equal(body.debug.arithmetic_hint, "multiply");
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.problems.every((p) => /×/.test(p.prompt)), true);
    });
  });
});

test("/micro/generate_from_ocr rewrites impossible -0 equation to blank", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) return geminiResponse({});
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [{ prompt: "98 - □ = 39" }, { prompt: "76 - □ = 21" }, { prompt: "54 - □ = 18" }, { prompt: "87 - □ = 45" }]
      });
    }
    return geminiResponse({ problems: [] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "(10) 98-0=39。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "zero-confusion"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        reasons: Record<string, number>;
        debug: {
          source_blank_confusion_applied: boolean;
          source_blank_confusion_reason: string | null;
        };
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.debug.source_blank_confusion_applied, true);
      assert.equal(body.debug.source_blank_confusion_reason, "minus_zero_blank_confusion");
      assert.equal((body.reasons.source_blank_confusion_rewritten ?? 0) > 0, true);
    });
  });
});

test("/micro/generate_from_ocr supports unit conversion mm->cm in equation mode", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "40 mm = □ cm",
            choices: ["2", "3", "4", "5", "6"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 4, correct_index: 2, equation: "40/10" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "4 mm = □ cm",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "unit-mm-cm"
        })
      });

      const body = (await res.json()) as { applied_count: number; detected_mode: string };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.applied_count > 0, true);
    });
  });
});

test("/micro/generate_from_ocr supports noisy OCR unit conversion text", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "40 mm = □ cm",
            choices: ["2", "3", "4", "5", "6"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 4, correct_index: 2, equation: "40/10" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "③ 4 mm =。cm。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "unit-mm-cm-noisy"
        })
      });

      const body = (await res.json()) as { detected_mode: string; debug: { input_mode: string }; applied_count: number };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.debug.input_mode, "equation");
      assert.equal(body.applied_count > 0, true);
    });
  });
});

test("/micro/generate_from_ocr recovers loose unit-conversion prose into equation style", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "4mmをcmになおしましょう。つぎから1つえらびなさい。",
            choices: ["0.4", "4", "40", "400", "0.04"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 0.4, correct_index: 0, equation: "4/10" });
    }
    return geminiResponse({ answer_value: 0.4, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "4 mm = □ cm",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "unit-loose-recover"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        problems: Array<{ prompt: string }>;
        reasons: Record<string, number>;
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.problems[0].prompt.includes("= □"), true);
      assert.equal(
        (body.reasons.unit_conversion_loose_recovered ?? 0) > 0 || (body.reasons.unit_conversion_pure_fallback_fill ?? 0) > 0,
        true
      );
    });
  });
});

test("/micro/generate_from_ocr rejects category mismatch after free generation", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "えんぴつが7本あります。3本あげました。のこりは何本ですか。",
            choices: ["2本", "3本", "4本", "5本", "6本"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 4, correct_index: 2, equation: "7-3" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "4 mm = □ cm",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "classification-filter"
        })
      });

      const body = (await res.json()) as { applied_count: number; reasons: Record<string, number>; problems: Array<{ prompt: string }> };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count > 0, true);
      assert.equal((body.reasons.classification_mismatch ?? 0) > 0 || (body.reasons.equation_style_miss ?? 0) > 0, true);
      assert.equal(body.problems.every((p) => p.prompt.includes("=")), true);
    });
  });
});

test("/micro/generate_from_ocr supports unit conversion L->dL in equation mode", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "3 L = □ dL",
            choices: ["3", "30", "300", "0.3", "0.03"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 30, correct_index: 1, equation: "3*10" });
    }
    return geminiResponse({ answer_value: 30, correct_index: 1 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "3L=□dL",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "unit-l-dl"
        })
      });

      const body = (await res.json()) as { applied_count: number; detected_mode: string };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.applied_count > 0, true);
    });
  });
});

test("/micro/generate_from_ocr keeps unit-conversion domain locked by source example", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "3 L = □ dL",
            choices: ["3", "30", "300", "0.3", "0.03"]
          },
          {
            prompt: "40 mm = □ cm",
            choices: ["2", "3", "4", "5", "6"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v") && prompt.includes("40 mm")) {
      return geminiResponse({ answer_value: 4, correct_index: 2, equation: "40/10" });
    }
    return geminiResponse({ answer_value: 0, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "4 mm = □ cm",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "unit-domain-lock"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        problems: Array<{ prompt: string }>;
        reasons: Record<string, number>;
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.problems.some((p) => p.prompt.includes(" L = □ dL")), false);
      assert.equal((body.reasons.unit_domain_mismatch ?? 0) > 0, true);
    });
  });
});

test("/micro/generate_from_ocr length conversion includes meter in mixed set for count=10", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let generatorCalls = 0;

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      generatorCalls += 1;
      if (generatorCalls <= 2) {
        return geminiResponse({
          problems: [
            { prompt: "10 mm = □ cm", choices: ["0.1", "1", "10", "100", "1000"] },
            { prompt: "20 mm = □ cm", choices: ["0.2", "2", "20", "200", "2000"] },
            { prompt: "30 mm = □ cm", choices: ["0.3", "3", "30", "300", "3000"] },
            { prompt: "40 mm = □ cm", choices: ["0.4", "4", "40", "400", "4000"] },
            { prompt: "50 mm = □ cm", choices: ["0.5", "5", "50", "500", "5000"] }
          ]
        });
      }
      return geminiResponse({
        problems: [{ prompt: "2 m = □ cm", choices: ["2", "20", "200", "2000", "20000"] }]
      });
    }

    if (prompt.includes("solver_v")) {
      if (prompt.includes("10 mm")) return geminiResponse({ answer_value: 1, correct_index: 1, equation: "10/10" });
      if (prompt.includes("20 mm")) return geminiResponse({ answer_value: 2, correct_index: 1, equation: "20/10" });
      if (prompt.includes("30 mm")) return geminiResponse({ answer_value: 3, correct_index: 1, equation: "30/10" });
      if (prompt.includes("40 mm")) return geminiResponse({ answer_value: 4, correct_index: 1, equation: "40/10" });
      if (prompt.includes("50 mm")) return geminiResponse({ answer_value: 5, correct_index: 1, equation: "50/10" });
      if (prompt.includes("2 m")) return geminiResponse({ answer_value: 200, correct_index: 2, equation: "2*100" });
    }

    return geminiResponse({ answer_value: 1, correct_index: 0, equation: "fallback" });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "4 mm = □ cm",
          count: 10,
          grade_band: "g1_g3",
          language: "ja",
          seed: "length-meter-diversity"
        })
      });

      const body = (await res.json()) as {
        applied_count: number;
        problems: Array<{ prompt: string }>;
        reasons: Record<string, number>;
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count, 10);
      assert.equal(body.problems.some((p) => p.prompt.includes(" m =")), true);
      assert.equal(
        (body.reasons.unit_diversity_fallback_meter ?? 0) > 0 || (body.reasons.unit_diversity_fallback_pair ?? 0) > 0,
        true
      );
      assert.equal(generatorCalls >= 2, true);
    });
  });
});

test("/micro/generate_from_ocr defaults ambiguous short text to equation mode", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "8 + 5 - 3 = □",
            choices: ["8", "9", "10", "11", "12"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "8+5-3" });
    }
    return geminiResponse({ answer_value: 10, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "8+5-3",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "ambiguous-equation-default"
        })
      });
      const body = (await res.json()) as { detected_mode: string; debug: { input_mode: string } };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.debug.input_mode, "equation");
    });
  });
});

test("/micro/generate_from_ocr keeps clear sentence as word_problem mode", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "えんぴつが7本あります。友だちに3本あげました。のこりは何本ですか。",
            choices: ["3本", "4本", "5本", "6本", "7本"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 4, correct_index: 1, equation: "7-3" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 1 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "えんぴつが7本あります。友だちに3本あげました。のこりは何本ですか。つぎから1つえらびなさい。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "clear-word-problem"
        })
      });
      const body = (await res.json()) as { detected_mode: string; debug: { input_mode: string } };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "word_problem");
      assert.equal(body.debug.input_mode, "word_problem");
    });
  });
});

test("/micro/generate_from_ocr keeps difficulty fields and does not force strict reject in easy mode", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "8 + 5 - 3 = □"
          },
          {
            prompt: "7 + 2 = □"
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 9, correct_index: 0, equation: "7+2" });
    }
    return geminiResponse({ answer_value: 9, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "7+2=□",
          count: 4,
          difficulty: "easy",
          grade_band: "g1_g3",
          language: "ja",
          seed: "easy-policy-simple-calc"
        })
      });
      const body = (await res.json()) as {
        detected_mode: string;
        problems: Array<{ prompt: string }>;
        reasons: Record<string, number>;
        debug: { difficulty: string; difficulty_applied: string };
      };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.debug.difficulty, "easy");
      assert.equal(body.debug.difficulty_applied, "easy");
      assert.equal((body.reasons.difficulty_policy_miss ?? 0) === 0, true);
      assert.equal(body.problems.length > 0, true);
      assert.equal(
        body.problems.every((p) => !/\s=\s(?:□|口|ロ|_|\[\])\s*$/.test(p.prompt.normalize("NFKC"))),
        true
      );
    });
  });
});

test("/micro/generate_from_ocr keeps middle blank symbol for reverse_blank equations", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [{ prompt: "3 + □ = 5" }, { prompt: "7 + □ = 9" }, { prompt: "□ + 4 = 8" }, { prompt: "8 - □ = 3" }]
      });
    }
    return geminiResponse({ answer_value: 2, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "3+□=5",
          count: 4,
          difficulty: "same",
          grade_band: "g1_g3",
          language: "ja",
          seed: "keep-middle-blank"
        })
      });
      const body = (await res.json()) as { problems: Array<{ prompt: string }>; detected_mode: string };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.problems.length > 0, true);
      assert.equal(body.problems.some((p) => /□/.test(p.prompt)), true);
      assert.equal(body.problems.some((p) => /\s=\s(?:□|口|ロ|_|\[\])\s*$/.test(p.prompt.normalize("NFKC"))), false);
    });
  });
});

test("/micro/generate_from_ocr keeps sentence OCR with trailing underscore as word_problem mode", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "大きいバケツに3.45L、小さいバケツに2.13Lの水が入っています。水はあわせて何Lですか。",
            choices: ["5.38L", "5.48L", "5.58L", "5.68L", "5.78L"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 5.58, correct_index: 2, equation: "3.45+2.13" });
    }
    return geminiResponse({ answer_value: 5.58, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "大きいバケツには3.45L。小さいバケツには2.13_。の水が入っています。水はあわせて何Lですか。式。答え。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "word-problem-trailing-underscore"
        })
      });
      const body = (await res.json()) as { detected_mode: string; debug: { input_mode: string; equation_track: string | null } };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "word_problem");
      assert.equal(body.debug.input_mode, "word_problem");
      assert.equal(body.debug.equation_track, null);
    });
  });
});

test("/micro/generate_from_ocr sets failure_code for upstream 429", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);
    if (prompt.includes("generator_v")) {
      return new Response(JSON.stringify({ error: { code: 429, message: "rate limit" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }
    return geminiResponse({ answer_value: 0, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "8+5-3=□",
          count: 4,
          difficulty: "same",
          grade_band: "g1_g3",
          language: "ja",
          seed: "429-failure-code"
        })
      });
      const body = (await res.json()) as {
        applied_count: number;
        meta: { failure_code: string; retryable: boolean };
        reasons: Record<string, number>;
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count, 0);
      assert.equal((body.reasons.gemini_http_429 ?? 0) > 0, true);
      assert.equal(body.meta.failure_code, "upstream_rate_limited");
      assert.equal(body.meta.retryable, true);
    });
  });
});

test("/micro/generate_from_ocr narrative unit sentence with stray '=' avoids unit_conversion_pure track", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "30 mL = □ dL",
            choices: ["0.3 dL", "3 dL", "30 dL", "300 dL", "0.03 dL"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 0.3, correct_index: 0, equation: "30mL=0.3dL" });
    }
    return geminiResponse({ answer_value: 0.3, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "大きいバケツには3.45L、小さいバケツには2.13Lの水が入っています。水はあわせて何Lですか。式 = 。答え。",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "narrative-unit-guard"
        })
      });
      const body = (await res.json()) as {
        detected_mode: string;
        debug: { input_mode: string; equation_track: string | null; equation_track_decision: string | null; equation_track_reason: string | null };
      };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.debug.input_mode, "equation");
      assert.equal(body.debug.equation_track, "arithmetic");
      assert.equal(body.debug.equation_track_decision, "narrative_guard");
      assert.equal(body.debug.equation_track_reason, "narrative_unit_conversion_sentence");
    });
  });
});

test("/micro/generate_from_ocr rejects word-problemized output for equation input", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "8+5-3はいくつですか。つぎから1つえらびなさい。",
            choices: ["6", "8", "10", "12", "14"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "8+5-3" });
    }
    return geminiResponse({ answer_value: 10, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "8+5-3=□",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: "equation-guard"
        })
      });
      const body = (await res.json()) as {
        applied_count: number;
        detected_mode: string;
        reasons: Record<string, number>;
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count, 0);
      assert.equal(body.detected_mode, "unknown");
      assert.equal((body.reasons.equation_style_miss ?? 0) > 0, true);
    });
  });
});

test("/micro/generate_from_ocr applies local kanji dictionary for g1", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      return geminiResponse({
        problems: [
          {
            prompt: "毎日2個ずつ練習問題をします。5日で何個ですか。",
            choices: ["6個", "8個", "10個", "12個", "14個"]
          }
        ]
      });
    }
    if (prompt.includes("solver_v")) {
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "2*5", check_trace: "2を5かいたす" });
    }
    return geminiResponse({ answer_value: 10, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "れんしゅうもんだいです。つぎから1つえらびなさい。どうなりますか。",
          count: 4,
          grade_band: "g1",
          language: "ja",
          seed: "rewrite-g1"
        })
      });
      const body = (await res.json()) as {
        applied_count: number;
        problems: Array<{ prompt: string }>;
        meta: { grade_band_applied: string };
        debug: { kanji_guard: { rewrite_attempts: number; violations_count: number; local_replacements: number } };
      };
      assert.equal(res.status, 200);
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.meta.grade_band_applied, "g1");
      assert.equal(body.debug.kanji_guard.rewrite_attempts, 0);
      assert.equal(body.debug.kanji_guard.violations_count > 0, true);
      assert.equal(body.debug.kanji_guard.local_replacements > 0, true);
      assert.equal(body.problems[0].prompt.includes("練"), false);
    });
  });
});

test("/micro/generate_from_ocr requires x-install-id header", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        ocr_text: "7+2=□",
        count: 4,
        grade_band: "g1_g3",
        language: "ja",
        seed: 11
      })
    });

    const body = (await res.json()) as { error: string };
    assert.equal(res.status, 400);
    assert.equal(body.error, "invalid_install_id");
  });
});

test("/micro/generate_from_ocr returns 429 when free quota exceeded", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (url.includes("example.upstash.io")) {
      return new Response(JSON.stringify({ result: [0, 5, 5, "202601", 3600] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);
    return geminiResponse({ problems: [{ prompt: "7 + 2 =" }] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "install-0001" },
        body: JSON.stringify({
          ocr_text: "7+2=□",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: 11
        })
      });

      const body = (await res.json()) as { error: string; plan_id: string; limit: number; used: number };
      assert.equal(res.status, 429);
      assert.equal(body.error, "free_quota_exceeded");
      assert.equal(body.plan_id, "free");
      assert.equal(body.limit, 5);
      assert.equal(body.used, 5);
    });
  });

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

test("/micro/generate_from_ocr detects Japanese problem language from OCR text", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);

    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      assert.equal(prompt.includes("Language: ja"), true);
      return geminiResponse({ problems: [{ prompt: "3 + 4 =" }] });
    }

    return geminiResponse({ problems: [{ prompt: "3 + 4 =" }] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "りんごが 3こ あります。2こ ふえると なんこですか。",
          count: 4,
          grade_band: "g1_g3",
          language: "en",
          seed: 201
        })
      });

      const body = (await res.json()) as {
        meta: { problem_language: string; problem_language_source: string; problem_language_confidence: number };
      };

      assert.equal(res.status, 200);
      assert.equal(body.meta.problem_language, "ja");
      assert.equal(body.meta.problem_language_source, "ocr");
      assert.equal(body.meta.problem_language_confidence >= 0.7, true);
    });
  });
});

test("/micro/generate_from_ocr detects English problem language from OCR text", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);

    const body = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(body);

    if (prompt.includes("generator_v")) {
      assert.equal(prompt.includes("Language: en"), true);
      return geminiResponse({ problems: [{ prompt: "How many are there in all?" }] });
    }

    return geminiResponse({ problems: [{ prompt: "How many are there in all?" }] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "Tom has 3 apples. He gets 2 more. How many apples does he have now?",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: 202
        })
      });

      const body = (await res.json()) as {
        meta: { problem_language: string; problem_language_source: string; problem_language_confidence: number };
      };

      assert.equal(res.status, 200);
      assert.equal(body.meta.problem_language, "en");
      assert.equal(body.meta.problem_language_source, "ocr");
      assert.equal(body.meta.problem_language_confidence >= 0.68, true);
    });
  });
});

test("/micro/generate_from_ocr falls back to image language detection when OCR is weak", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = getFetchUrl(input);
    if (!url.includes("googleapis.com")) throw new Error(`Unhandled fetch mock: ${url}`);

    const raw = await parseJsonBody<{
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(input, init);
    const prompt = getGeminiPrompt(raw);

    if (prompt.includes("image_language_detector")) {
      return geminiResponse({ language: "en", confidence: 0.88 });
    }
    if (prompt.includes("image_ocr")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "123" }] } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (prompt.includes("generator_v")) {
      assert.equal(prompt.includes("Language: en"), true);
      return geminiResponse({ problems: [{ prompt: "5 + 2 =" }] });
    }

    return geminiResponse({ problems: [{ prompt: "5 + 2 =" }] });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key", "x-install-id": "test-install-id" },
        body: JSON.stringify({
          ocr_text: "123",
          image_base64: "ZmFrZQ==",
          image_mime_type: "image/png",
          count: 4,
          grade_band: "g1_g3",
          language: "ja",
          seed: 203
        })
      });

      const body = (await res.json()) as {
        meta: { note: string; problem_language: string; problem_language_source: string; problem_language_confidence: number };
      };

      assert.equal(res.status, 200);
      assert.equal(body.meta.problem_language, "en");
      assert.equal(body.meta.problem_language_source, "image");
      assert.equal(body.meta.problem_language_confidence, 0.88);
      assert.notEqual(body.meta.note, "problem_language_fallback");
    });
  });
});

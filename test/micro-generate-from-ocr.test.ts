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
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";

    if (prompt.includes("ROLE: generator_v1")) {
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

    if (prompt.includes("ROLE: solver_v1") && prompt.includes("8問")) {
      return geminiResponse({ answer_value: 56, correct_index: 1, equation: "8*7", check_trace: "8を7回たす" });
    }

    if (prompt.includes("ROLE: solver_v1") && prompt.includes("6こ")) {
      return geminiResponse({ answer_value: 30, correct_index: 2, equation: "6*5", check_trace: "6を5回たす" });
    }

    return geminiResponse({ answer_value: 10, correct_index: 0, equation: "1+9" });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
          ocr_text: "毎日1ページずつ。1ページ8問。6/4から6/10まで。",
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
        problems: Array<{ prompt: string; choices: string[]; correct_index: number; answer_value: number }>;
        meta: { note: string };
      };

      assert.equal(res.status, 200);
      assert.equal(body.spec_version, "micro_problem_render_v1");
      assert.equal(body.detected_mode, "word_problem");
      assert.deepEqual(body.required_items, ["prompt", "choices"]);
      assert.equal(body.items.some((i) => i.type === "choices"), true);
      assert.equal(body.applied_count > 0, true);
      assert.equal(body.requested_count, 4);
      assert.equal(body.need_confirm, false);
      assert.equal(body.problems.length > 0, true);
      assert.equal(body.meta.note === "ok" || body.meta.note === "partial_success", true);
    });
  });
});

test("/micro/generate_from_ocr returns partial_success when light checks reject invalid outputs", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";

    if (prompt.includes("ROLE: generator_v1")) {
      return geminiResponse({
        problems: [
          {
            prompt: "3日で毎日9こずつ。ぜんぶで何こ？",
            choices: ["18", "21", "24", "27", "30"]
          }
        ]
      });
    }

    if (prompt.includes("ROLE: solver_v1")) {
      // Intentionally wrong index/answer mapping to trigger light validation reject.
      return geminiResponse({ answer_value: 27, correct_index: 0, equation: "9*3" });
    }

    return geminiResponse({ answer_value: 10, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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
      assert.equal(Object.keys(body.reasons).length > 0, true);
      if (body.applied_count === 0) {
        assert.equal(body.need_confirm, true);
      }
    });
  });
});

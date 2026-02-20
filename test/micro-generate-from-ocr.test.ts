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
        problems: Array<{ prompt: string; choices: string[]; correct_index: number; answer_value: number }>;
        meta: { note: string; grade_band_applied: string };
        debug: { kanji_guard: { checked: boolean; violations_count: number; rewrite_attempts: number } };
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
      assert.equal(body.meta.grade_band_applied === "g1" || body.meta.grade_band_applied === "g2_g3", true);
      assert.equal(body.debug.kanji_guard.checked, true);
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

test("/micro/generate_from_ocr caps word_problem count=10 to max 5", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let generatorCalls = 0;

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";

    if (prompt.includes("ROLE: generator_v1")) {
      generatorCalls += 1;
      return geminiResponse({
        problems: Array.from({ length: 5 }, (_, i) => ({
          prompt: `まいにち${i + 1}こずつあつめます。5にちでなんこですか。`,
          choices: ["5", "10", "15", "20", "25"]
        }))
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 5, correct_index: 0, equation: "1*5" });
    }
    return geminiResponse({ answer_value: 5, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";

    if (prompt.includes("ROLE: generator_v1")) {
      generatorCalls += 1;
      return geminiResponse({
        problems: Array.from({ length: 5 }, (_, i) => ({
          prompt: `${i + 1} + 4 = □`,
          choices: ["5", "6", "7", "8", "9"]
        }))
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 5, correct_index: 0, equation: "1+4" });
    }
    return geminiResponse({ answer_value: 5, correct_index: 0 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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

test("/micro/generate_from_ocr supports unit conversion mm->cm in equation mode", async () => {
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
            prompt: "40 mm = □ cm",
            choices: ["2", "3", "4", "5", "6"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 4, correct_index: 2, equation: "40/10" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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
            prompt: "40 mm = □ cm",
            choices: ["2", "3", "4", "5", "6"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 4, correct_index: 2, equation: "40/10" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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

test("/micro/generate_from_ocr supports unit conversion L->dL in equation mode", async () => {
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
            prompt: "3 L = □ dL",
            choices: ["3", "30", "300", "0.3", "0.03"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 30, correct_index: 1, equation: "3*10" });
    }
    return geminiResponse({ answer_value: 30, correct_index: 1 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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

test("/micro/generate_from_ocr defaults ambiguous short text to equation mode", async () => {
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
            prompt: "8 + 5 - 3 = □",
            choices: ["8", "9", "10", "11", "12"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "8+5-3" });
    }
    return geminiResponse({ answer_value: 10, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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
            prompt: "えんぴつが7本あります。友だちに3本あげました。のこりは何本ですか。",
            choices: ["3本", "4本", "5本", "6本", "7本"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 4, correct_index: 1, equation: "7-3" });
    }
    return geminiResponse({ answer_value: 4, correct_index: 1 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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

test("/micro/generate_from_ocr rejects word-problemized output for equation input", async () => {
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
            prompt: "8+5-3はいくつですか。つぎから1つえらびなさい。",
            choices: ["6", "8", "10", "12", "14"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "8+5-3" });
    }
    return geminiResponse({ answer_value: 10, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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
            prompt: "毎日2個ずつ練習問題をします。5日で何個ですか。",
            choices: ["6個", "8個", "10個", "12個", "14個"]
          }
        ]
      });
    }
    if (prompt.includes("ROLE: solver_v1")) {
      return geminiResponse({ answer_value: 10, correct_index: 2, equation: "2*5", check_trace: "2を5かいたす" });
    }
    return geminiResponse({ answer_value: 10, correct_index: 2 });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate_from_ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
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
        problems: Array<{ prompt: string; choices: string[] }>;
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
      assert.equal(body.problems[0].choices[2].includes("10"), true);
    });
  });
});

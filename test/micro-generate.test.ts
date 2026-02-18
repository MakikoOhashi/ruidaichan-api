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
      debug: { input_mode: string; selected_detector_path: string };
      problems: Array<{ items: Array<{ type: string }>; family: string }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.spec_version, "micro_problem_render_v1");
    assert.equal(body.detected_mode, "equation");
    assert.deepEqual(body.required_items, ["expression"]);
    assert.equal(body.items.some((i) => i.type === "expression"), true);
    assert.equal(body.debug.input_mode, "text");
    assert.equal(body.debug.selected_detector_path, "text_detector");
    assert.equal(body.problems.every((p) => p.items.some((i) => i.type === "expression")), true);
  });
});

test("image/ocr equation fallback detects 7 + 9 - 6 = □ as equation", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  family: "unknown",
                  confidence: 0.2,
                  detector_text: "7 + 9 - 6 = □"
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
        body: JSON.stringify({ image_base64: "data:image/png;base64,ZmFrZQ==", N: 4, difficulty: "same", seed: "eq-img" })
      });

      const body = (await res.json()) as {
        detected_mode: string;
        intent: string;
        required_items: string[];
        items: Array<{ type: string; text?: string }>;
        debug: { parse_stage_selected: string; equation_regex_hit: boolean; equation_candidate_source: string };
      };

      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.intent, "equation_add_sub_blank");
      assert.deepEqual(body.required_items, ["expression"]);
      assert.equal(body.items[0]?.type, "expression");
      assert.equal(body.debug.parse_stage_selected, "local_ocr_regex");
      assert.equal(body.debug.equation_regex_hit, true);
      assert.equal(body.debug.equation_candidate_source, "detector_text");
    });
  });
});

test("equation fallback handles OCR variants: 7+9-6=口 and full-width symbols", async () => {
  await withServer(async (baseUrl) => {
    const headers = { "Content-Type": "application/json", "x-api-key": "test-key" };
    const r1 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "7+9-6=口", N: 4, difficulty: "same", seed: "eq-v1" })
    });
    const r2 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "７＋９－６＝□", N: 4, difficulty: "same", seed: "eq-v2" })
    });

    const b1 = (await r1.json()) as { detected_mode: string; detected: { family: string } };
    const b2 = (await r2.json()) as { detected_mode: string; detected: { family: string } };

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(b1.detected_mode, "equation");
    assert.equal(b2.detected_mode, "equation");
    assert.equal(b1.detected.family, "a_plus_b_minus_c_eq_blank");
    assert.equal(b2.detected.family, "a_plus_b_minus_c_eq_blank");
  });
});

test("equation fallback complements missing blank: 7+9-6=", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "7+9-6=", N: 4, difficulty: "same", seed: "eq-v3" })
    });

    const body = (await res.json()) as {
      detected_mode: string;
      detected: { family: string };
      required_items: string[];
      items: Array<{ type: string; text?: string }>;
    };
    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "equation");
    assert.equal(body.detected.family, "a_plus_b_minus_c_eq_blank");
    assert.deepEqual(body.required_items, ["expression"]);
    assert.equal(body.items[0]?.type, "expression");
  });
});

test("text correction rescues OCR confusion: 7+9-6=1 with choice signals", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "(4) 7+9-6=1。つぎから1つえらびなさい。①4 ②8 ③10",
        N: 4,
        difficulty: "same",
        seed: "ocr-confusion-1"
      })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      detected: { family: string };
      meta: { note: string };
      debug: {
        blank_confusion_detected: boolean;
        blank_confusion_original: string | null;
        blank_confusion_rewritten: string | null;
        equation_candidate_after: string;
        correction_stage_selected: string;
      };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "equation");
    assert.equal(body.detected.family, "a_plus_b_minus_c_eq_blank");
    assert.equal(body.meta.note, "equation_corrected_from_ocr_confusion");
    assert.equal(body.debug.blank_confusion_detected, true);
    assert.equal(body.debug.blank_confusion_original, "1");
    assert.equal(body.debug.blank_confusion_rewritten, "□");
    assert.equal(body.debug.equation_candidate_after.includes("=□"), true);
    assert.equal(body.debug.correction_stage_selected, "deterministic");
  });
});

test("text correction handles blank variants: =口 and =_", async () => {
  await withServer(async (baseUrl) => {
    const headers = { "Content-Type": "application/json", "x-api-key": "test-key" };
    const r1 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "7+9-6=口", N: 4, difficulty: "same", seed: "blank-kuchi" })
    });
    const r2 = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "7+9-6=_", N: 4, difficulty: "same", seed: "blank-under" })
    });
    const b1 = (await r1.json()) as { detected_mode: string; detected: { family: string } };
    const b2 = (await r2.json()) as { detected_mode: string; detected: { family: string } };

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(b1.detected_mode, "equation");
    assert.equal(b2.detected_mode, "equation");
    assert.equal(b1.detected.family, "a_plus_b_minus_c_eq_blank");
    assert.equal(b2.detected.family, "a_plus_b_minus_c_eq_blank");
  });
});

test("text correction extracts equation from noisy sentence", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "(4) しきをときましょう。7 + 9 - 6 = 1。①4 ②8 ③10",
        N: 4,
        difficulty: "same",
        seed: "noisy-eq"
      })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      detected: { family: string };
      debug: { equation_candidate_before: string; equation_candidate_after: string };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "equation");
    assert.equal(body.detected.family, "a_plus_b_minus_c_eq_blank");
    assert.equal(body.debug.equation_candidate_before.includes("7+9-6=1"), true);
    assert.equal(body.debug.equation_candidate_after.includes("7+9-6=□"), true);
  });
});

test("correction guard: plain 7+9-6=1 without choice signals stays unknown", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "7+9-6=1", N: 4, difficulty: "same", seed: "guard-eq1" })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      meta: { note: string };
      debug: { blank_confusion_detected: boolean; correction_stage_selected: string };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "unknown");
    assert.equal(body.meta.note, "equation_regex_miss");
    assert.equal(body.debug.blank_confusion_detected, false);
    assert.equal(body.debug.correction_stage_selected, "none");
  });
});

test("missing blank is recovered for a+b= with choices", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "(1) 4 + 9 =。① 3 ② 12 ③ 13 ④ 14 ⑤ 36",
        N: 4,
        difficulty: "same",
        seed: "missing-blank-plus"
      })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      meta: { note: string };
      detected: { family: string };
      debug: {
        blank_missing_detected: boolean;
        blank_missing_rewritten: boolean;
        equation_candidate_after: string;
      };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "equation");
    assert.equal(body.meta.note, "equation_corrected_missing_blank");
    assert.equal(body.detected.family, "a_plus_b_eq_blank");
    assert.equal(body.debug.blank_missing_detected, true);
    assert.equal(body.debug.blank_missing_rewritten, true);
    assert.equal(body.debug.equation_candidate_after.includes("4+9=□"), true);
  });
});

test("missing blank is recovered for a+b-c= with choices", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "(2) 7+9-6=。①4 ②8 ③10 ④12 ⑤15",
        N: 4,
        difficulty: "same",
        seed: "missing-blank-add-sub"
      })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      detected: { family: string };
      debug: { equation_candidate_after: string; blank_missing_rewritten: boolean };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "equation");
    assert.equal(body.detected.family, "a_plus_b_minus_c_eq_blank");
    assert.equal(body.debug.blank_missing_rewritten, true);
    assert.equal(body.debug.equation_candidate_after.includes("7+9-6=□"), true);
  });
});

test("ambiguous multiple missing-blank candidates fail closed", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "(1) 4+9=。 (2) 7+2=。 ① 3 ② 12 ③ 13 ④ 14 ⑤ 36",
        N: 4,
        difficulty: "same",
        seed: "missing-blank-amb"
      })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      meta: { note: string };
      problems: unknown[];
      debug: { blank_missing_detected: boolean; blank_missing_rewritten: boolean };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "unknown");
    assert.equal(body.meta.note, "missing_blank_unrecoverable");
    assert.equal(body.problems.length, 0);
    assert.equal(body.debug.blank_missing_detected, true);
    assert.equal(body.debug.blank_missing_rewritten, false);
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
      debug: { input_mode: string; selected_detector_path: string };
      problems: Array<{ family: string; items: Array<{ type: string; correct_index?: number }> }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected.family, "compare_totals_diff_mc");
    assert.equal(body.detected_mode, "word_problem");
    assert.deepEqual(body.required_items, ["prompt", "choices"]);
    assert.equal(body.debug.input_mode, "text");
    assert.equal(body.debug.selected_detector_path, "text_detector");
    assert.equal(body.need_confirm, false);
    assert.equal(body.problems.every((p) => p.family === "compare_totals_diff_mc"), true);
    assert.equal(
      body.problems.every((p) => p.items.some((i) => i.type === "choices" && Number.isInteger(i.correct_index))),
      true
    );
  });
});

test("text mode does not run image detector and does not surface model_429", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let modelCallCount = 0;

  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
    modelCallCount += 1;
    return new Response(JSON.stringify({ error: "quota" }), { status: 429, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({ text: "きょうは いいてんきです。", N: 4, difficulty: "same", seed: "txt-no-image" })
      });
      const body = (await res.json()) as {
        detected_mode: string;
        debug: { input_mode: string; selected_detector_path: string; unknown_reason: string | null };
      };

      assert.equal(res.status, 200);
      assert.equal(body.debug.input_mode, "text");
      assert.equal(body.debug.selected_detector_path, "text_detector");
      assert.notEqual(body.debug.unknown_reason, "model_429");
      assert.equal(modelCallCount, 0);
      assert.equal(body.detected_mode, "unknown");
    });
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
    assert.equal(body.meta.note, "equation_regex_miss");
  });
});

test("empty normalized equation input returns unknown with ocr_empty_after_fallback", async () => {
  delete process.env.GEMINI_API_KEY;
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ image_base64: "data:image/png;base64,AA==", N: 4, difficulty: "same", seed: "empty-eq" })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      meta: { note: string };
      debug: { equation_candidate_source: string; normalize_input_empty: boolean; equation_normalized_text: string };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "unknown");
    assert.equal(body.meta.note, "ocr_empty_after_fallback");
    assert.equal(body.debug.equation_candidate_source, "none");
    assert.equal(body.debug.normalize_input_empty, true);
    assert.equal(body.debug.equation_normalized_text, "");
  });
});

test("binary-like candidate is rejected and regex is skipped", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "�PNG IHDR iCCP \u0000\u0001\u0002",
        N: 4,
        difficulty: "same",
        seed: "bin-reject"
      })
    });
    const body = (await res.json()) as {
      detected_mode: string;
      meta: { note: string };
      debug: {
        binary_candidate_rejected: boolean;
        binary_reject_reason: string | null;
        equation_regex_hit: boolean;
        equation_normalized_text: string;
      };
    };

    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "unknown");
    assert.equal(body.meta.note, "binary_candidate_rejected");
    assert.equal(body.debug.binary_candidate_rejected, true);
    assert.equal(typeof body.debug.binary_reject_reason, "string");
    assert.equal(body.debug.equation_regex_hit, false);
    assert.equal(body.debug.equation_normalized_text, "");
  });
});

test("true unknown remains unknown for plain narrative without equation", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ text: "きょうは いいてんきです。", N: 4, difficulty: "same", seed: "unknown-text" })
    });

    const body = (await res.json()) as { detected_mode: string; need_confirm: boolean };
    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "unknown");
    assert.equal(body.need_confirm, true);
  });
});

test("word_problem detection still works (no regression)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "あかは18こ、きいろは23こ。あか27こ、きいろ12こふえました。どちらが何こ多いですか。あわせて。",
        N: 4,
        difficulty: "same",
        seed: "cmp-regression"
      })
    });
    const body = (await res.json()) as { detected_mode: string; detected: { family: string } };
    assert.equal(res.status, 200);
    assert.equal(body.detected_mode, "word_problem");
    assert.equal(body.detected.family, "compare_totals_diff_mc");
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

test("candy theme uses あります and never さいています", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "あかいあめは きいろいあめの2ばいです。きいろいあめが15このとき、あかいあめは何こですか。",
        N: 4,
        difficulty: "same",
        seed: "b"
      })
    });

    const body = (await res.json()) as {
      meta: { theme_id: string };
      problems: Array<{ render_text: string }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.meta.theme_id, "candy");
    assert.equal(body.problems.every((p) => p.render_text.includes("あります")), true);
    assert.equal(body.problems.some((p) => p.render_text.includes("さいています")), false);
  });
});

test("tulip theme uses さいています", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "黄色のチューリップが赤いチューリップの2ばいです。赤いチューリップが15本のとき、黄色のチューリップは何本ですか。",
        N: 4,
        difficulty: "same",
        seed: "a"
      })
    });

    const body = (await res.json()) as {
      meta: { theme_id: string };
      problems: Array<{ render_text: string }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.meta.theme_id, "tulip");
    assert.equal(body.problems.every((p) => p.render_text.includes("さいています")), true);
  });
});

test("unit consistency: prompt unit and choices unit must match", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/micro/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        text: "あかいあめは きいろいあめの2ばいです。きいろいあめが15このとき、あかいあめは何こですか。",
        N: 4,
        difficulty: "same",
        seed: "b"
      })
    });

    const body = (await res.json()) as {
      meta: { theme_id: string };
      problems: Array<{ render_text: string; items: Array<{ type: string; choices?: string[] }> }>;
    };

    assert.equal(res.status, 200);
    assert.equal(body.meta.theme_id, "candy");
    for (const p of body.problems) {
      assert.equal(p.render_text.includes("こ"), true);
      const choices = p.items.find((i) => i.type === "choices")?.choices ?? [];
      assert.equal(choices.every((c) => c.includes("こ")), true);
    }
  });
});

test("fail-closed: lexicon mismatch returns unknown with theme_lexicon_mismatch", async () => {
  const prev = process.env.FORCE_THEME_LEXICON_MISMATCH;
  process.env.FORCE_THEME_LEXICON_MISMATCH = "1";

  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
          text: "あかいあめは きいろいあめの2ばいです。きいろいあめが15このとき、あかいあめは何こですか。",
          N: 4,
          difficulty: "same",
          seed: "b"
        })
      });

      const body = (await res.json()) as {
        detected_mode: string;
        problems: unknown[];
        meta: { note: string };
      };

      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "unknown");
      assert.equal(body.problems.length, 0);
      assert.equal(body.meta.note, "theme_lexicon_mismatch");
    });
  } finally {
    if (prev === undefined) {
      delete process.env.FORCE_THEME_LEXICON_MISMATCH;
    } else {
      process.env.FORCE_THEME_LEXICON_MISMATCH = prev;
    }
  }
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

      const b1 = (await r1.json()) as { detected_mode: string; debug: { selected_detector_path: string; input_mode: string } };
      const b2 = (await r2.json()) as { detected_mode: string; debug: { selected_detector_path: string; input_mode: string } };

      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(b1.debug.selected_detector_path, "image_gemini_detector");
      assert.equal(b2.debug.selected_detector_path, "image_gemini_detector");
      assert.equal(b1.debug.input_mode, "image");
      assert.equal(b2.debug.input_mode, "image");
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

test("model_429 still returns equation when local OCR regex hits", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.LOCAL_OCR_STUB_TEXT = "7+9-6=□";
  try {
    await withMockFetch(async (original, input, init) => {
      const url = String(input);
      if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
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
            seed: "local-ocr-hit"
          })
        });
        const body = (await res.json()) as {
          detected_mode: string;
          detected: { family: string };
          debug: { local_regex_hit: boolean; parse_stage_selected: string };
        };

        assert.equal(res.status, 200);
        assert.equal(body.detected_mode, "equation");
        assert.equal(body.detected.family, "a_plus_b_minus_c_eq_blank");
        assert.equal(body.debug.local_regex_hit, true);
        assert.equal(body.debug.parse_stage_selected, "local_ocr_regex");
      });
    });
  } finally {
    delete process.env.LOCAL_OCR_STUB_TEXT;
  }
});

test("text mode survives AI 429 by deterministic correction", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
    return new Response(JSON.stringify({ error: "quota" }), { status: 429, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
          text: "(4) 7+9-6=1。つぎから1つえらびなさい。①4 ②8 ③10",
          N: 4,
          difficulty: "same",
          seed: "deterministic-429"
        })
      });
      const body = (await res.json()) as {
        detected_mode: string;
        detected: { family: string };
        debug: { correction_stage_selected: string; unknown_reason: string | null };
      };

      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.detected.family, "a_plus_b_minus_c_eq_blank");
      assert.equal(body.debug.correction_stage_selected, "deterministic");
      assert.equal(body.debug.unknown_reason, null);
    });
  });
});

test("text missing-blank recovery survives AI 429 via deterministic path", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  await withMockFetch(async (original, input, init) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return original(input, init);
    return new Response(JSON.stringify({ error: "quota" }), { status: 429, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/micro/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
          text: "(1) 4 + 9 =。① 3 ② 12 ③ 13 ④ 14 ⑤ 36",
          N: 4,
          difficulty: "same",
          seed: "missing-429"
        })
      });
      const body = (await res.json()) as {
        detected_mode: string;
        debug: { correction_stage_selected: string; unknown_reason: string | null };
      };
      assert.equal(res.status, 200);
      assert.equal(body.detected_mode, "equation");
      assert.equal(body.debug.correction_stage_selected, "deterministic");
      assert.equal(body.debug.unknown_reason, null);
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
      assert.equal(body.meta.note, "ocr_empty_after_fallback");
      assert.equal(body.meta.fallback_count, 1);
      assert.equal(body.debug.selected_detector_path, "image_base64_decode_text_detector");
      assert.equal(body.debug.detector_fallback_reason, "model_429");
      assert.equal(body.debug.model_http_status, 429);
    });
  });
});

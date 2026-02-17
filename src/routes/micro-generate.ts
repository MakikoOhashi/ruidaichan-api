import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import {
  difficultySchema,
  microGenerateRequestSchema,
  microGenerateResponseSchema,
  microProblemDslSchema,
  problemFamilySchema,
  type Difficulty,
  type MicroProblemDsl,
  type ProblemFamily
} from "../schemas/micro-problem.js";

export const microGenerateRouter = Router();

const DETECT_CONFIDENCE_THRESHOLD = 0.75;
const MAX_REGEN_TRIES = 200;
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 8000);
const DEPLOY_COMMIT = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT_SHA ?? "unknown";
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP ?? new Date().toISOString();

type DetectResult = {
  family: ProblemFamily | "unknown";
  confidence: number;
  parsed_example: MicroProblemDsl | null;
};

type CompareSignals = {
  color_hits: number;
  two_actor_hits: number;
  compare_word_hits: number;
  total_word_hits: number;
  number_count: number;
  compare_score: number;
};

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function decodeBase64Text(base64: string): string {
  try {
    const payload = base64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
    if (!payload) return "";
    const text = Buffer.from(payload, "base64").toString("utf8");
    return normalizeText(text);
  } catch {
    return "";
  }
}

function mimeFromInput(base64: string): string {
  const m = base64.match(/^data:([^;,]+)[;,]/);
  return m?.[1] ?? "image/png";
}

function hashToSeed(input: string): number {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return Number.parseInt(h, 16) >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function parseByFamily(text: string): MicroProblemDsl | null {
  const normalized = normalizeText(text);

  const p1 = normalized.match(/^(\d+)\s*[+＋]\s*[□?_？]\s*[=＝]\s*(\d+)$/);
  if (p1) {
    const a = Number(p1[1]);
    const b = Number(p1[2]);
    return {
      spec_version: "micro_problem_dsl_v1",
      family: "a_plus_blank_eq_b",
      params: { a, b },
      render_text: `${a} + □ = ${b}`,
      answer: b - a
    };
  }

  const p2 = normalized.match(/^[□?_？]\s*[+＋]\s*(\d+)\s*[=＝]\s*(\d+)$/);
  if (p2) {
    const a = Number(p2[1]);
    const b = Number(p2[2]);
    return {
      spec_version: "micro_problem_dsl_v1",
      family: "blank_plus_a_eq_b",
      params: { a, b },
      render_text: `□ + ${a} = ${b}`,
      answer: b - a
    };
  }

  const p3 = normalized.match(/^(\d+)\s*[+＋]\s*(\d+)\s*[=＝]\s*[□?_？]$/);
  if (p3) {
    const a = Number(p3[1]);
    const b = Number(p3[2]);
    return {
      spec_version: "micro_problem_dsl_v1",
      family: "a_plus_b_eq_blank",
      params: { a, b },
      render_text: `${a} + ${b} = □`,
      answer: a + b
    };
  }

  const p4 = normalized.match(/^(\d+)\s*[-－]\s*(\d+)\s*[=＝]\s*[□?_？]$/);
  if (p4) {
    const b = Number(p4[1]);
    const a = Number(p4[2]);
    return {
      spec_version: "micro_problem_dsl_v1",
      family: "b_minus_a_eq_blank",
      params: { a, b },
      render_text: `${b} - ${a} = □`,
      answer: b - a
    };
  }

  return null;
}

function parseCompareTotals(text: string): MicroProblemDsl | null {
  const normalized = normalizeText(text);
  const numbers = [...normalized.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (numbers.length < 4) return null;

  const a = numbers[0];
  const b = numbers[1];
  const c = numbers[2];
  const d = numbers[3];
  const redTotal = a + c;
  const yellowTotal = b + d;
  const blank = Math.abs(redTotal - yellowTotal);
  const winner = redTotal >= yellowTotal ? "あか" : "きいろ";

  return {
    spec_version: "micro_problem_dsl_v1",
    family: "compare_totals_diff_mc",
    params: { a, b, c, d, blank },
    render_text: `あかは${a}こ、きいろは${b}こ。さらに あか${c}こ、きいろ${d}こ ふえました。どちらが なんこ おおいですか。(${winner})`,
    answer: blank
  };
}

function detectCompareTotalsSignals(text: string): CompareSignals {
  const normalized = normalizeText(text);
  const numberCount = [...normalized.matchAll(/\d+/g)].length;

  const colorTokens = ["あか", "赤", "きいろ", "黄", "しろ", "白", "くろ", "黒", "あお", "青"];
  const color_hits = new Set(colorTokens.filter((t) => normalized.includes(t))).size;
  const two_actor_hits = [...normalized.matchAll(/[^。．\s]{1,8}は/g)].length;
  const compare_word_hits = [...normalized.matchAll(/どちら|どっち|何こ多い|なんこおおい|何個多い|多い/g)].length;
  const total_word_hits = [...normalized.matchAll(/合わせ|あわせ|合計|ぜんぶ|全部/g)].length;

  const compare_score =
    (color_hits >= 2 ? 1 : 0) +
    (two_actor_hits >= 2 ? 1 : 0) +
    (compare_word_hits > 0 ? 1 : 0) +
    (total_word_hits > 0 ? 1 : 0) +
    (numberCount >= 4 ? 1 : 0);

  return {
    color_hits,
    two_actor_hits,
    compare_word_hits,
    total_word_hits,
    number_count: numberCount,
    compare_score
  };
}

function detectFamily(text: string): { detected: DetectResult; signals: CompareSignals } {
  const signals = detectCompareTotalsSignals(text);
  if (signals.compare_score >= 4) {
    const parsedCompare = parseCompareTotals(text);
    if (parsedCompare) {
      const confidence = signals.compare_score >= 5 ? 0.92 : 0.82;
      return {
        detected: {
          family: "compare_totals_diff_mc",
          confidence,
          parsed_example: parsedCompare
        },
        signals
      };
    }
  }

  const parsed = parseByFamily(text);
  if (parsed) {
    return { detected: { family: parsed.family, confidence: 0.92, parsed_example: parsed }, signals };
  }

  const hasMathSignal = /[+＋=＝\-－□?_？]/.test(text);
  if (hasMathSignal) {
    return { detected: { family: "unknown", confidence: 0.6, parsed_example: null }, signals };
  }

  return { detected: { family: "unknown", confidence: 0.35, parsed_example: null }, signals };
}

async function detectFamilyFromImage(imageBase64: string): Promise<{ detected: DetectResult; signals: CompareSignals } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const payload = imageBase64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  if (!payload) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const prompt = [
      "Classify a single elementary math sub-problem.",
      "Target family names:",
      "- compare_totals_diff_mc (two groups, compare totals, ask which/how many more)",
      "- a_plus_blank_eq_b",
      "- blank_plus_a_eq_b",
      "- a_plus_b_eq_blank",
      "- b_minus_a_eq_blank",
      "- unknown",
      "Return ONLY JSON with this exact shape:",
      '{"family":"compare_totals_diff_mc","confidence":0.0,"params":{"a":18,"b":23,"c":27,"d":12,"blank":10}}'
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeFromInput(imageBase64),
                    data: payload
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) return null;
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as {
      family?: string;
      confidence?: number;
      params?: Record<string, number>;
    };

    const family = parsed.family;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));
    if (!family) return null;

    if (family === "compare_totals_diff_mc" && parsed.params) {
      const a = Math.trunc(parsed.params.a ?? 0);
      const b = Math.trunc(parsed.params.b ?? 0);
      const c = Math.trunc(parsed.params.c ?? 0);
      const d = Math.trunc(parsed.params.d ?? 0);
      const blank = Math.abs(a + c - (b + d));
      const parsed_example: MicroProblemDsl = {
        spec_version: "micro_problem_dsl_v1",
        family: "compare_totals_diff_mc",
        params: { a, b, c, d, blank },
        render_text: `あかは${a}こ、きいろは${b}こ。さらに あか${c}こ、きいろ${d}こ ふえました。どちらが なんこ おおいですか。`,
        answer: blank
      };
      return {
        detected: { family: "compare_totals_diff_mc", confidence: Math.max(confidence, 0.8), parsed_example },
        signals: {
          color_hits: 2,
          two_actor_hits: 2,
          compare_word_hits: 1,
          total_word_hits: 1,
          number_count: 4,
          compare_score: 5
        }
      };
    }

    if (problemFamilySchema.options.includes(family as ProblemFamily)) {
      return {
        detected: { family: family as ProblemFamily, confidence, parsed_example: null },
        signals: {
          color_hits: 0,
          two_actor_hits: 0,
          compare_word_hits: 0,
          total_word_hits: 0,
          number_count: 0,
          compare_score: 0
        }
      };
    }

    return {
      detected: { family: "unknown", confidence: Math.min(confidence, 0.6), parsed_example: null },
      signals: {
        color_hits: 0,
        two_actor_hits: 0,
        compare_word_hits: 0,
        total_word_hits: 0,
        number_count: 0,
        compare_score: 0
      }
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function rangeByDifficulty(difficulty: Difficulty, example: MicroProblemDsl | null): { min: number; max: number } {
  if (difficulty === "easy") return { min: 0, max: 9 };
  if (difficulty === "hard") return { min: 5, max: 30 };

  if (!example) return { min: 0, max: 12 };
  const values = Object.values(example.params);
  const mx = Math.max(...values, example.answer);
  return { min: Math.max(0, mx - 5), max: mx + 5 };
}

function buildProblem(family: ProblemFamily, rng: () => number, difficulty: Difficulty, example: MicroProblemDsl | null): MicroProblemDsl {
  const range = rangeByDifficulty(difficulty, example);

  if (family === "compare_totals_diff_mc") {
    const min = difficulty === "easy" ? 1 : difficulty === "hard" ? 10 : 3;
    const max = difficulty === "easy" ? 20 : difficulty === "hard" ? 50 : 30;
    const a = randInt(rng, min, max);
    const b = randInt(rng, min, max);
    const c = randInt(rng, min, max);
    const d = randInt(rng, min, max);
    const redTotal = a + c;
    const yellowTotal = b + d;
    const blank = Math.abs(redTotal - yellowTotal);
    const winner = redTotal >= yellowTotal ? "あか" : "きいろ";

    return {
      spec_version: "micro_problem_dsl_v1",
      family,
      params: { a, b, c, d, blank },
      render_text: `あかは${a}こ、きいろは${b}こ。つぎに あか${c}こ、きいろ${d}こ ふえました。どちらが なんこ おおいですか。(${winner})`,
      answer: blank
    };
  }

  if (family === "a_plus_blank_eq_b") {
    const a = randInt(rng, range.min, range.max);
    const x = randInt(rng, range.min, range.max);
    const b = a + x;
    return {
      spec_version: "micro_problem_dsl_v1",
      family,
      params: { a, b },
      render_text: `${a} + □ = ${b}`,
      answer: x
    };
  }

  if (family === "blank_plus_a_eq_b") {
    const a = randInt(rng, range.min, range.max);
    const x = randInt(rng, range.min, range.max);
    const b = a + x;
    return {
      spec_version: "micro_problem_dsl_v1",
      family,
      params: { a, b },
      render_text: `□ + ${a} = ${b}`,
      answer: x
    };
  }

  if (family === "a_plus_b_eq_blank") {
    const a = randInt(rng, range.min, range.max);
    const b = randInt(rng, range.min, range.max);
    return {
      spec_version: "micro_problem_dsl_v1",
      family,
      params: { a, b },
      render_text: `${a} + ${b} = □`,
      answer: a + b
    };
  }

  const a = randInt(rng, range.min, range.max);
  const diff = randInt(rng, range.min, range.max);
  const b = a + diff;
  return {
    spec_version: "micro_problem_dsl_v1",
    family,
    params: { a, b },
    render_text: `${b} - ${a} = □`,
    answer: diff
  };
}

function solve(problem: MicroProblemDsl): number {
  const p = problem.params;
  switch (problem.family) {
    case "a_plus_blank_eq_b":
      return p.b - p.a;
    case "blank_plus_a_eq_b":
      return p.b - p.a;
    case "a_plus_b_eq_blank":
      return p.a + p.b;
    case "b_minus_a_eq_blank":
      return p.b - p.a;
    case "compare_totals_diff_mc":
      return Math.abs((p.a + p.c) - (p.b + p.d));
  }
}

function isInRangeForDifficulty(problem: MicroProblemDsl, difficulty: Difficulty): boolean {
  const vals = [...Object.values(problem.params), problem.answer];
  if (difficulty === "easy") return vals.every((v) => v >= 0 && v <= 20);
  if (difficulty === "hard") return vals.every((v) => v >= 0 && v <= 99);
  return vals.every((v) => v >= 0 && v <= 50);
}

function validateProblem(problem: MicroProblemDsl, difficulty: Difficulty): string | null {
  const parsed = microProblemDslSchema.safeParse(problem);
  if (!parsed.success) return "schema_invalid";

  if (problem.family === "compare_totals_diff_mc") {
    const p = problem.params;
    const needed = ["a", "b", "c", "d", "blank"] as const;
    if (!needed.every((k) => Number.isInteger(p[k]))) return "missing_compare_params";
    const computed = Math.abs((p.a + p.c) - (p.b + p.d));
    if (p.blank !== computed) return "compare_blank_mismatch";
    if (p.blank < 0) return "negative_answer";
  }

  if (solve(problem) !== problem.answer) return "solver_mismatch";
  if (problem.answer < 0) return "negative_answer";
  if (!isInRangeForDifficulty(problem, difficulty)) return "difficulty_out_of_range";

  return null;
}

function bumpReason(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

microGenerateRouter.post("/", async (req, res) => {
  const requestId = randomUUID();
  const hasImageBase64 = typeof req.body?.image_base64 === "string" && req.body.image_base64.length > 0;
  const textPresent = typeof req.body?.text === "string" && req.body.text.length > 0;

  const parsedReq = microGenerateRequestSchema.safeParse(req.body);
  if (!parsedReq.success) {
    return res.status(400).json({
      error: "invalid_request",
      request_id: requestId,
      details: parsedReq.error.flatten()
    });
  }

  let selectedDetectorPath = "text_detector";
  let detected: DetectResult;
  let signalCounts: CompareSignals = {
    color_hits: 0,
    two_actor_hits: 0,
    compare_word_hits: 0,
    total_word_hits: 0,
    number_count: 0,
    compare_score: 0
  };

  console.log(
    JSON.stringify({
      event: "micro_generate_input",
      request_id: requestId,
      has_image_base64: hasImageBase64,
      text_present: textPresent,
      selected_detector_path: textPresent ? "text_detector" : "image_detector"
    })
  );

  if (parsedReq.data.text) {
    const text = normalizeText(parsedReq.data.text);
    const resByText = detectFamily(text);
    detected = resByText.detected;
    signalCounts = resByText.signals;
    selectedDetectorPath = "text_detector";
  } else {
    const imageBase64 = parsedReq.data.image_base64 ?? "";
    const visionResult = await detectFamilyFromImage(imageBase64);
    if (visionResult) {
      detected = visionResult.detected;
      signalCounts = visionResult.signals;
      selectedDetectorPath = "image_gemini_detector";
    } else {
      const decodedText = decodeBase64Text(imageBase64);
      const resByDecoded = detectFamily(decodedText);
      detected = resByDecoded.detected;
      signalCounts = resByDecoded.signals;
      selectedDetectorPath = "image_base64_decode_text_detector";
    }
  }

  const detectedFamilyBeforeFallback = detected.family;

  const needConfirm = detected.confidence < DETECT_CONFIDENCE_THRESHOLD || detected.family === "unknown";
  const candidateFamilies = problemFamilySchema.options;
  const generationFamily: ProblemFamily = detected.family === "unknown" ? "a_plus_blank_eq_b" : detected.family;
  const detectedFamilyAfterFallback = generationFamily;

  console.log(
    JSON.stringify({
      event: "micro_generate_detection",
      request_id: requestId,
      signal_counts: signalCounts,
      compare_score: signalCounts.compare_score,
      detected_family_before_fallback: detectedFamilyBeforeFallback,
      detected_family_after_fallback: detectedFamilyAfterFallback
    })
  );

  const rngSeed = hashToSeed(
    JSON.stringify({
      input: parsedReq.data.text ? normalizeText(parsedReq.data.text) : parsedReq.data.image_base64 ?? "",
      N: parsedReq.data.N,
      difficulty: parsedReq.data.difficulty,
      seed: String(parsedReq.data.seed),
      family: generationFamily
    })
  );
  const rng = mulberry32(rngSeed);

  const problems: MicroProblemDsl[] = [];
  const seen = new Set<string>();
  const reasons: Record<string, number> = {};
  let rejectedCount = 0;

  for (let i = 0; i < MAX_REGEN_TRIES && problems.length < parsedReq.data.N; i += 1) {
    const problem = buildProblem(generationFamily, rng, parsedReq.data.difficulty, detected.parsed_example);
    const duplicateKey = problem.render_text;

    if (seen.has(duplicateKey)) {
      rejectedCount += 1;
      bumpReason(reasons, "duplicate");
      continue;
    }

    const reason = validateProblem(problem, parsedReq.data.difficulty);
    if (reason) {
      rejectedCount += 1;
      bumpReason(reasons, reason);
      continue;
    }

    seen.add(duplicateKey);
    problems.push(problem);
  }

  const response = {
    request_id: requestId,
    schema_version: "micro_generate_response_v1",
    detected,
    problems,
    rejected_count: rejectedCount,
    reasons,
    need_confirm: needConfirm,
    ...(needConfirm ? { confirm_choices: [...candidateFamilies] } : {}),
    debug: {
      deploy_commit: DEPLOY_COMMIT,
      build_timestamp: BUILD_TIMESTAMP,
      selected_detector_path: selectedDetectorPath
    }
  };

  const validated = microGenerateResponseSchema.safeParse(response);
  if (!validated.success) {
    return res.status(500).json({
      error: "internal_response_invalid",
      request_id: requestId
    });
  }

  console.log(
    JSON.stringify({
      event: "micro_generate",
      request_id: requestId,
      family: validated.data.detected.family,
      confidence: validated.data.detected.confidence,
      generated: validated.data.problems.length,
      rejected_count: validated.data.rejected_count,
      need_confirm: validated.data.need_confirm,
      response_detected_family: validated.data.detected.family,
      response_need_confirm: validated.data.need_confirm,
      response_problem_families: [...new Set(validated.data.problems.map((p) => p.family))]
    })
  );

  return res.status(200).json(validated.data);
});

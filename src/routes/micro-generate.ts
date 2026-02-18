import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import {
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
const MAX_REGEN_TRIES = 250;
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 8000);
const DETECTOR_VERSION = "image_route_v2";
const DEPLOY_COMMIT = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT_SHA ?? "unknown";
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP ?? new Date().toISOString();

type DetectResult = {
  family: ProblemFamily | "unknown";
  confidence: number;
  parsed_example: MicroProblemDsl | null;
  block_fallback: boolean;
  intent: string;
};

type CompareSignals = {
  color_hits: number;
  two_actor_hits: number;
  compare_word_hits: number;
  total_word_hits: number;
  number_count: number;
  compare_score: number;
};

type TimesSignals = {
  times_word_hits: number;
  question_word_hits: number;
  pattern_hit: boolean;
  number_count: number;
  times_score: number;
};

type DetectorPath = "text_detector" | "image_gemini_detector" | "image_base64_decode_text_detector";

type FallbackReason =
  | "gemini_api_key_missing"
  | "model_timeout"
  | "model_429"
  | "model_5xx"
  | "model_http_error"
  | "empty_parse"
  | "decode_text_fallback_failed";

type DecodeFallbackDebug = {
  ocr_line_count: number;
  keyword_hits: number;
  parse_candidates_count: number;
};

type VisionAttempt = {
  ok: boolean;
  status: number | null;
  error_reason: FallbackReason | null;
  retriable: boolean;
  detected?: DetectResult;
  compare?: CompareSignals;
  times?: TimesSignals;
};

type Theme = {
  id: string;
  subject_a: string;
  subject_b: string;
  unit: string;
  verb_exist: string;
};

const LEXICON_VERSION = "theme_lexicon_v1";
const THEME_BANK: Theme[] = [
  { id: "tulip", subject_a: "黄色のチューリップ", subject_b: "赤いチューリップ", unit: "本", verb_exist: "さいています" },
  { id: "candy", subject_a: "あかいあめ", subject_b: "きいろいあめ", unit: "こ", verb_exist: "あります" },
  { id: "pencil", subject_a: "みどりのえんぴつ", subject_b: "あおいえんぴつ", unit: "本", verb_exist: "あります" },
  { id: "plate", subject_a: "しろいおさら", subject_b: "あかいおさら", unit: "まい", verb_exist: "あります" }
];

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function base64Payload(base64: string): string {
  return base64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
}

function imageBytesLength(base64: string): number {
  const payload = base64Payload(base64);
  if (!payload) return 0;
  try {
    return Buffer.from(payload, "base64").byteLength;
  } catch {
    return 0;
  }
}

function decodeBase64Text(base64: string): string {
  try {
    const payload = base64Payload(base64);
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

function parseCandidatesCountFromText(text: string): number {
  let candidates = 0;
  if (parseByFamily(text)) candidates += 1;
  if (parseTimesScale(text)) candidates += 1;
  if (parseCompareTotals(text)) candidates += 1;
  return candidates;
}

function buildDecodeFallbackDebug(text: string): DecodeFallbackDebug {
  const normalized = normalizeText(text);
  const lineTokens = normalized.split(/[。\n]/).map((x) => x.trim()).filter(Boolean);
  const keyword_hits = [...normalized.matchAll(/どちら|何こ|何個|あわせ|合計|ばい|倍|[+＋=＝\-－□]/g)].length;
  return {
    ocr_line_count: lineTokens.length,
    keyword_hits,
    parse_candidates_count: parseCandidatesCountFromText(normalized)
  };
}

function hashToSeed(input: string): number {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return Number.parseInt(h, 16) >>> 0;
}

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

function modeFromFamily(family: ProblemFamily | "unknown"): "equation" | "word_problem" | "unknown" {
  if (family === "compare_totals_diff_mc" || family === "times_scale_mc") return "word_problem";
  if (family === "unknown") return "unknown";
  return "equation";
}

function intentFromFamily(family: ProblemFamily | "unknown"): string {
  if (family === "compare_totals_diff_mc") return "compare_totals_difference";
  if (family === "times_scale_mc") return "times_scale_question";
  if (family === "unknown") return "unknown_intent";
  return "equation_fill_blank";
}

function requiredItemsFromMode(mode: "equation" | "word_problem" | "unknown"): Array<"prompt" | "choices" | "expression"> {
  if (mode === "equation") return ["expression"];
  if (mode === "word_problem") return ["prompt", "choices"];
  return [];
}

function buildProblemBase(family: ProblemFamily, params: Record<string, number | string | string[]>, renderText: string, answer: number): MicroProblemDsl {
  const mode = modeFromFamily(family);
  const required = requiredItemsFromMode(mode);

  const items: MicroProblemDsl["items"] =
    mode === "equation"
      ? [{ type: "expression", slot: "expr", text: renderText as string }]
      : mode === "word_problem"
      ? [
          { type: "prompt", slot: "stem", text: renderText as string },
          {
            type: "choices",
            slot: "options",
            style: "mc",
            choices: Array.isArray(params.choices) ? params.choices : [],
            correct_index: Number(params.correct_index ?? 0)
          }
        ]
      : [];

  return {
    spec_version: "micro_problem_dsl_v1",
    family,
    params,
    render_text: renderText,
    answer,
    detected_mode: mode,
    intent: intentFromFamily(family),
    required_items: required,
    items
  };
}

function buildEquationChoices(answer: number, unit = ""): { choices: string[]; correctIndex: number } {
  const wrong = new Set<number>([Math.max(0, answer - 1), answer + 1, answer + 2, Math.max(0, answer - 2)]);
  wrong.delete(answer);
  const choices = [answer, ...Array.from(wrong).slice(0, 4)]
    .slice(0, 5)
    .sort((a, b) => a - b)
    .map((v) => `${v}${unit}`);
  const correctIndex = choices.findIndex((c) => c === `${answer}${unit}`);
  return { choices, correctIndex };
}

function buildCompareChoices(answer: number, unit: string, subjectA: string, subjectB: string): { choices: string[]; correctIndex: number } {
  const wrong = new Set<number>([Math.max(0, answer - 1), answer + 1, answer + 2, Math.max(0, answer - 2)]);
  wrong.delete(answer);
  const values = [answer, ...Array.from(wrong).slice(0, 4)].slice(0, 5).sort((a, b) => a - b);
  const choices = values.map((v, idx) => {
    const subject = idx % 2 === 0 ? subjectA : subjectB;
    return `${subject}が${v}${unit}おおい`;
  });
  const correctIndex = choices.findIndex((c) => c.includes(`${answer}${unit}`));
  return { choices, correctIndex };
}

function isWordProblemFamily(family: ProblemFamily | "unknown"): family is "times_scale_mc" | "compare_totals_diff_mc" {
  return family === "times_scale_mc" || family === "compare_totals_diff_mc";
}

function pickTheme(seed: string, family: ProblemFamily): Theme | null {
  if (!isWordProblemFamily(family)) return null;
  const idx = hashToSeed(`${seed}:${family}`) % THEME_BANK.length;
  return THEME_BANK[idx] ?? THEME_BANK[0];
}

function buildTimesScalePrompt(theme: Theme, base: number, multiplier: number): string {
  const forceMismatch = process.env.FORCE_THEME_LEXICON_MISMATCH === "1";
  const verb = forceMismatch ? "さいています" : theme.verb_exist;
  return `${theme.subject_a}が、${theme.subject_b}の${multiplier}ばい${verb}。${theme.subject_b}が${base}${theme.unit}のとき、${theme.subject_a}は何${theme.unit}ですか。つぎから1つえらびなさい。`;
}

function buildComparePrompt(theme: Theme, a: number, b: number, c: number, d: number): string {
  const forceMismatch = process.env.FORCE_THEME_LEXICON_MISMATCH === "1";
  const unit = forceMismatch ? "こ" : theme.unit;
  return `${theme.subject_a}は${a}${unit}、${theme.subject_b}は${b}${unit}${theme.verb_exist}。つぎに ${theme.subject_a}が${c}${unit}、${theme.subject_b}が${d}${unit}ふえました。どちらが なん${unit} おおいですか。つぎから1つえらびなさい。`;
}

function parseByFamily(text: string): MicroProblemDsl | null {
  const normalized = normalizeText(text);

  const p1 = normalized.match(/^(\d+)\s*[+＋]\s*[□?_？]\s*[=＝]\s*(\d+)$/);
  if (p1) {
    const a = Number(p1[1]);
    const b = Number(p1[2]);
    return buildProblemBase("a_plus_blank_eq_b", { a, b }, `${a} + □ = ${b}`, b - a);
  }

  const p2 = normalized.match(/^[□?_？]\s*[+＋]\s*(\d+)\s*[=＝]\s*(\d+)$/);
  if (p2) {
    const a = Number(p2[1]);
    const b = Number(p2[2]);
    return buildProblemBase("blank_plus_a_eq_b", { a, b }, `□ + ${a} = ${b}`, b - a);
  }

  const p3 = normalized.match(/^(\d+)\s*[+＋]\s*(\d+)\s*[=＝]\s*[□?_？]$/);
  if (p3) {
    const a = Number(p3[1]);
    const b = Number(p3[2]);
    return buildProblemBase("a_plus_b_eq_blank", { a, b }, `${a} + ${b} = □`, a + b);
  }

  const p4 = normalized.match(/^(\d+)\s*[-－]\s*(\d+)\s*[=＝]\s*[□?_？]$/);
  if (p4) {
    const b = Number(p4[1]);
    const a = Number(p4[2]);
    return buildProblemBase("b_minus_a_eq_blank", { a, b }, `${b} - ${a} = □`, b - a);
  }

  return null;
}

function detectTimesSignals(text: string): TimesSignals {
  const normalized = normalizeText(text);
  const times_word_hits = [...normalized.matchAll(/ばい|倍/g)].length;
  const question_word_hits = [...normalized.matchAll(/何本|何こ|何個/g)].length;
  const pattern_hit = /(.+?)(?:は|が)[、,\s]*(.+?)の(\d+)(?:ばい|倍)/.test(normalized);
  const number_count = [...normalized.matchAll(/\d+/g)].length;
  const times_score =
    (times_word_hits > 0 ? 1 : 0) +
    (question_word_hits > 0 ? 1 : 0) +
    (pattern_hit ? 1 : 0) +
    (number_count >= 2 ? 1 : 0);

  return { times_word_hits, question_word_hits, pattern_hit, number_count, times_score };
}

function parseTimesScale(text: string): MicroProblemDsl | null {
  const normalized = normalizeText(text);
  const pattern = normalized.match(/(.+?)(?:は|が)[、,\s]*(.+?)の(\d+)(?:ばい|倍).*?(\d+)(本|こ|個)/);
  if (!pattern) return null;

  const subject_a = pattern[1].trim();
  const subject_b = pattern[2].trim();
  const multiplier = Number(pattern[3]);
  const base = Number(pattern[4]);
  const unit = pattern[5];
  if (!Number.isInteger(multiplier) || !Number.isInteger(base) || multiplier < 2) return null;

  const answer = base * multiplier;
  const { choices, correctIndex } = buildEquationChoices(answer, unit);
  return buildProblemBase(
    "times_scale_mc",
    {
      base,
      multiplier,
      answer,
      unit,
      subject_a,
      subject_b,
      choices,
      correct_index: correctIndex
    },
    `${subject_a}が、${subject_b}の${multiplier}ばいさいています。${subject_b}が${base}${unit}のとき、${subject_a}は何${unit}ですか。つぎから1つえらびなさい。`,
    answer
  );
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
  const { choices, correctIndex } = buildEquationChoices(blank, "こ");

  return buildProblemBase(
    "compare_totals_diff_mc",
    { a, b, c, d, blank, winner, choices, correct_index: correctIndex },
    `あかは${a}こ、きいろは${b}こです。さらに あか${c}こ、きいろ${d}こ ふえました。どちらが なんこ おおいですか。`,
    blank
  );
}

function detectFamily(text: string): { detected: DetectResult; compare: CompareSignals; times: TimesSignals } {
  const times = detectTimesSignals(text);
  if (times.times_word_hits > 0) {
    const parsedTimes = parseTimesScale(text);
    if (parsedTimes) {
      return {
        detected: {
          family: "times_scale_mc",
          confidence: times.times_score >= 4 ? 0.9 : 0.8,
          parsed_example: parsedTimes,
          block_fallback: false,
          intent: intentFromFamily("times_scale_mc")
        },
        compare: {
          color_hits: 0,
          two_actor_hits: 0,
          compare_word_hits: 0,
          total_word_hits: 0,
          number_count: times.number_count,
          compare_score: 0
        },
        times
      };
    }

    return {
      detected: {
        family: "unknown",
        confidence: times.question_word_hits > 0 ? 0.74 : 0.6,
        parsed_example: null,
        block_fallback: true,
        intent: "times_signal_detected_but_unresolved"
      },
      compare: {
        color_hits: 0,
        two_actor_hits: 0,
        compare_word_hits: 0,
        total_word_hits: 0,
        number_count: times.number_count,
        compare_score: 0
      },
      times
    };
  }

  const compare = detectCompareTotalsSignals(text);
  if (compare.compare_score >= 4) {
    const parsedCompare = parseCompareTotals(text);
    if (parsedCompare) {
      return {
        detected: {
          family: "compare_totals_diff_mc",
          confidence: compare.compare_score >= 5 ? 0.92 : 0.82,
          parsed_example: parsedCompare,
          block_fallback: false,
          intent: intentFromFamily("compare_totals_diff_mc")
        },
        compare,
        times
      };
    }
  }

  const parsed = parseByFamily(text);
  if (parsed) {
    return {
      detected: {
        family: parsed.family,
        confidence: 0.92,
        parsed_example: parsed,
        block_fallback: false,
        intent: intentFromFamily(parsed.family)
      },
      compare,
      times
    };
  }

  const hasMathSignal = /[+＋=＝\-－□?_？]/.test(text);
  return {
    detected: {
      family: "unknown",
      confidence: hasMathSignal ? 0.6 : 0.35,
      parsed_example: null,
      block_fallback: false,
      intent: "unknown_intent"
    },
    compare,
    times
  };
}

async function detectFamilyFromImage(imageBase64: string): Promise<VisionAttempt> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      status: null,
      error_reason: "gemini_api_key_missing",
      retriable: false
    };
  }

  const payload = base64Payload(imageBase64);
  if (!payload) {
    return {
      ok: false,
      status: null,
      error_reason: "empty_parse",
      retriable: true
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const prompt = [
      "Classify a single elementary math sub-problem.",
      "family must be one of: times_scale_mc, compare_totals_diff_mc, a_plus_blank_eq_b, blank_plus_a_eq_b, a_plus_b_eq_blank, b_minus_a_eq_blank, unknown",
      "Return ONLY JSON: {\"family\":\"times_scale_mc\",\"confidence\":0.86,\"params\":{\"base\":15,\"multiplier\":2}}"
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
                { inline_data: { mime_type: mimeFromInput(imageBase64), data: payload } }
              ]
            }
          ],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
        return { ok: false, status, error_reason: "model_429", retriable: true };
      }
      if (status >= 500) {
        return { ok: false, status, error_reason: "model_5xx", retriable: true };
      }
      return { ok: false, status, error_reason: "model_http_error", retriable: false };
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { ok: false, status: response.status, error_reason: "empty_parse", retriable: true };
    }

    const parsed = JSON.parse(text) as { family?: string; confidence?: number; params?: Record<string, number> };
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));

    if (parsed.family === "times_scale_mc") {
      const base = Math.max(1, Math.trunc(parsed.params?.base ?? 15));
      const multiplier = Math.max(2, Math.trunc(parsed.params?.multiplier ?? 2));
      const normalized = `${base} ${multiplier}倍 何本`;
      const local = detectFamily(normalized);
      const family = local.detected.parsed_example?.family === "times_scale_mc" ? local.detected.parsed_example : parseTimesScale(`黄色は赤の${multiplier}ばい。赤が${base}本のとき何本？`);
      return {
        ok: true,
        status: response.status,
        error_reason: null,
        retriable: false,
        detected: {
          family: "times_scale_mc",
          confidence: Math.max(confidence, 0.8),
          parsed_example: family,
          block_fallback: false,
          intent: intentFromFamily("times_scale_mc")
        },
        compare: local.compare,
        times: local.times
      };
    }

    if (parsed.family === "compare_totals_diff_mc") {
      const a = Math.max(1, Math.trunc(parsed.params?.a ?? 10));
      const b = Math.max(1, Math.trunc(parsed.params?.b ?? 8));
      const c = Math.max(1, Math.trunc(parsed.params?.c ?? 6));
      const d = Math.max(1, Math.trunc(parsed.params?.d ?? 4));
      const parsed_example = parseCompareTotals(`あか${a}こ きいろ${b}こ あか${c}こ きいろ${d}こ どちらが何こ多い あわせて`);
      return {
        ok: true,
        status: response.status,
        error_reason: null,
        retriable: false,
        detected: {
          family: "compare_totals_diff_mc",
          confidence: Math.max(confidence, 0.8),
          parsed_example,
          block_fallback: false,
          intent: intentFromFamily("compare_totals_diff_mc")
        },
        compare: {
          color_hits: 2,
          two_actor_hits: 2,
          compare_word_hits: 1,
          total_word_hits: 1,
          number_count: 4,
          compare_score: 5
        },
        times: {
          times_word_hits: 0,
          question_word_hits: 1,
          pattern_hit: false,
          number_count: 4,
          times_score: 2
        }
      };
    }

    return {
      ok: false,
      status: response.status,
      error_reason: "empty_parse",
      retriable: true
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, status: null, error_reason: "model_timeout", retriable: true };
    }
    return { ok: false, status: null, error_reason: "model_http_error", retriable: false };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rangeByDifficulty(difficulty: Difficulty, example: MicroProblemDsl | null): { min: number; max: number } {
  if (difficulty === "easy") return { min: 0, max: 9 };
  if (difficulty === "hard") return { min: 5, max: 30 };

  if (!example) return { min: 0, max: 12 };
  const values = Object.values(example.params).filter((v): v is number => typeof v === "number");
  const mx = Math.max(...values, example.answer);
  return { min: Math.max(0, mx - 5), max: mx + 5 };
}

function buildProblem(
  family: ProblemFamily,
  rng: () => number,
  difficulty: Difficulty,
  example: MicroProblemDsl | null,
  theme: Theme | null
): MicroProblemDsl {
  const range = rangeByDifficulty(difficulty, example);

  if (family === "times_scale_mc") {
    const baseMin = difficulty === "easy" ? 2 : difficulty === "hard" ? 10 : 5;
    const baseMax = difficulty === "easy" ? 20 : difficulty === "hard" ? 60 : 35;
    const base = randInt(rng, baseMin, baseMax);
    const multiplier = randInt(rng, 2, difficulty === "hard" ? 5 : 3);
    const answer = base * multiplier;
    const subjectA = theme?.subject_a ?? "黄色のチューリップ";
    const subjectB = theme?.subject_b ?? "赤いチューリップ";
    const unit = theme?.unit ?? "本";
    const { choices, correctIndex } = buildEquationChoices(answer, unit);

    return buildProblemBase(
      family,
      {
        base,
        multiplier,
        answer,
        unit,
        subject_a: subjectA,
        subject_b: subjectB,
        choices,
        correct_index: correctIndex
      },
      buildTimesScalePrompt(theme ?? THEME_BANK[0], base, multiplier),
      answer
    );
  }

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
    const subjectA = theme?.subject_a ?? "黄色のチューリップ";
    const subjectB = theme?.subject_b ?? "赤いチューリップ";
    const unit = theme?.unit ?? "こ";
    const winner = redTotal >= yellowTotal ? subjectA : subjectB;
    const { choices, correctIndex } = buildCompareChoices(blank, unit, subjectA, subjectB);

    return buildProblemBase(
      family,
      { a, b, c, d, blank, winner, unit, subject_a: subjectA, subject_b: subjectB, choices, correct_index: correctIndex },
      buildComparePrompt(theme ?? THEME_BANK[0], a, b, c, d),
      blank
    );
  }

  if (family === "a_plus_blank_eq_b") {
    const a = randInt(rng, range.min, range.max);
    const x = randInt(rng, range.min, range.max);
    const b = a + x;
    return buildProblemBase(family, { a, b }, `${a} + □ = ${b}`, x);
  }

  if (family === "blank_plus_a_eq_b") {
    const a = randInt(rng, range.min, range.max);
    const x = randInt(rng, range.min, range.max);
    const b = a + x;
    return buildProblemBase(family, { a, b }, `□ + ${a} = ${b}`, x);
  }

  if (family === "a_plus_b_eq_blank") {
    const a = randInt(rng, range.min, range.max);
    const b = randInt(rng, range.min, range.max);
    return buildProblemBase(family, { a, b }, `${a} + ${b} = □`, a + b);
  }

  const a = randInt(rng, range.min, range.max);
  const diff = randInt(rng, range.min, range.max);
  const b = a + diff;
  return buildProblemBase(family, { a, b }, `${b} - ${a} = □`, diff);
}

function solve(problem: MicroProblemDsl): number {
  const p = problem.params;
  switch (problem.family) {
    case "a_plus_blank_eq_b":
      return Number(p.b) - Number(p.a);
    case "blank_plus_a_eq_b":
      return Number(p.b) - Number(p.a);
    case "a_plus_b_eq_blank":
      return Number(p.a) + Number(p.b);
    case "b_minus_a_eq_blank":
      return Number(p.b) - Number(p.a);
    case "compare_totals_diff_mc":
      return Math.abs((Number(p.a) + Number(p.c)) - (Number(p.b) + Number(p.d)));
    case "times_scale_mc":
      return Number(p.base) * Number(p.multiplier);
  }
}

function isInRangeForDifficulty(problem: MicroProblemDsl, difficulty: Difficulty): boolean {
  const numericParams = Object.values(problem.params).filter((v): v is number => typeof v === "number");
  const vals = [...numericParams, problem.answer];
  if (difficulty === "easy") return vals.every((v) => v >= 0 && v <= 30);
  if (difficulty === "hard") return vals.every((v) => v >= 0 && v <= 120);
  return vals.every((v) => v >= 0 && v <= 70);
}

function validateModeItems(problem: MicroProblemDsl): string | null {
  if (problem.detected_mode === "word_problem") {
    if (!problem.required_items.includes("prompt") || !problem.required_items.includes("choices")) {
      return "mode_items_mismatch";
    }
  }
  if (problem.detected_mode === "equation") {
    if (!problem.required_items.includes("expression")) {
      return "mode_items_mismatch";
    }
  }

  const itemTypes = new Set(problem.items.map((i) => i.type));
  for (const req of problem.required_items) {
    if (req === "prompt" && !itemTypes.has("prompt")) return "mode_items_mismatch";
    if (req === "choices" && !itemTypes.has("choices")) return "mode_items_mismatch";
    if (req === "expression" && !itemTypes.has("expression")) return "mode_items_mismatch";
  }

  const choicesItem = problem.items.find((i) => i.type === "choices");
  if (choicesItem && choicesItem.type === "choices") {
    if (choicesItem.correct_index < 0 || choicesItem.correct_index >= choicesItem.choices.length) {
      return "choices_index_invalid";
    }
  }

  return null;
}

function validateThemeLexicon(problem: MicroProblemDsl, theme: Theme | null): string | null {
  if (!theme) return null;
  if (problem.detected_mode !== "word_problem") return null;

  const promptItem = problem.items.find((i) => i.type === "prompt");
  if (!promptItem || promptItem.type !== "prompt") return "theme_lexicon_mismatch";
  const promptText = promptItem.text;

  if (theme.id !== "tulip" && promptText.includes("さいています")) {
    return "theme_lexicon_mismatch";
  }

  if (!promptText.includes(theme.verb_exist)) {
    return "theme_lexicon_mismatch";
  }

  if (!promptText.includes(theme.unit)) {
    return "theme_lexicon_mismatch";
  }

  const choicesItem = problem.items.find((i) => i.type === "choices");
  if (!choicesItem || choicesItem.type !== "choices") return "theme_lexicon_mismatch";
  const unitMismatch = choicesItem.choices.some((c) => !c.includes(theme.unit));
  if (unitMismatch) return "theme_lexicon_mismatch";

  return null;
}

function validateProblem(problem: MicroProblemDsl, difficulty: Difficulty): string | null {
  const parsed = microProblemDslSchema.safeParse(problem);
  if (!parsed.success) return "schema_invalid";

  if (problem.family === "times_scale_mc") {
    const p = problem.params;
    const needed = ["base", "multiplier", "answer"] as const;
    if (!needed.every((k) => Number.isInteger(Number(p[k])))) return "missing_times_params";
    if (Number(p.multiplier) < 2) return "times_multiplier_too_small";
    const computed = Number(p.base) * Number(p.multiplier);
    if (Number(p.answer) !== computed) return "times_answer_mismatch";
    const choiceList = Array.isArray(p.choices) ? p.choices : [];
    const answerToken = `${computed}${String(p.unit ?? "")}`;
    const contains = choiceList.filter((c) => c === answerToken).length;
    if (contains !== 1) return "times_choices_invalid";
  }

  if (problem.family === "compare_totals_diff_mc") {
    const p = problem.params;
    const needed = ["a", "b", "c", "d", "blank"] as const;
    if (!needed.every((k) => Number.isInteger(Number(p[k])))) return "missing_compare_params";
    const computed = Math.abs((Number(p.a) + Number(p.c)) - (Number(p.b) + Number(p.d)));
    if (Number(p.blank) !== computed) return "compare_blank_mismatch";
    if (Number(p.blank) < 0) return "negative_answer";
  }

  const modeReason = validateModeItems(problem);
  if (modeReason) return modeReason;

  if (solve(problem) !== problem.answer) return "solver_mismatch";
  if (problem.answer < 0) return "negative_answer";
  if (!isInRangeForDifficulty(problem, difficulty)) return "difficulty_out_of_range";

  return null;
}

function bumpReason(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

function countPolicy(family: ProblemFamily | "unknown", requestedN: 4 | 5 | 10): { maxCount: number; appliedCount: number; note: string } {
  if (family === "compare_totals_diff_mc" || family === "times_scale_mc") {
    const maxCount = 5;
    return { maxCount, appliedCount: Math.min(requestedN, maxCount), note: "文章題は5問まで" };
  }
  return { maxCount: requestedN, appliedCount: requestedN, note: "requested_count_applied" };
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

  let selectedDetectorPath: DetectorPath = textPresent ? "text_detector" : "image_gemini_detector";
  let detectorFallbackReason: FallbackReason | null = null;
  let modelHttpStatus: number | null = null;
  let fallbackCount = 0;
  let inferenceLatencyMs = 0;
  let decodeDebug: DecodeFallbackDebug = {
    ocr_line_count: 0,
    keyword_hits: 0,
    parse_candidates_count: 0
  };

  const imageBase64 = parsedReq.data.image_base64 ?? "";
  const imageBytes = imageBytesLength(imageBase64);
  const imageMime = hasImageBase64 ? mimeFromInput(imageBase64) : "text/plain";

  console.log(
    JSON.stringify({
      event: "micro_generate_input",
      request_id: requestId,
      has_image_base64: hasImageBase64,
      text_present: textPresent,
      selected_detector_path: selectedDetectorPath
    })
  );

  let detected: DetectResult;
  let compareSignals: CompareSignals;
  let timesSignals: TimesSignals;

  if (parsedReq.data.text) {
    const det = detectFamily(parsedReq.data.text);
    detected = det.detected;
    compareSignals = det.compare;
    timesSignals = det.times;
  } else {
    selectedDetectorPath = "image_gemini_detector";
    const started = Date.now();
    const firstAttempt = await detectFamilyFromImage(imageBase64);
    let vision = firstAttempt;
    modelHttpStatus = firstAttempt.status;

    if (!firstAttempt.ok && firstAttempt.retriable && (firstAttempt.error_reason === "model_timeout" || firstAttempt.error_reason === "model_429" || firstAttempt.error_reason === "model_5xx" || firstAttempt.error_reason === "empty_parse")) {
      fallbackCount += 1;
      await sleep(150);
      const secondAttempt = await detectFamilyFromImage(imageBase64);
      vision = secondAttempt;
      modelHttpStatus = secondAttempt.status ?? modelHttpStatus;
    }

    inferenceLatencyMs = Date.now() - started;

    if (vision.ok && vision.detected && vision.compare && vision.times) {
      detected = vision.detected;
      compareSignals = vision.compare;
      timesSignals = vision.times;
    } else {
      detectorFallbackReason = vision.error_reason ?? "decode_text_fallback_failed";
      selectedDetectorPath = "image_base64_decode_text_detector";
      const decodedText = decodeBase64Text(imageBase64);
      decodeDebug = buildDecodeFallbackDebug(decodedText);
      const det = detectFamily(decodedText);
      compareSignals = det.compare;
      timesSignals = det.times;

      // Fail closed: decode fallback is observational only.
      detected = {
        family: "unknown",
        confidence: 0.35,
        parsed_example: null,
        block_fallback: true,
        intent: "unknown_intent"
      };

      if (decodeDebug.parse_candidates_count === 0 && !detectorFallbackReason) {
        detectorFallbackReason = "decode_text_fallback_failed";
      }
    }
  }

  const detectedFamilyBeforeFallback = detected.family;
  const needConfirmBase = detected.confidence < DETECT_CONFIDENCE_THRESHOLD || detected.family === "unknown";
  const generationFamily: ProblemFamily | null =
    detected.family === "unknown" ? (detected.block_fallback ? null : null) : detected.family;
  const detectedFamilyAfterFallback = generationFamily;
  const unknownNote = detectorFallbackReason ?? "insufficient_signals";

  console.log(
    JSON.stringify({
      event: "micro_generate_detection",
      request_id: requestId,
      signal_counts: compareSignals,
      compare_score: compareSignals.compare_score,
      times_signal_counts: timesSignals,
      detected_family_before_fallback: detectedFamilyBeforeFallback,
      detected_family_after_fallback: detectedFamilyAfterFallback,
      block_arithmetic_fallback: detected.block_fallback
    })
  );

  const policy = countPolicy(detected.family, parsedReq.data.N);

  const rngSeed = hashToSeed(
    JSON.stringify({
      input: parsedReq.data.text ? normalizeText(parsedReq.data.text) : parsedReq.data.image_base64 ?? "",
      N: policy.appliedCount,
      difficulty: parsedReq.data.difficulty,
      seed: String(parsedReq.data.seed),
      family: generationFamily ?? "unknown"
    })
  );
  const rng = mulberry32(rngSeed);
  const seedAsString = String(parsedReq.data.seed);
  const selectedTheme =
    generationFamily && isWordProblemFamily(generationFamily) ? pickTheme(seedAsString, generationFamily) : null;

  const problems: MicroProblemDsl[] = [];
  const seen = new Set<string>();
  const reasons: Record<string, number> = {};
  let rejectedCount = 0;

  if (generationFamily) {
    for (let i = 0; i < MAX_REGEN_TRIES && problems.length < policy.appliedCount; i += 1) {
      const problem = buildProblem(generationFamily, rng, parsedReq.data.difficulty, detected.parsed_example, selectedTheme);
      const duplicateKey = JSON.stringify({ render_text: problem.render_text, params: problem.params });

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

      const lexiconReason = validateThemeLexicon(problem, selectedTheme);
      if (lexiconReason) {
        rejectedCount += 1;
        bumpReason(reasons, lexiconReason);
        continue;
      }

      seen.add(duplicateKey);
      problems.push(problem);
    }
  } else {
    bumpReason(reasons, "unknown_no_generation");
  }

  const forceUnknownByLexicon = problems.length === 0 && (reasons.theme_lexicon_mismatch ?? 0) > 0;
  const needConfirm = needConfirmBase || forceUnknownByLexicon;

  const mode = forceUnknownByLexicon ? "unknown" : modeFromFamily(detected.family);
  const requiredItems = requiredItemsFromMode(mode);
  const topItems = problems.length > 0 ? problems[0].items : [];

  let response = {
    spec_version: "micro_problem_render_v1" as const,
    request_id: requestId,
    schema_version: "micro_generate_response_v1" as const,
    detected_mode: mode,
    intent: detected.intent,
    confidence: detected.confidence,
    required_items: requiredItems,
    items: topItems,
    detected: forceUnknownByLexicon
      ? {
          family: "unknown" as const,
          confidence: Math.min(detected.confidence, 0.6),
          parsed_example: null
        }
      : {
          family: detected.family,
          confidence: detected.confidence,
          parsed_example: detected.parsed_example
        },
    problems,
    rejected_count: rejectedCount,
    reasons,
    need_confirm: needConfirm,
    ...(needConfirm ? { confirm_choices: [...problemFamilySchema.options] } : {}),
    debug: {
      deploy_commit: DEPLOY_COMMIT,
      build_timestamp: BUILD_TIMESTAMP,
      selected_detector_path: selectedDetectorPath,
      detector_fallback_reason: detectorFallbackReason,
      image_bytes_length: imageBytes,
      mime_type: imageMime,
      model_name: GEMINI_MODEL,
      model_http_status: modelHttpStatus,
      ocr_line_count: decodeDebug.ocr_line_count,
      keyword_hits: decodeDebug.keyword_hits,
      parse_candidates_count: decodeDebug.parse_candidates_count,
      prompt_verb: selectedTheme?.verb_exist ?? null,
      prompt_unit: selectedTheme?.unit ?? null,
      lexicon_version: LEXICON_VERSION
    },
    meta: {
      family: String(detected.family),
      count_policy: "server_enforced",
      max_count: policy.maxCount,
      applied_count: policy.appliedCount,
      note: forceUnknownByLexicon ? "theme_lexicon_mismatch" : generationFamily ? policy.note : unknownNote,
      seed: seedAsString,
      sha: sha(JSON.stringify(problems.map((p) => ({ f: p.family, t: p.render_text })))),
      request_hash: sha(parsedReq.data.text ? normalizeText(parsedReq.data.text) : imageBase64),
      detector_version: DETECTOR_VERSION,
      fallback_count: fallbackCount,
      inference_latency_ms: inferenceLatencyMs,
      ...(selectedTheme
        ? {
            theme_id: selectedTheme.id,
            theme_candidates: THEME_BANK.map((t) => t.id),
            theme_policy: "seed_deterministic" as const
          }
        : {})
    }
  };

  const topLevelModeMismatch =
    (response.detected_mode === "word_problem" && !response.required_items.includes("prompt")) ||
    (response.detected_mode === "equation" && !response.required_items.includes("expression"));
  const topLevelItemsMismatch = response.required_items.some((req) => {
    if (req === "prompt") return !response.items.some((i) => i.type === "prompt");
    if (req === "choices") return !response.items.some((i) => i.type === "choices");
    if (req === "expression") return !response.items.some((i) => i.type === "expression");
    return false;
  });

  if (topLevelModeMismatch || topLevelItemsMismatch) {
    response = {
      ...response,
      detected_mode: "unknown",
      intent: "unknown_intent",
      required_items: [],
      items: [],
      problems: [],
      need_confirm: true,
      confirm_choices: [...problemFamilySchema.options],
      meta: {
        ...response.meta,
        applied_count: 0,
        note: "mode_items_mismatch"
      }
    };
  }

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

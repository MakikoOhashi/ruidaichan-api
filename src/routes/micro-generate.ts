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

type DetectResult = {
  family: ProblemFamily | "unknown";
  confidence: number;
  parsed_example: MicroProblemDsl | null;
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

function detectCompareTotalsSignals(text: string): { hit: boolean; confidence: number } {
  const normalized = normalizeText(text);
  const numberCount = [...normalized.matchAll(/\d+/g)].length;

  const colorTokens = ["あか", "赤", "きいろ", "黄", "しろ", "白", "くろ", "黒", "あお", "青"];
  const categoryHits = new Set(colorTokens.filter((t) => normalized.includes(t))).size;
  const groupHits = [...normalized.matchAll(/[^。．\s]{1,8}は/g)].length;
  const hasCompareWord = /(どちら|どっち|何こ多い|なんこおおい|何個多い|多い)/.test(normalized);
  const hasSumWord = /(合わせ|あわせ|合計|ぜんぶ|全部)/.test(normalized);

  const score =
    (categoryHits >= 2 ? 1 : 0) +
    (groupHits >= 2 ? 1 : 0) +
    (hasCompareWord ? 1 : 0) +
    (hasSumWord ? 1 : 0) +
    (numberCount >= 4 ? 1 : 0);

  if (score >= 4) return { hit: true, confidence: 0.9 };
  if (score === 3) return { hit: true, confidence: 0.78 };
  return { hit: false, confidence: 0 };
}

function detectFamily(text: string): DetectResult {
  const compareSignal = detectCompareTotalsSignals(text);
  if (compareSignal.hit) {
    const parsedCompare = parseCompareTotals(text);
    if (parsedCompare) {
      return {
        family: "compare_totals_diff_mc",
        confidence: compareSignal.confidence,
        parsed_example: parsedCompare
      };
    }
  }

  const parsed = parseByFamily(text);
  if (parsed) {
    return { family: parsed.family, confidence: 0.92, parsed_example: parsed };
  }

  const hasMathSignal = /[+＋=＝\-－□?_？]/.test(text);
  if (hasMathSignal) {
    return { family: "unknown", confidence: 0.6, parsed_example: null };
  }

  return { family: "unknown", confidence: 0.35, parsed_example: null };
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

  const parsedReq = microGenerateRequestSchema.safeParse(req.body);
  if (!parsedReq.success) {
    return res.status(400).json({
      error: "invalid_request",
      request_id: requestId,
      details: parsedReq.error.flatten()
    });
  }

  const inputText = parsedReq.data.text ? normalizeText(parsedReq.data.text) : decodeBase64Text(parsedReq.data.image_base64 ?? "");
  const detected = detectFamily(inputText);

  const needConfirm = detected.confidence < DETECT_CONFIDENCE_THRESHOLD || detected.family === "unknown";
  const candidateFamilies = problemFamilySchema.options;
  const generationFamily: ProblemFamily = detected.family === "unknown" ? "a_plus_blank_eq_b" : detected.family;

  const rngSeed = hashToSeed(
    JSON.stringify({
      input: inputText,
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
    ...(needConfirm ? { confirm_choices: [...candidateFamilies] } : {})
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
      need_confirm: validated.data.need_confirm
    })
  );

  return res.status(200).json(validated.data);
});

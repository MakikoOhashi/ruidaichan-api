import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
type ParseStage = "local_ocr_regex" | "ai_refine" | "unknown";
type OcrPrimaryEngine = "vision" | "tesseract" | "none";

type FallbackReason =
  | "gemini_api_key_missing"
  | "model_timeout"
  | "model_429"
  | "model_5xx"
  | "model_http_error"
  | "empty_parse"
  | "decode_text_fallback_failed";

type EquationCandidateSource = "detector_text" | "ocr_lines" | "raw_ocr" | "none";
type CorrectionStage = "deterministic" | "ai_assist" | "none";
type InferenceLevel = "strict" | "soft" | "unknown";
type CandidateSourceStage = "deterministic" | "heuristic" | "ai_assist";
type InputForm = "equation_like" | "word_problem_like" | "unknown_like";

type Candidate = {
  detected: DetectResult;
  source_stage: CandidateSourceStage;
  inference_level: Exclude<InferenceLevel, "unknown">;
  score: number;
};

type IntentCandidate = {
  intent: string;
  detected_mode: "equation" | "word_problem" | "unknown";
  confidence: number;
  source_stage: CandidateSourceStage;
};

type SemanticRelationType = "add" | "subtract" | "multiply" | "divide" | "repeat_multiply" | "compare_diff" | "scale_times";
type SemanticFrameV1 = {
  spec_version: "semantic_frame_v1";
  givens: Array<{ name: string; value: number; unit?: string }>;
  relations: Array<{ type: SemanticRelationType; args: string[] }>;
  ask: { target: string; unit?: string };
  constraints: { grade_band: "g1_g3" };
  confidence: number;
};

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
  detector_text?: string;
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

function extensionFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "bin";
}

function splitOcrLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function runTesseract(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", [imagePath, "stdout", "-l", "jpn+eng", "--psm", "6"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tesseract_timeout"));
    }, 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`tesseract_failed:${code}:${stderr.slice(0, 160)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function extractPrimaryOcrFromImage(imageBase64: string): Promise<{ engine: OcrPrimaryEngine; lines: string[]; raw: string }> {
  const stubText = process.env.LOCAL_OCR_STUB_TEXT;
  if (stubText && stubText.trim()) {
    const raw = stubText.trim();
    return { engine: "tesseract", lines: splitOcrLines(raw), raw };
  }

  const mime = mimeFromInput(imageBase64);
  const payload = base64Payload(imageBase64);
  if (!payload) return { engine: "none", lines: [], raw: "" };
  if (!mime.startsWith("image/")) return { engine: "none", lines: [], raw: "" };

  const bytes = Buffer.from(payload, "base64");
  const dir = await mkdtemp(join(tmpdir(), "ruidaichan-ocr-"));
  const file = join(dir, `input.${extensionFromMime(mime)}`);
  try {
    await writeFile(file, bytes);
    const out = (await runTesseract(file)).trim();
    if (!out) return { engine: "none", lines: [], raw: "" };
    return { engine: "tesseract", lines: splitOcrLines(out), raw: out };
  } catch {
    return { engine: "none", lines: [], raw: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  if (family === "a_plus_b_minus_c_eq_blank") return "equation_add_sub_blank";
  if (family === "unknown") return "unknown_intent";
  return "solve_blank_equation";
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
  const eqNormalized = normalizeEquationText(normalized).normalized;

  const p5 = eqNormalized.match(/^(\d+)\s*\+\s*(\d+)\s*-\s*(\d+)\s*=\s*[□?_？]$/);
  if (p5) {
    const a = Number(p5[1]);
    const b = Number(p5[2]);
    const c = Number(p5[3]);
    return buildProblemBase("a_plus_b_minus_c_eq_blank", { a, b, c }, `${a} + ${b} - ${c} = □`, a + b - c);
  }

  const p1 = eqNormalized.match(/^(\d+)\s*\+\s*[□?_？]\s*=\s*(\d+)$/);
  if (p1) {
    const a = Number(p1[1]);
    const b = Number(p1[2]);
    return buildProblemBase("a_plus_blank_eq_b", { a, b }, `${a} + □ = ${b}`, b - a);
  }

  const p2 = eqNormalized.match(/^[□?_？]\s*\+\s*(\d+)\s*=\s*(\d+)$/);
  if (p2) {
    const a = Number(p2[1]);
    const b = Number(p2[2]);
    return buildProblemBase("blank_plus_a_eq_b", { a, b }, `□ + ${a} = ${b}`, b - a);
  }

  const p3 = eqNormalized.match(/^(\d+)\s*\+\s*(\d+)\s*=\s*[□?_？]$/);
  if (p3) {
    const a = Number(p3[1]);
    const b = Number(p3[2]);
    return buildProblemBase("a_plus_b_eq_blank", { a, b }, `${a} + ${b} = □`, a + b);
  }

  const p4 = eqNormalized.match(/^(\d+)\s*-\s*(\d+)\s*=\s*[□?_？]$/);
  if (p4) {
    const b = Number(p4[1]);
    const a = Number(p4[2]);
    return buildProblemBase("b_minus_a_eq_blank", { a, b }, `${b} - ${a} = □`, b - a);
  }

  return null;
}

function normalizeEquationText(s: string): { normalized: string; compact: string } {
  const normalized = s
    .normalize("NFKC")
    .replace(/\[\s*\]/g, "□")
    .replace(/[口ロ＿_]/g, "□")
    .replace(/[−ー–―]/g, "-")
    .replace(/[＋]/g, "+")
    .replace(/[＝]/g, "=")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    normalized,
    compact: normalized.replace(/\s+/g, "")
  };
}

function splitChoiceText(text: string): { mainText: string; choicesText: string } {
  const choiceStart = text.search(/[①-⑩]/);
  if (choiceStart < 0) return { mainText: text, choicesText: "" };
  return {
    mainText: text.slice(0, choiceStart),
    choicesText: text.slice(choiceStart)
  };
}

function stripQuestionNumberNoise(text: string): string {
  return text.replace(/[（(]\d+[）)]/g, " ").replace(/\b\d+\./g, " ");
}

function extractEquationCandidates(text: string): string[] {
  const cleaned = stripQuestionNumberNoise(splitChoiceText(text).mainText);
  const compact = normalizeEquationText(cleaned).compact;
  if (!compact) return [];

  const patterns: Array<{ re: RegExp; priority: number }> = [
    { re: /\d+\+\d+-\d+=(?:[□口ロ＿_Il\|]|\d+)?/g, priority: 3 },
    { re: /\d+\+\d+=(?:[□口ロ＿_Il\|]|\d+)?/g, priority: 2 },
    { re: /\d+-\d+=(?:[□口ロ＿_Il\|]|\d+)?/g, priority: 1 }
  ];

  const hits: Array<{ text: string; start: number; end: number; priority: number }> = [];
  for (const p of patterns) {
    for (const m of compact.matchAll(p.re)) {
      const v = m[0];
      if (!v) continue;
      hits.push({
        text: v,
        start: m.index ?? 0,
        end: (m.index ?? 0) + v.length,
        priority: p.priority
      });
    }
  }

  hits.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.text.length - a.text.length;
  });

  const selected: Array<{ text: string; start: number; end: number }> = [];
  for (const h of hits) {
    const overlaps = selected.some((s) => !(h.end <= s.start || h.start >= s.end));
    if (overlaps) continue;
    selected.push({ text: h.text, start: h.start, end: h.end });
  }

  const dedup: string[] = [];
  const seen = new Set<string>();
  for (const s of selected) {
    if (seen.has(s.text)) continue;
    seen.add(s.text);
    dedup.push(s.text);
  }
  return dedup;
}

function hasChoiceSignals(text: string): boolean {
  return /[①-⑩]|つぎから1つ|つぎから１つ|えらびなさい|選びなさい/.test(text);
}

function deterministicBlankCorrection(inputText: string): {
  before: string;
  after: string;
  ambiguous: boolean;
  blank_missing_detected: boolean;
  blank_missing_rewritten: boolean;
  blank_confusion_detected: boolean;
  blank_confusion_original: string | null;
  blank_confusion_rewritten: string | null;
  reason: "blank_ocr_confusion" | "missing_blank" | null;
} {
  const candidates = extractEquationCandidates(inputText);
  if (candidates.length === 0) {
    return {
      before: "",
      after: "",
      ambiguous: false,
      blank_missing_detected: false,
      blank_missing_rewritten: false,
      blank_confusion_detected: false,
      blank_confusion_original: null,
      blank_confusion_rewritten: null,
      reason: null
    };
  }

  if (candidates.length > 1) {
    return {
      before: candidates.join("|"),
      after: "",
      ambiguous: true,
      blank_missing_detected: candidates.some((x) => x.endsWith("=")),
      blank_missing_rewritten: false,
      blank_confusion_detected: false,
      blank_confusion_original: null,
      blank_confusion_rewritten: null,
      reason: null
    };
  }

  const snippet = candidates[0];
  const parsed = snippet.match(/^(\d+)([+\-])(\d+)(?:-(\d+))?=(.*)$/);
  if (!parsed) {
    return {
      before: snippet,
      after: snippet,
      ambiguous: false,
      blank_missing_detected: false,
      blank_missing_rewritten: false,
      blank_confusion_detected: false,
      blank_confusion_original: null,
      blank_confusion_rewritten: null,
      reason: null
    };
  }

  const rhs = (parsed[5] ?? "").trim();
  const blankLike = new Set(["□", "口", "ロ", "_", "＿", "I", "l", "|", "[]", ""]);
  const choiceSignals = hasChoiceSignals(inputText);

  if (rhs === "") {
    if (choiceSignals) {
      return {
        before: snippet,
        after: `${snippet}□`,
        ambiguous: false,
        blank_missing_detected: true,
        blank_missing_rewritten: true,
        blank_confusion_detected: false,
        blank_confusion_original: null,
        blank_confusion_rewritten: null,
        reason: "missing_blank"
      };
    }

    return {
      before: snippet,
      after: snippet,
      ambiguous: false,
      blank_missing_detected: true,
      blank_missing_rewritten: false,
      blank_confusion_detected: false,
      blank_confusion_original: null,
      blank_confusion_rewritten: null,
      reason: null
    };
  }

  if (blankLike.has(rhs)) {
    const rewritten = `${parsed[1]}${parsed[2]}${parsed[3]}${parsed[4] ? `-${parsed[4]}` : ""}=□`;
    const confused = rhs !== "□";
    return {
      before: snippet,
      after: rewritten,
      ambiguous: false,
      blank_missing_detected: false,
      blank_missing_rewritten: false,
      blank_confusion_detected: confused,
      blank_confusion_original: confused ? rhs || "empty" : null,
      blank_confusion_rewritten: confused ? "□" : null,
      reason: confused ? "blank_ocr_confusion" : null
    };
  }

  // Conservative promotion from "=1" only when equation appears once and choice-style wording exists.
  const singleDigitRhs = /^\d$/.test(rhs);
  if (singleDigitRhs && rhs === "1" && candidates.length === 1 && choiceSignals) {
    const rewritten = `${parsed[1]}${parsed[2]}${parsed[3]}${parsed[4] ? `-${parsed[4]}` : ""}=□`;
    return {
      before: snippet,
      after: rewritten,
      ambiguous: false,
      blank_missing_detected: false,
      blank_missing_rewritten: false,
      blank_confusion_detected: true,
      blank_confusion_original: rhs,
      blank_confusion_rewritten: "□",
      reason: "blank_ocr_confusion"
    };
  }

  return {
    before: snippet,
    after: snippet,
    ambiguous: false,
    blank_missing_detected: false,
    blank_missing_rewritten: false,
    blank_confusion_detected: false,
    blank_confusion_original: null,
    blank_confusion_rewritten: null,
    reason: null
  };
}

async function proposeEquationCorrectionWithAi(inputText: string, deterministicCandidate: string, choicesText: string): Promise<{
  normalized_expression: string;
  confidence: number;
  reason: string;
} | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = [
    "You normalize OCR math text for elementary equation blanks.",
    "Return strict JSON only:",
    '{"normalized_expression":"7+9-6=□","confidence":0.85,"reason":"blank_ocr_confusion"}',
    "Rules:",
    "- Keep only one equation snippet.",
    "- Use □ for blank.",
    "- If uncertain, return the deterministic candidate unchanged."
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(GEMINI_TIMEOUT_MS, 4000));
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${prompt}\ninput:${inputText}\ndeterministic:${deterministicCandidate}\nchoices:${choicesText}` }]
            }
          ],
          generationConfig: { temperature: 0, responseMimeType: "application/json" }
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
      normalized_expression?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    const expression = typeof parsed.normalized_expression === "string" ? parsed.normalized_expression : "";
    const confidence = Number(parsed.confidence ?? 0);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "ai_proposal";
    if (!expression) return null;
    return {
      normalized_expression: expression,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function shouldAttemptAiEquationCorrection(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeEquationText(text).compact;
  const hasEquationSignals = /[0-9]/.test(normalized) && /[=+\-□口ロ_＿]/.test(normalized);
  return hasEquationSignals;
}

function cleanCandidateText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function isLikelyBinaryText(s: string): { binary: boolean; reason: string | null } {
  if (!s) return { binary: false, reason: null };
  if (s.includes("PNG") || s.includes("IHDR") || s.includes("iCCP")) {
    return { binary: true, reason: "png_signature" };
  }

  const length = Math.max(1, s.length);
  const replacementCount = [...s].filter((ch) => ch === "\uFFFD").length;
  if (replacementCount / length > 0.02) {
    return { binary: true, reason: "replacement_char_ratio_high" };
  }

  const controlCount = [...s].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t";
  }).length;
  if (controlCount / length > 0.01) {
    return { binary: true, reason: "control_char_ratio_high" };
  }

  const abnormalCount = [...s].filter((ch) => !/[0-9A-Za-zぁ-ゖァ-ヺ一-龯々〆ヵヶ\s+\-=□_口ロ\[\]（）()、。・？！]/.test(ch)).length;
  if (abnormalCount / length > 0.35) {
    return { binary: true, reason: "abnormal_char_ratio_high" };
  }

  return { binary: false, reason: null };
}

function buildEquationCandidateText(input: {
  detector_text?: string;
  ocr_lines?: string[];
  raw_ocr?: string;
}): { text: string; source: EquationCandidateSource; normalize_input_empty: boolean } {
  const detectorText = cleanCandidateText(input.detector_text ?? "");
  if (detectorText) return { text: detectorText, source: "detector_text", normalize_input_empty: false };

  const ocrJoined = cleanCandidateText((input.ocr_lines ?? []).filter(Boolean).join(" "));
  if (ocrJoined) return { text: ocrJoined, source: "ocr_lines", normalize_input_empty: false };

  const rawOcr = cleanCandidateText(input.raw_ocr ?? "");
  if (rawOcr) return { text: rawOcr, source: "raw_ocr", normalize_input_empty: false };

  return { text: "", source: "none", normalize_input_empty: true };
}

function equationFallbackParser(candidateText: string): { parsed: MicroProblemDsl; normalized_text: string; compact_text: string } | null {
  const { normalized, compact } = normalizeEquationText(candidateText);
  if (!normalized) return null;

  const p1 = compact.match(/^(\d+)\+(\d+)-(\d+)=□$/);
  if (p1) {
    const a = Number(p1[1]);
    const b = Number(p1[2]);
    const c = Number(p1[3]);
    return {
      parsed: buildProblemBase("a_plus_b_minus_c_eq_blank", { a, b, c }, `${a} + ${b} - ${c} = □`, a + b - c),
      normalized_text: normalized.slice(0, 100),
      compact_text: compact.slice(0, 100)
    };
  }

  const p2 = compact.match(/^(\d+)\+(\d+)-(\d+)=$/);
  if (p2) {
    const a = Number(p2[1]);
    const b = Number(p2[2]);
    const c = Number(p2[3]);
    return {
      parsed: buildProblemBase("a_plus_b_minus_c_eq_blank", { a, b, c }, `${a} + ${b} - ${c} = □`, a + b - c),
      normalized_text: normalized.slice(0, 100),
      compact_text: compact.slice(0, 100)
    };
  }

  const p3 = compact.match(/^(\d+)\+(\d+)-(\d+)=([□口ロ_])$/);
  if (p3) {
    const a = Number(p3[1]);
    const b = Number(p3[2]);
    const c = Number(p3[3]);
    return {
      parsed: buildProblemBase("a_plus_b_minus_c_eq_blank", { a, b, c }, `${a} + ${b} - ${c} = □`, a + b - c),
      normalized_text: normalized.slice(0, 100),
      compact_text: compact.slice(0, 100)
    };
  }

  const parsed = parseByFamily(normalized);
  if (!parsed) return null;
  return {
    parsed,
    normalized_text: normalized.slice(0, 100),
    compact_text: compact.slice(0, 100)
  };
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

function parseRepeatMultiplyWordProblem(text: string): MicroProblemDsl | null {
  const normalized = normalizeText(text);
  const m = normalized.match(/(\d+)(?:日間|日|回).{0,8}(\d+)(?:こ|個|本|まい|枚|L)/);
  if (!m) return null;
  const days = Number(m[1]);
  const perDay = Number(m[2]);
  if (!Number.isInteger(days) || !Number.isInteger(perDay) || days <= 0 || perDay <= 0) return null;
  const unitMatch = normalized.match(/(こ|個|本|まい|枚|L)/);
  const unit = unitMatch?.[1] === "個" ? "こ" : unitMatch?.[1] === "枚" ? "まい" : unitMatch?.[1] ?? "こ";
  const answer = days * perDay;
  const { choices, correctIndex } = buildEquationChoices(answer, unit);
  return buildProblemBase(
    "times_scale_mc",
    {
      base: perDay,
      multiplier: days,
      answer,
      unit,
      subject_a: "ぜんぶ",
      subject_b: "1にち",
      choices,
      correct_index: correctIndex
    },
    `${days}日間、1日${perDay}${unit}ずつあります。ぜんぶで何${unit}ですか。つぎから1つえらびなさい。`,
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

function classifyInputForm(text: string): {
  input_form: InputForm;
  input_form_score: { equation_like: number; word_problem_like: number };
} {
  const normalized = normalizeText(text);
  const compact = normalizeEquationText(normalized).compact;
  const equationSignals =
    (compact.match(/[+\-=□]/g) ?? []).length +
    (compact.match(/\d+\+\d+/g) ? 2 : 0) +
    (compact.match(/\d+=/g) ? 1 : 0);
  const wordSignals =
    [...normalized.matchAll(/何こ|何個|何本|どちら|つぎから1つ|えらびなさい|選びなさい/g)].length +
    [...normalized.matchAll(/こ|本|まい|L/g)].length +
    ([...normalized.matchAll(/\d+/g)].length >= 2 ? 1 : 0);

  const input_form: InputForm =
    equationSignals >= 3 && equationSignals >= wordSignals + 1
      ? "equation_like"
      : wordSignals >= 3
      ? "word_problem_like"
      : "unknown_like";

  return {
    input_form,
    input_form_score: { equation_like: equationSignals, word_problem_like: wordSignals }
  };
}

function pushCandidate(pool: Candidate[], candidate: Candidate): void {
  const family = candidate.detected.family;
  if (family === "unknown") return;
  const key = `${family}:${candidate.source_stage}:${candidate.detected.parsed_example?.render_text ?? "no_example"}`;
  const exists = pool.find((c) => `${c.detected.family}:${c.source_stage}:${c.detected.parsed_example?.render_text ?? "no_example"}` === key);
  if (!exists) {
    pool.push(candidate);
  }
}

function buildHeuristicSalvageCandidates(inputText: string): Candidate[] {
  const out: Candidate[] = [];
  const normalized = normalizeText(inputText);
  if (!normalized) return out;

  const eqCandidates = extractEquationCandidates(normalized);
  if (eqCandidates.length === 1) {
    const corrected = deterministicBlankCorrection(normalized);
    const eqText = corrected.after || eqCandidates[0];
    const parsed = equationFallbackParser(eqText);
    if (parsed) {
      pushCandidate(out, {
        detected: {
          family: parsed.parsed.family,
          confidence: corrected.reason ? 0.65 : 0.58,
          parsed_example: parsed.parsed,
          block_fallback: false,
          intent: intentFromFamily(parsed.parsed.family)
        },
        source_stage: "heuristic",
        inference_level: "soft",
        score: corrected.reason ? 0.65 : 0.58
      });
    }
  }

  const compare = detectCompareTotalsSignals(normalized);
  if (compare.compare_score >= 3) {
    const parsed = parseCompareTotals(normalized);
    if (parsed) {
      pushCandidate(out, {
        detected: {
          family: "compare_totals_diff_mc",
          confidence: 0.6,
          parsed_example: parsed,
          block_fallback: false,
          intent: intentFromFamily("compare_totals_diff_mc")
        },
        source_stage: "heuristic",
        inference_level: "soft",
        score: 0.6
      });
    }
  }

  const times = detectTimesSignals(normalized);
  if (times.times_word_hits > 0 && times.number_count >= 2) {
    const parsed = parseTimesScale(normalized);
    if (parsed) {
      pushCandidate(out, {
        detected: {
          family: "times_scale_mc",
          confidence: 0.58,
          parsed_example: parsed,
          block_fallback: false,
          intent: intentFromFamily("times_scale_mc")
        },
        source_stage: "heuristic",
        inference_level: "soft",
        score: 0.58
      });
    }
  }

  const repeatParsed = parseRepeatMultiplyWordProblem(normalized);
  if (repeatParsed) {
    pushCandidate(out, {
      detected: {
        family: "times_scale_mc",
        confidence: 0.56,
        parsed_example: repeatParsed,
        block_fallback: false,
        intent: "repeat_multiply_word_problem"
      },
      source_stage: "heuristic",
      inference_level: "soft",
      score: 0.56
    });
  }

  return out;
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

    const parsed = JSON.parse(text) as {
      family?: string;
      confidence?: number;
      params?: Record<string, number>;
      detector_text?: string;
      expression?: string;
      text?: string;
    };
    const extractedText =
      typeof parsed.detector_text === "string"
        ? parsed.detector_text
        : typeof parsed.expression === "string"
        ? parsed.expression
        : typeof parsed.text === "string"
        ? parsed.text
        : "";
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
        detector_text: extractedText || text,
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
        detector_text: extractedText || text,
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
      retriable: true,
      detector_text: extractedText || ""
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

function jitterMs(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

  if (family === "a_plus_b_minus_c_eq_blank") {
    const a = randInt(rng, range.min, range.max);
    const b = randInt(rng, range.min, range.max);
    const c = randInt(rng, 0, a + b);
    return buildProblemBase(family, { a, b, c }, `${a} + ${b} - ${c} = □`, a + b - c);
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
    case "a_plus_b_minus_c_eq_blank":
      return Number(p.a) + Number(p.b) - Number(p.c);
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

  if (problem.family === "a_plus_b_minus_c_eq_blank") {
    const p = problem.params;
    const needed = ["a", "b", "c"] as const;
    if (!needed.every((k) => Number.isInteger(Number(p[k])))) return "missing_add_sub_params";
    if (Number(p.c) > Number(p.a) + Number(p.b)) return "negative_answer";
  }

  const modeReason = validateModeItems(problem);
  if (modeReason) return modeReason;

  if (solve(problem) !== problem.answer) return "solver_mismatch";
  if (problem.answer < 0) return "negative_answer";
  if (!isInRangeForDifficulty(problem, difficulty)) return "difficulty_out_of_range";

  return null;
}

function frameFromProblem(problem: MicroProblemDsl, confidence: number): SemanticFrameV1 | null {
  const p = problem.params;
  if (problem.family === "a_plus_blank_eq_b") {
    return {
      spec_version: "semantic_frame_v1",
      givens: [{ name: "a", value: Number(p.a) }, { name: "b", value: Number(p.b) }],
      relations: [{ type: "add", args: ["a", "x", "b"] }],
      ask: { target: "x" },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  if (problem.family === "blank_plus_a_eq_b") {
    return {
      spec_version: "semantic_frame_v1",
      givens: [{ name: "a", value: Number(p.a) }, { name: "b", value: Number(p.b) }],
      relations: [{ type: "add", args: ["x", "a", "b"] }],
      ask: { target: "x" },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  if (problem.family === "a_plus_b_eq_blank") {
    return {
      spec_version: "semantic_frame_v1",
      givens: [{ name: "a", value: Number(p.a) }, { name: "b", value: Number(p.b) }],
      relations: [{ type: "add", args: ["a", "b", "x"] }],
      ask: { target: "x" },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  if (problem.family === "b_minus_a_eq_blank") {
    return {
      spec_version: "semantic_frame_v1",
      givens: [{ name: "a", value: Number(p.a) }, { name: "b", value: Number(p.b) }],
      relations: [{ type: "subtract", args: ["b", "a", "x"] }],
      ask: { target: "x" },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  if (problem.family === "a_plus_b_minus_c_eq_blank") {
    return {
      spec_version: "semantic_frame_v1",
      givens: [{ name: "a", value: Number(p.a) }, { name: "b", value: Number(p.b) }, { name: "c", value: Number(p.c) }],
      relations: [{ type: "add", args: ["a", "b", "t"] }, { type: "subtract", args: ["t", "c", "x"] }],
      ask: { target: "x" },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  if (problem.family === "times_scale_mc") {
    const unit = typeof p.unit === "string" ? p.unit : undefined;
    return {
      spec_version: "semantic_frame_v1",
      givens: [{ name: "base", value: Number(p.base), unit }, { name: "multiplier", value: Number(p.multiplier) }],
      relations: [{ type: "scale_times", args: ["base", "multiplier", "x"] }],
      ask: { target: "x", unit },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  if (problem.family === "compare_totals_diff_mc") {
    const unit = typeof p.unit === "string" ? p.unit : undefined;
    return {
      spec_version: "semantic_frame_v1",
      givens: [
        { name: "a", value: Number(p.a), unit },
        { name: "b", value: Number(p.b), unit },
        { name: "c", value: Number(p.c), unit },
        { name: "d", value: Number(p.d), unit }
      ],
      relations: [
        { type: "add", args: ["a", "c", "left_total"] },
        { type: "add", args: ["b", "d", "right_total"] },
        { type: "compare_diff", args: ["left_total", "right_total", "x"] }
      ],
      ask: { target: "x", unit },
      constraints: { grade_band: "g1_g3" },
      confidence
    };
  }
  return null;
}

function equationCandidatesFromFrame(frame: SemanticFrameV1 | null): string[] {
  if (!frame) return [];
  const g = Object.fromEntries(frame.givens.map((x) => [x.name, x.value]));
  const rel = frame.relations[0];
  if (!rel) return [];
  if (rel.type === "add" && rel.args.join(",") === "a,x,b") return [`${g.a} + □ = ${g.b}`];
  if (rel.type === "add" && rel.args.join(",") === "x,a,b") return [`□ + ${g.a} = ${g.b}`];
  if (rel.type === "add" && rel.args.join(",") === "a,b,x") return [`${g.a} + ${g.b} = □`];
  if (rel.type === "subtract" && rel.args.join(",") === "b,a,x") return [`${g.b} - ${g.a} = □`];
  if (frame.relations.length === 2 && frame.relations[0].type === "add" && frame.relations[1].type === "subtract") {
    return [`${g.a} + ${g.b} - ${g.c} = □`];
  }
  if (rel.type === "scale_times") return [`x = ${g.base} × ${g.multiplier}`];
  return [];
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
  let parseStageSelected: ParseStage = "unknown";
  let equationRegexHit = false;
  let equationNormalizedText = "";
  let equationCompactText = "";
  let equationCandidateSource: EquationCandidateSource = "none";
  let equationCandidateLength = 0;
  let equationCandidateBefore = "";
  let equationCandidateAfter = "";
  let correctionStageSelected: CorrectionStage = "none";
  let correctionConfidence: number | null = null;
  let blankMissingDetected = false;
  let blankMissingRewritten = false;
  let blankConfusionDetected = false;
  let blankConfusionOriginal: string | null = null;
  let blankConfusionRewritten: string | null = null;
  let normalizeInputEmpty = false;
  let upstreamUnknownReason: string | null = null;
  let normalizedInputPreview = "";
  let binaryCandidateRejected = false;
  let binaryRejectReason: string | null = null;
  let detectorParsedText = "";
  let rawOcrText = "";
  let ocrLines: string[] = [];
  let ocrPrimaryEngine: OcrPrimaryEngine = "none";
  let localRegexHit = false;
  let decodeDebug: DecodeFallbackDebug = {
    ocr_line_count: 0,
    keyword_hits: 0,
    parse_candidates_count: 0
  };
  let inputForm: InputForm = "unknown_like";
  let inputFormScore = { equation_like: 0, word_problem_like: 0 };
  const failReasonsByStage: Record<CandidateSourceStage, string[]> = {
    deterministic: [],
    heuristic: [],
    ai_assist: []
  };

  const imageBase64 = parsedReq.data.image_base64 ?? "";
  const imageBytes = imageBytesLength(imageBase64);
  const imageMime = hasImageBase64 ? mimeFromInput(imageBase64) : "text/plain";
  const inputMode: "text" | "image" | "none" = parsedReq.data.text ? "text" : hasImageBase64 ? "image" : "none";

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
    ocrPrimaryEngine = "vision";
    rawOcrText = parsedReq.data.text;
    ocrLines = splitOcrLines(parsedReq.data.text);
    const det = detectFamily(parsedReq.data.text);
    detected = det.detected;
    compareSignals = det.compare;
    timesSignals = det.times;
  } else {
    const primaryOcr = await extractPrimaryOcrFromImage(imageBase64);
    ocrPrimaryEngine = primaryOcr.engine;
    ocrLines = primaryOcr.lines;
    rawOcrText = primaryOcr.raw;
    decodeDebug = buildDecodeFallbackDebug(primaryOcr.raw);

    const localCandidate = buildEquationCandidateText({
      ocr_lines: ocrLines,
      raw_ocr: rawOcrText
    });
    if (localCandidate.text) {
      const localParsed = equationFallbackParser(localCandidate.text);
      if (localParsed) {
        localRegexHit = true;
        equationRegexHit = true;
        equationCandidateSource = localCandidate.source;
        equationCandidateLength = localCandidate.text.length;
        equationNormalizedText = localParsed.normalized_text;
        equationCompactText = localParsed.compact_text;
        parseStageSelected = "local_ocr_regex";
        detected = {
          family: localParsed.parsed.family,
          confidence: 0.95,
          parsed_example: localParsed.parsed,
          block_fallback: false,
          intent: intentFromFamily(localParsed.parsed.family)
        };
        const det = detectFamily(localParsed.normalized_text);
        compareSignals = det.compare;
        timesSignals = det.times;
      } else {
        selectedDetectorPath = "image_gemini_detector";
        const started = Date.now();
        const firstAttempt = await detectFamilyFromImage(imageBase64);
        let vision = firstAttempt;
        modelHttpStatus = firstAttempt.status;
        if (
          !firstAttempt.ok &&
          firstAttempt.retriable &&
          (firstAttempt.error_reason === "model_timeout" ||
            firstAttempt.error_reason === "model_429" ||
            firstAttempt.error_reason === "model_5xx" ||
            firstAttempt.error_reason === "empty_parse")
        ) {
          fallbackCount += 1;
          await sleep(jitterMs(250, 600));
          const secondAttempt = await detectFamilyFromImage(imageBase64);
          vision = secondAttempt;
          modelHttpStatus = secondAttempt.status ?? modelHttpStatus;
        }
        inferenceLatencyMs = Date.now() - started;
        detectorParsedText = vision.detector_text ?? "";
        if (vision.ok && vision.detected && vision.compare && vision.times) {
          parseStageSelected = "ai_refine";
          detected = vision.detected;
          compareSignals = vision.compare;
          timesSignals = vision.times;
        } else {
          detectorFallbackReason = vision.error_reason ?? "decode_text_fallback_failed";
          selectedDetectorPath = "image_base64_decode_text_detector";
          const det = detectFamily("");
          compareSignals = det.compare;
          timesSignals = det.times;
          detected = {
            family: "unknown",
            confidence: 0.35,
            parsed_example: null,
            block_fallback: true,
            intent: "unknown_intent"
          };
        }
      }
    } else {
      selectedDetectorPath = "image_gemini_detector";
      const started = Date.now();
      const firstAttempt = await detectFamilyFromImage(imageBase64);
      let vision = firstAttempt;
      modelHttpStatus = firstAttempt.status;
      if (
        !firstAttempt.ok &&
        firstAttempt.retriable &&
        (firstAttempt.error_reason === "model_timeout" ||
          firstAttempt.error_reason === "model_429" ||
          firstAttempt.error_reason === "model_5xx" ||
          firstAttempt.error_reason === "empty_parse")
      ) {
        fallbackCount += 1;
        await sleep(jitterMs(250, 600));
        const secondAttempt = await detectFamilyFromImage(imageBase64);
        vision = secondAttempt;
        modelHttpStatus = secondAttempt.status ?? modelHttpStatus;
      }
      inferenceLatencyMs = Date.now() - started;
      detectorParsedText = vision.detector_text ?? "";
      if (vision.ok && vision.detected && vision.compare && vision.times) {
        parseStageSelected = "ai_refine";
        detected = vision.detected;
        compareSignals = vision.compare;
        timesSignals = vision.times;
      } else {
        detectorFallbackReason = vision.error_reason ?? "decode_text_fallback_failed";
        selectedDetectorPath = "image_base64_decode_text_detector";
        const det = detectFamily("");
        compareSignals = det.compare;
        timesSignals = det.times;
        detected = {
          family: "unknown",
          confidence: 0.35,
          parsed_example: null,
          block_fallback: true,
          intent: "unknown_intent"
        };
      }
    }
  }

  const eqCandidate = buildEquationCandidateText({
    detector_text: detectorParsedText,
    ocr_lines: ocrLines,
    raw_ocr: rawOcrText
  });
  normalizedInputPreview = normalizeText(eqCandidate.text || parsedReq.data.text || rawOcrText).slice(0, 120);
  const form = classifyInputForm(normalizedInputPreview);
  inputForm = form.input_form;
  inputFormScore = form.input_form_score;
  equationCandidateSource = eqCandidate.source;
  equationCandidateLength = eqCandidate.text.length;
  normalizeInputEmpty = eqCandidate.normalize_input_empty;
  if (eqCandidate.text) {
    const binaryCheck = isLikelyBinaryText(eqCandidate.text);
    if (binaryCheck.binary) {
      binaryCandidateRejected = true;
      binaryRejectReason = binaryCheck.reason;
      upstreamUnknownReason = "binary_candidate_rejected";
    }
  }

  if (eqCandidate.text && !binaryCandidateRejected) {
    const preview = normalizeEquationText(eqCandidate.text);
    equationNormalizedText = preview.normalized.slice(0, 100);
    equationCompactText = preview.compact.slice(0, 100);
  }

  const deterministicCorrection = deterministicBlankCorrection(eqCandidate.text);
  equationCandidateBefore = deterministicCorrection.before || eqCandidate.text;
  equationCandidateAfter = deterministicCorrection.after || eqCandidate.text;
  blankMissingDetected = deterministicCorrection.blank_missing_detected;
  blankMissingRewritten = deterministicCorrection.blank_missing_rewritten;
  blankConfusionDetected = deterministicCorrection.blank_confusion_detected;
  blankConfusionOriginal = deterministicCorrection.blank_confusion_original;
  blankConfusionRewritten = deterministicCorrection.blank_confusion_rewritten;
  if (deterministicCorrection.reason) {
    correctionStageSelected = "deterministic";
  }

  const deterministicParsed =
    equationCandidateAfter && !binaryCandidateRejected ? equationFallbackParser(equationCandidateAfter) : null;
  if (
    !deterministicParsed &&
    equationCandidateAfter &&
    !binaryCandidateRejected &&
    deterministicCorrection.ambiguous &&
    shouldAttemptAiEquationCorrection(equationCandidateAfter)
  ) {
    const choicesText = splitChoiceText(eqCandidate.text).choicesText;
    const aiProposal = await proposeEquationCorrectionWithAi(equationNormalizedText || eqCandidate.text, equationCandidateAfter, choicesText);
    if (aiProposal?.normalized_expression) {
      const aiParsed = equationFallbackParser(aiProposal.normalized_expression);
      if (aiParsed) {
        equationCandidateAfter = aiProposal.normalized_expression;
        correctionStageSelected = "ai_assist";
        correctionConfidence = aiProposal.confidence;
      }
    }
  }

  // Required pass before unknown: equation regex fallback over OCR-like candidates.
  const fallback =
    !localRegexHit && equationCandidateAfter && !binaryCandidateRejected ? equationFallbackParser(equationCandidateAfter) : null;
  if (fallback) {
    localRegexHit = true;
    equationRegexHit = true;
    equationNormalizedText = fallback.normalized_text;
    equationCompactText = fallback.compact_text;
    parseStageSelected = "local_ocr_regex";
    detected = {
      family: fallback.parsed.family,
      confidence: 0.92,
      parsed_example: fallback.parsed,
      block_fallback: false,
      intent: intentFromFamily(fallback.parsed.family)
    };
    const det = detectFamily(fallback.normalized_text);
    compareSignals = det.compare;
    timesSignals = det.times;
    if (blankConfusionDetected && !upstreamUnknownReason) {
      upstreamUnknownReason = "equation_corrected_from_ocr_confusion";
    }
  } else if (detected.family === "unknown") {
    if (binaryCandidateRejected) upstreamUnknownReason = "binary_candidate_rejected";
    else if (normalizeInputEmpty && hasImageBase64) upstreamUnknownReason = "ocr_empty_after_fallback";
    else if (blankMissingDetected && !blankMissingRewritten) upstreamUnknownReason = "missing_blank_unrecoverable";
    else if (detectorFallbackReason === "model_429" || detectorFallbackReason === "model_timeout" || detectorFallbackReason === "model_5xx" || detectorFallbackReason === "model_http_error") upstreamUnknownReason = detectorFallbackReason;
    else if (normalizeInputEmpty) upstreamUnknownReason = "ocr_empty";
    else if (detectorFallbackReason === "empty_parse") upstreamUnknownReason = "empty_parse_upstream";
    else if (detectorFallbackReason) upstreamUnknownReason = detectorFallbackReason;
    else upstreamUnknownReason = "equation_regex_miss";
    parseStageSelected = "unknown";
  }

  const detectedFamilyBeforeFallback = detected.family;
  const unknownNote = upstreamUnknownReason ?? "unknown_no_viable_candidate";

  const candidatePool: Candidate[] = [];
  const detectedSourceStage: CandidateSourceStage =
    parseStageSelected === "ai_refine" || correctionStageSelected === "ai_assist" ? "ai_assist" : "deterministic";
  const detectedInferenceLevel: Exclude<InferenceLevel, "unknown"> =
    detectedSourceStage === "deterministic" &&
    !blankMissingRewritten &&
    !blankConfusionDetected &&
    detected.confidence >= DETECT_CONFIDENCE_THRESHOLD
      ? "strict"
      : "soft";

  if (detected.family !== "unknown") {
    if (detected.confidence >= 0.45) {
      pushCandidate(candidatePool, {
        detected,
        source_stage: detectedSourceStage,
        inference_level: detectedInferenceLevel,
        score: detected.confidence
      });
    } else {
      failReasonsByStage[detectedSourceStage].push("confidence_below_min");
    }
  } else {
    failReasonsByStage.deterministic.push(unknownNote);
  }

  const heuristicInput = parsedReq.data.text ?? rawOcrText ?? eqCandidate.text;
  const heuristicCandidates = buildHeuristicSalvageCandidates(heuristicInput);
  if (heuristicCandidates.length === 0) {
    failReasonsByStage.heuristic.push("no_salvage_candidate");
  } else {
    for (const c of heuristicCandidates) pushCandidate(candidatePool, c);
  }

  candidatePool.sort((a, b) => b.score - a.score);
  const detectedFamilyAfterFallback = candidatePool[0]?.detected.family ?? null;

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

  const seedAsString = String(parsedReq.data.seed);
  let selectedCandidate: Candidate | null = null;
  let selectedCandidateScore = -1;
  let selectedTheme: Theme | null = null;
  let selectedPolicy = countPolicy("unknown", parsedReq.data.N);
  const problems: MicroProblemDsl[] = [];
  const reasons: Record<string, number> = {};
  let rejectedCount = 0;
  for (const candidate of candidatePool) {
    const generationFamily = candidate.detected.family === "unknown" ? null : candidate.detected.family;
    if (!generationFamily) continue;

    const modeCandidate = modeFromFamily(generationFamily);
    const formMatch =
      inputForm === "unknown_like"
        ? 0.7
        : inputForm === "equation_like"
        ? modeCandidate === "equation"
          ? 1
          : 0
        : modeCandidate === "word_problem"
        ? 1
        : 0;
    if (formMatch === 0) {
      failReasonsByStage[candidate.source_stage].push("input_form_mismatch");
      continue;
    }

    const policy = countPolicy(generationFamily, parsedReq.data.N);
    const rngSeed = hashToSeed(
      JSON.stringify({
        input: parsedReq.data.text ? normalizeText(parsedReq.data.text) : parsedReq.data.image_base64 ?? "",
        N: policy.appliedCount,
        difficulty: parsedReq.data.difficulty,
        seed: seedAsString,
        family: generationFamily
      })
    );
    const rng = mulberry32(rngSeed);
    const theme = isWordProblemFamily(generationFamily) ? pickTheme(seedAsString, generationFamily) : null;
    const candidateProblems: MicroProblemDsl[] = [];
    const candidateSeen = new Set<string>();
    const candidateReasons: Record<string, number> = {};
    let candidateRejected = 0;

    for (let i = 0; i < MAX_REGEN_TRIES && candidateProblems.length < policy.appliedCount; i += 1) {
      const problem = buildProblem(generationFamily, rng, parsedReq.data.difficulty, candidate.detected.parsed_example, theme);
      const duplicateKey = JSON.stringify({ render_text: problem.render_text, params: problem.params });

      if (candidateSeen.has(duplicateKey)) {
        candidateRejected += 1;
        bumpReason(candidateReasons, "duplicate");
        continue;
      }

      const reason = validateProblem(problem, parsedReq.data.difficulty);
      if (reason) {
        candidateRejected += 1;
        bumpReason(candidateReasons, reason);
        continue;
      }

      const lexiconReason = validateThemeLexicon(problem, theme);
      if (lexiconReason) {
        candidateRejected += 1;
        bumpReason(candidateReasons, lexiconReason);
        continue;
      }

      candidateSeen.add(duplicateKey);
      candidateProblems.push(problem);
    }

    if (candidateProblems.length > 0) {
      const score = 0.4 * candidate.detected.confidence + 0.3 * formMatch + 0.3 * 1;
      const priority = candidate.source_stage === "deterministic" ? 3 : candidate.source_stage === "heuristic" ? 2 : 1;
      const currentPriority =
        selectedCandidate?.source_stage === "deterministic"
          ? 3
          : selectedCandidate?.source_stage === "heuristic"
          ? 2
          : 1;
      if (!selectedCandidate || score > selectedCandidateScore || (score === selectedCandidateScore && priority > currentPriority)) {
        selectedCandidate = candidate;
        selectedCandidateScore = score;
        selectedTheme = theme;
        selectedPolicy = policy;
        problems.length = 0;
        problems.push(...candidateProblems);
        rejectedCount = candidateRejected;
        for (const key of Object.keys(reasons)) delete reasons[key];
        Object.assign(reasons, candidateReasons);
      }
      continue;
    }

    rejectedCount += candidateRejected;
    for (const [k, v] of Object.entries(candidateReasons)) {
      reasons[k] = (reasons[k] ?? 0) + v;
    }
    failReasonsByStage[candidate.source_stage].push("all_candidates_rejected");
  }

  if (!selectedCandidate) bumpReason(reasons, "unknown_no_viable_candidate");

  const inferenceLevel: InferenceLevel = selectedCandidate ? selectedCandidate.inference_level : "unknown";
  const needConfirm = !selectedCandidate || selectedCandidate.detected.confidence < DETECT_CONFIDENCE_THRESHOLD;
  const intentCandidates: IntentCandidate[] = candidatePool
    .sort((a, b) => b.score - a.score)
    .map((c) => ({
      intent: c.detected.intent,
      detected_mode: modeFromFamily(c.detected.family),
      confidence: c.detected.confidence,
      source_stage: c.source_stage
    }))
    .filter((c, i, arr) => arr.findIndex((x) => x.intent === c.intent && x.detected_mode === c.detected_mode) === i)
    .slice(0, 3);
  const frameCandidates = candidatePool
    .map((c) => (c.detected.parsed_example ? frameFromProblem(c.detected.parsed_example, c.detected.confidence) : null))
    .filter((x): x is SemanticFrameV1 => x !== null);
  const selectedFrame =
    selectedCandidate && selectedCandidate.detected.parsed_example
      ? frameFromProblem(selectedCandidate.detected.parsed_example, selectedCandidate.detected.confidence)
      : null;
  const equationCandidates = equationCandidatesFromFrame(selectedFrame);

  const mode = selectedCandidate ? modeFromFamily(selectedCandidate.detected.family) : "unknown";
  const requiredItems = requiredItemsFromMode(mode);
  const topItems = problems.length > 0 ? problems[0].items : [];

  let response = {
    spec_version: "micro_problem_render_v1" as const,
    request_id: requestId,
    schema_version: "micro_generate_response_v1" as const,
    inference_level: inferenceLevel,
    input_form: inputForm,
    intent_candidates: intentCandidates,
    semantic_frame: selectedFrame,
    frame_candidates_count: frameCandidates.length,
    equation_candidates_count: equationCandidates.length,
    candidate_count: selectedCandidate ? candidatePool.length : 0,
    selected_candidate_source: (selectedCandidate?.source_stage ?? "deterministic") as CandidateSourceStage,
    detected_mode: mode,
    intent: selectedCandidate?.detected.intent ?? "unknown_intent",
    confidence: selectedCandidate?.detected.confidence ?? 0.35,
    required_items: requiredItems,
    items: topItems,
    detected: selectedCandidate
      ? {
          family: selectedCandidate.detected.family,
          confidence: selectedCandidate.detected.confidence,
          parsed_example: selectedCandidate.detected.parsed_example
        }
      : {
          family: "unknown" as const,
          confidence: 0.35,
          parsed_example: null
        },
    problems,
    rejected_count: rejectedCount,
    reasons,
    need_confirm: needConfirm,
    ...(needConfirm ? { confirm_choices: [...problemFamilySchema.options] } : {}),
    debug: {
      deploy_commit: DEPLOY_COMMIT,
      build_timestamp: BUILD_TIMESTAMP,
      input_mode: inputMode,
      selected_detector_path: selectedDetectorPath,
      detector_fallback_reason: detectorFallbackReason,
      image_bytes_length: imageBytes,
      mime_type: imageMime,
      model_name: GEMINI_MODEL,
      model_http_status: modelHttpStatus,
      ocr_line_count: decodeDebug.ocr_line_count,
      ocr_primary_engine: ocrPrimaryEngine,
      ocr_primary_line_count: ocrLines.length,
      keyword_hits: decodeDebug.keyword_hits,
      parse_candidates_count: decodeDebug.parse_candidates_count,
      prompt_verb: selectedTheme?.verb_exist ?? null,
      prompt_unit: selectedTheme?.unit ?? null,
      lexicon_version: LEXICON_VERSION,
      input_form: inputForm,
      input_form_score: inputFormScore,
      parse_stage_selected: parseStageSelected,
      local_regex_hit: localRegexHit,
      equation_regex_hit: equationRegexHit,
      equation_normalized_text: equationNormalizedText,
      equation_compact_text: equationCompactText,
      equation_candidate_source: equationCandidateSource,
      equation_candidate_length: equationCandidateLength,
      correction_stage_selected: correctionStageSelected,
      equation_candidate_before: equationCandidateBefore.slice(0, 100),
      equation_candidate_after: equationCandidateAfter.slice(0, 100),
      blank_missing_detected: blankMissingDetected,
      blank_missing_rewritten: blankMissingRewritten,
      blank_confusion_detected: blankConfusionDetected,
      blank_confusion_original: blankConfusionOriginal,
      blank_confusion_rewritten: blankConfusionRewritten,
      correction_confidence: correctionConfidence,
      binary_candidate_rejected: binaryCandidateRejected,
      binary_reject_reason: binaryRejectReason,
      normalize_input_empty: normalizeInputEmpty,
      unknown_reason: selectedCandidate ? null : unknownNote,
      candidate_count: selectedCandidate ? candidatePool.length : 0,
      fail_reasons_by_stage: failReasonsByStage,
      normalized_text: normalizedInputPreview
    },
    meta: {
      family: String(selectedCandidate?.detected.family ?? "unknown"),
      count_policy: "server_enforced",
      max_count: selectedPolicy.maxCount,
      applied_count: problems.length,
      note: !selectedCandidate
        ? "unknown_no_viable_candidate"
        : selectedCandidate.inference_level === "soft"
        ? mode === "equation"
          ? blankMissingRewritten
            ? "equation_corrected_missing_blank"
            : blankConfusionDetected
            ? "equation_corrected_from_ocr_confusion"
            : "inferred_soft_equation"
          : "inferred_soft_word_problem"
        : selectedPolicy.note,
      seed: seedAsString,
      sha: sha(JSON.stringify(problems.map((p) => ({ f: p.family, t: p.render_text })))),
      request_hash: sha(parsedReq.data.text ? normalizeText(parsedReq.data.text) : imageBase64),
      detector_version: DETECTOR_VERSION,
      fallback_count: fallbackCount,
      inference_latency_ms: inferenceLatencyMs,
      ...(selectedTheme && selectedCandidate
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
      inference_level: "unknown",
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

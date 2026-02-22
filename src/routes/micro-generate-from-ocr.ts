import { randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { checkKanjiGuard, estimateGradeBand, normalizeRequestedGradeBand, type GradeBandApplied } from "../guards/kanji-guard.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = 15000;
const MAX_GENERATION_RETRIES = 2;
const DEFAULT_COUNT = 5;
const REQUEST_TIME_BUDGET_MS = 45_000;
const FILL_RETRY_MAX = 1;
const FILL_EXTRA_BUDGET_MS = 8_000;

type RenderItem = { type: "prompt"; slot: "stem"; text: string };

type GeneratedProblem = {
  prompt: string;
  required_items: ["prompt"];
  items: RenderItem[];
};

type InputMode = "equation" | "word_problem";
type EquationTrack = "arithmetic" | "unit_conversion_pure" | "unit_conversion_calc";
type WordProblemIntent = "compare_diff" | "general";
type ArithmeticOperatorHint = "multiply" | "divide" | "add_sub" | "mixed" | "unknown";
type EquationTrackDecision = "explicit_pure" | "explicit_calc" | "heuristic_pure" | "default_arithmetic";
type EquationTrackAnalysis = {
  track: EquationTrack;
  decision: EquationTrackDecision;
  ambiguous: boolean;
  reason: string | null;
};

const requestSchema = z
  .object({
    ocr_text: z.string().trim().min(1).optional(),
    image_base64: z.string().trim().min(1).optional(),
    image_mime_type: z.string().trim().min(1).default("image/jpeg"),
    count: z.union([z.literal(4), z.literal(5), z.literal(10)]).default(DEFAULT_COUNT),
    grade_band: z.enum(["g1", "g2_g3", "g1_g3"]).optional(),
    language: z.string().default("ja"),
    seed: z.union([z.string().min(1), z.number().int()])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.ocr_text && !value.image_base64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ocr_text_or_image_base64_required",
        path: ["ocr_text"]
      });
    }
  });

const llmGenSchema = z
  .object({
    problems: z
      .array(
        z
          .object({
            prompt: z.string().min(1)
          })
          .passthrough()
      )
      .min(1)
  })
  .strict();

type GenerationDraft = {
  prompt: string;
};

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncateForLog(s: string, max = 120): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function hashInt(input: string): number {
  const hex = sha(input).slice(0, 8);
  return Number.parseInt(hex, 16);
}

function extractFirstNumber(s: string): number | null {
  const normalized = s.normalize("NFKC").replace(/,/g, "");
  const m = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

type CanonicalUnit = "mm" | "cm" | "m" | "km" | "mL" | "dL" | "L" | "g" | "kg";

const unitAlias: Record<string, CanonicalUnit> = {
  mm: "mm",
  ミリメートル: "mm",
  cm: "cm",
  センチメートル: "cm",
  m: "m",
  メートル: "m",
  km: "km",
  キロメートル: "km",
  ml: "mL",
  mL: "mL",
  ミリリットル: "mL",
  dl: "dL",
  dL: "dL",
  デシリットル: "dL",
  l: "L",
  L: "L",
  リットル: "L",
  g: "g",
  グラム: "g",
  kg: "kg",
  キログラム: "kg"
};

const UNIT_TOKEN_PATTERN =
  "(mL|dL|mm|cm|km|kg|L|m|g|ミリリットル|デシリットル|リットル|ミリメートル|センチメートル|キロメートル|メートル|キログラム|グラム)";

const conversionRatio: Partial<Record<`${CanonicalUnit}->${CanonicalUnit}`, number>> = {
  "mm->cm": 0.1,
  "cm->mm": 10,
  "cm->m": 0.01,
  "m->cm": 100,
  "m->km": 0.001,
  "km->m": 1000,
  "mL->dL": 0.1,
  "dL->mL": 10,
  "dL->L": 0.1,
  "L->dL": 10,
  "g->kg": 0.001,
  "kg->g": 1000
};

type UnitConversionParsed = {
  value: number;
  fromUnit: CanonicalUnit;
  toUnit: CanonicalUnit;
};

type CompositeUnitConversionParsed = {
  firstValue: number;
  firstUnit: CanonicalUnit;
  secondValue: number;
  secondUnit: CanonicalUnit;
  toUnit: CanonicalUnit;
};

type UnitDomain = "length" | "volume" | "weight";
type UnitDomainLock = {
  domain: UnitDomain;
  allowedUnits: CanonicalUnit[];
};

function normalizeUnitToken(token: string): CanonicalUnit | null {
  const normalized = token.normalize("NFKC");
  return unitAlias[normalized] ?? null;
}

function parseUnitConversion(text: string): UnitConversionParsed | null {
  const normalized = text.normalize("NFKC");
  const sep = String.raw`[\s。．、,・]*`;
  const blank = String.raw`(?:□|口|ロ|_|\?)?`;
  const m = normalized.match(
    new RegExp(
      String.raw`(\d+(?:\.\d+)?)${sep}(mm|cm|km|mL|dL|L|m|kg|g|ミリメートル|センチメートル|キロメートル|メートル|ミリリットル|デシリットル|リットル|キログラム|グラム)${sep}=${sep}${blank}${sep}(mm|cm|km|mL|dL|L|m|kg|g|ミリメートル|センチメートル|キロメートル|メートル|ミリリットル|デシリットル|リットル|キログラム|グラム)`,
      "i"
    )
  );
  if (!m) return null;
  const value = Number(m[1]);
  const fromUnit = normalizeUnitToken(m[2]);
  const toUnit = normalizeUnitToken(m[3]);
  if (!Number.isFinite(value) || fromUnit === null || toUnit === null) return null;
  return { value, fromUnit, toUnit };
}

function parseUnitConversionLoose(text: string): UnitConversionParsed | null {
  const normalized = text.normalize("NFKC");
  const unitPattern = UNIT_TOKEN_PATTERN;

  const direct = normalized.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${unitPattern}\s*(?:を|から)?\s*${unitPattern}\s*(?:に|へ)?`, "i"));
  if (direct) {
    const value = Number(direct[1]);
    const fromUnit = normalizeUnitToken(direct[2]);
    const toUnit = normalizeUnitToken(direct[3]);
    if (Number.isFinite(value) && fromUnit !== null && toUnit !== null) {
      return { value, fromUnit, toUnit };
    }
  }

  const fallback = normalized.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${unitPattern}[\s\S]{0,24}${unitPattern}`, "i"));
  if (!fallback) return null;
  const value = Number(fallback[1]);
  const fromUnit = normalizeUnitToken(fallback[2]);
  const toUnit = normalizeUnitToken(fallback[3]);
  if (!Number.isFinite(value) || fromUnit === null || toUnit === null) return null;
  return { value, fromUnit, toUnit };
}

function parseCompositeUnitConversion(text: string): CompositeUnitConversionParsed | null {
  const normalized = text.normalize("NFKC");
  const sep = String.raw`[\s。．、,・]*`;
  const blank = String.raw`(?:□|口|ロ|_|\?)?`;
  const unitPattern = UNIT_TOKEN_PATTERN;
  const m = normalized.match(new RegExp(String.raw`(\d+)${sep}${unitPattern}${sep}(\d+)${sep}${unitPattern}${sep}=${sep}${blank}${sep}${unitPattern}`, "i"));
  if (!m) return null;
  const firstValue = Number(m[1]);
  const firstUnit = normalizeUnitToken(m[2]);
  const secondValue = Number(m[3]);
  const secondUnit = normalizeUnitToken(m[4]);
  const toUnit = normalizeUnitToken(m[5]);
  if (!Number.isFinite(firstValue) || !Number.isFinite(secondValue) || firstUnit === null || secondUnit === null || toUnit === null) {
    return null;
  }
  const d1 = getUnitDomain(firstUnit);
  const d2 = getUnitDomain(secondUnit);
  const d3 = getUnitDomain(toUnit);
  if (!(d1 === d2 && d2 === d3)) return null;
  return { firstValue, firstUnit, secondValue, secondUnit, toUnit };
}

function formatCanonicalUnit(unit: CanonicalUnit): string {
  return unit;
}

function toCanonicalUnitConversionPrompt(parsed: UnitConversionParsed): string {
  return `${parsed.value} ${formatCanonicalUnit(parsed.fromUnit)} = □ ${formatCanonicalUnit(parsed.toUnit)}`;
}

function convertUnitValue(parsed: UnitConversionParsed): number | null {
  const ratio = conversionRatio[`${parsed.fromUnit}->${parsed.toUnit}`];
  if (ratio === undefined) return null;
  return parsed.value * ratio;
}

function getUnitDomain(unit: CanonicalUnit): UnitDomain {
  if (unit === "mm" || unit === "cm" || unit === "m" || unit === "km") return "length";
  if (unit === "mL" || unit === "dL" || unit === "L") return "volume";
  return "weight";
}

function buildUnitDomainLock(parsed: UnitConversionParsed | null): UnitDomainLock | null {
  if (parsed === null) return null;
  const fromDomain = getUnitDomain(parsed.fromUnit);
  const toDomain = getUnitDomain(parsed.toUnit);
  if (fromDomain !== toDomain) return null;
  if (fromDomain === "length") return { domain: fromDomain, allowedUnits: ["mm", "cm", "m", "km"] };
  if (fromDomain === "volume") return { domain: fromDomain, allowedUnits: ["mL", "dL", "L"] };
  return { domain: fromDomain, allowedUnits: ["g", "kg"] };
}

function buildUnitDomainLockFromComposite(parsed: CompositeUnitConversionParsed | null): UnitDomainLock | null {
  if (parsed === null) return null;
  const domain = getUnitDomain(parsed.firstUnit);
  if (domain === "length") return { domain, allowedUnits: ["mm", "cm", "m", "km"] };
  if (domain === "volume") return { domain, allowedUnits: ["mL", "dL", "L"] };
  return { domain, allowedUnits: ["g", "kg"] };
}

function hasPureUnitConversionForm(text: string): boolean {
  return parseUnitConversion(text) !== null || parseUnitConversionLoose(text) !== null || parseCompositeUnitConversion(text) !== null;
}

function extractCanonicalUnits(text: string): CanonicalUnit[] {
  const normalized = text.normalize("NFKC");
  const pattern = new RegExp(UNIT_TOKEN_PATTERN, "gi");
  const out: CanonicalUnit[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(normalized)) !== null) {
    const unit = normalizeUnitToken(m[1]);
    if (unit !== null) out.push(unit);
  }
  return out;
}

function buildUnitDomainLockFromText(text: string): UnitDomainLock | null {
  const units = extractCanonicalUnits(text);
  if (units.length === 0) return null;
  const domains = new Set(units.map((u) => getUnitDomain(u)));
  if (domains.size !== 1) return null;
  const domain = [...domains][0];
  if (domain === "length") return { domain, allowedUnits: ["mm", "cm", "m", "km"] };
  if (domain === "volume") return { domain, allowedUnits: ["mL", "dL", "L"] };
  return { domain, allowedUnits: ["g", "kg"] };
}

function promptUsesOnlyUnitDomain(text: string, lock: UnitDomainLock): boolean {
  const units = extractCanonicalUnits(text);
  if (units.length === 0) return true;
  return units.every((u) => lock.allowedUnits.includes(u));
}

function isConversionInDomain(parsed: UnitConversionParsed, lock: UnitDomainLock): boolean {
  return (
    getUnitDomain(parsed.fromUnit) === lock.domain &&
    getUnitDomain(parsed.toUnit) === lock.domain &&
    lock.allowedUnits.includes(parsed.fromUnit) &&
    lock.allowedUnits.includes(parsed.toUnit)
  );
}

function includesMeterUnit(parsed: UnitConversionParsed): boolean {
  return parsed.fromUnit === "m" || parsed.toUnit === "m";
}

function conversionPairKey(parsed: UnitConversionParsed): string {
  return `${parsed.fromUnit}->${parsed.toUnit}`;
}

function isEquationStylePrompt(prompt: string): boolean {
  const normalized = prompt.normalize("NFKC");
  const arithmeticStyle = /[0-9]\s*[\+\-\*×÷]\s*[0-9]/.test(normalized) && /=|□|口|ロ|_/.test(normalized);
  const conversionStyle = parseUnitConversion(normalized) !== null;
  return arithmeticStyle || conversionStyle;
}

function hasUnitToken(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return new RegExp(`${UNIT_TOKEN_PATTERN}|円`, "i").test(normalized);
}

function isExplicitUnitConversionCalc(text: string): boolean {
  const normalized = text.normalize("NFKC");
  if (!normalized.includes("=")) return false;
  const [lhsRaw, rhsRaw = ""] = normalized.split("=");
  const lhs = lhsRaw ?? "";
  const rhs = rhsRaw ?? "";
  if (!/[+\-×÷]/.test(lhs)) return false;

  const lhsNumbers = lhs.match(/\d+(?:\.\d+)?/g) ?? [];
  const lhsUnitTerms = [...lhs.matchAll(new RegExp(`\\d+(?:\\.\\d+)?\\s*${UNIT_TOKEN_PATTERN}`, "gi"))];
  if (lhsNumbers.length < 2) return false;
  if (lhsNumbers.length !== lhsUnitTerms.length) return false;

  const rhsHasUnit = new RegExp(UNIT_TOKEN_PATTERN, "i").test(rhs);
  const rhsHasTarget = /□|口|ロ|_|\d/.test(rhs);
  return rhsHasUnit && rhsHasTarget;
}

function detectEquationTrack(text: string): EquationTrackAnalysis {
  const normalized = text.normalize("NFKC");
  const hasOpPattern = /[0-9]\s*[\+\-×÷]\s*[0-9]/.test(normalized);
  const hasEq = /=/.test(normalized) || /□|口|ロ|_|\[\]/.test(normalized);
  const pureConversion =
    parseUnitConversion(normalized) !== null || parseUnitConversionLoose(normalized) !== null || parseCompositeUnitConversion(normalized) !== null;
  const hasUnits = hasUnitToken(normalized);
  const unitCount = extractCanonicalUnits(normalized).length;
  const numberCount = (normalized.match(/\d+/g) ?? []).length;
  const explicitCalc = isExplicitUnitConversionCalc(normalized);

  // OCRが崩れて「2L9dL=□dL」が「2- 9α- = dL」のようになるケースを純変換側へ寄せる
  const sparsePureHint = hasEq && hasUnits && unitCount <= 1 && numberCount >= 2;

  if (pureConversion) {
    return { track: "unit_conversion_pure", decision: "explicit_pure", ambiguous: false, reason: null };
  }
  if (explicitCalc) {
    return { track: "unit_conversion_calc", decision: "explicit_calc", ambiguous: false, reason: null };
  }
  if (sparsePureHint || (hasEq && hasUnits && hasOpPattern && !explicitCalc)) {
    return {
      track: "unit_conversion_pure",
      decision: "heuristic_pure",
      ambiguous: true,
      reason: "ambiguous_unit_conversion_ocr"
    };
  }
  return { track: "arithmetic", decision: "default_arithmetic", ambiguous: false, reason: null };
}

function isPromptCompatibleWithTrack(prompt: string, track: EquationTrack): boolean {
  const normalized = prompt.normalize("NFKC");
  if (!isEquationStylePrompt(normalized)) return false;

  if (track === "unit_conversion_pure") {
    return (
      parseUnitConversion(normalized) !== null ||
      parseUnitConversionLoose(normalized) !== null ||
      parseCompositeUnitConversion(normalized) !== null
    );
  }

  if (track === "unit_conversion_calc") {
    const hasOp = /[\+\-\*×÷]/.test(normalized);
    const hasEq = /=/.test(normalized) || /□|口|ロ|_|\[\]/.test(normalized);
    return hasUnitToken(normalized) && hasOp && hasEq;
  }

  return true;
}

type SolveCategory = "simple_calc" | "reverse_blank" | "repeat_or_times" | "split_equal" | "unit_conversion" | "unknown";

function detectSolveCategory(text: string): SolveCategory {
  const normalized = text.normalize("NFKC");
  if (
    parseUnitConversion(normalized) !== null ||
    parseUnitConversionLoose(normalized) !== null ||
    (hasUnitToken(normalized) && /[\+\-\*×÷]/.test(normalized) && (normalized.includes("=") || /□|口|ロ|_|\[\]/.test(normalized)))
  ) {
    return "unit_conversion";
  }
  if (/□|口|ロ|_/.test(normalized) && /[\+\-\*×÷]/.test(normalized)) {
    return "reverse_blank";
  }
  if (/[0-9]\s*[\+\-\*×÷]\s*[0-9]/.test(normalized)) {
    return "simple_calc";
  }
  if (/(同じ数|分け|1人分|何人分|あまり|配る)/.test(normalized)) {
    return "split_equal";
  }
  if (
    /(毎日|ずつ|日間|何日|倍|ばい|何倍|何分|何本|何こ|なんこ|いくつ|全部|ぜんぶ|合計|合わせる|あわせる|どちら|多い|少ない|色|あめ玉|もらいました|もらう)/.test(
      normalized
    )
  ) {
    return "repeat_or_times";
  }
  return "unknown";
}

function isCategoryCompatible(source: SolveCategory, generated: SolveCategory): boolean {
  if (source === "unknown") return generated !== "unknown";
  if (source === "unit_conversion") return generated === "unit_conversion";
  if (source === "reverse_blank") return generated === "reverse_blank" || generated === "simple_calc";
  if (source === "simple_calc") return generated === "simple_calc" || generated === "reverse_blank";
  if (source === "repeat_or_times") return generated === "repeat_or_times";
  if (source === "split_equal") return generated === "split_equal";
  return false;
}

function detectWordProblemIntent(text: string): WordProblemIntent {
  const normalized = text.normalize("NFKC");
  const hasCompareSignal = /(どちら|より)/.test(normalized) && /(多い|少ない|差)/.test(normalized);
  const hasCombineSignal = /(合わせる|あわせる|合計)/.test(normalized);
  const numberCount = (normalized.match(/\d+/g) ?? []).length;
  if (hasCompareSignal && hasCombineSignal && numberCount >= 3) {
    return "compare_diff";
  }
  return "general";
}

function isWordProblemIntentCompatible(prompt: string, intent: WordProblemIntent): boolean {
  if (intent === "general") return true;
  const normalized = prompt.normalize("NFKC");
  const hasCompareSignal = /(どちら|より)/.test(normalized) && /(多い|少ない|差)/.test(normalized);
  const hasCombineSignal = /(合わせる|あわせる|合計)/.test(normalized);
  return hasCompareSignal && hasCombineSignal;
}

function isRelaxedWordProblem(prompt: string): boolean {
  const normalized = prompt.normalize("NFKC");
  const sentenceLike = /[。！？?]/.test(normalized);
  const numberCount = (normalized.match(/\d+/g) ?? []).length;
  const questionLike = /(いくつ|なんこ|何こ|何本|何人|残|のこり|のこって|全部|ぜんぶ)/.test(normalized);
  return sentenceLike && numberCount >= 2 && questionLike;
}

function detectArithmeticOperatorHint(text: string): ArithmeticOperatorHint {
  const normalized = text.normalize("NFKC");
  const hasMul = /[×xX＊*]/.test(normalized);
  const hasDiv = /[÷]/.test(normalized);
  const hasAddSub = /[+\-＋－]/.test(normalized);

  if (hasMul && !hasDiv && !hasAddSub) return "multiply";
  if (hasDiv && !hasMul && !hasAddSub) return "divide";
  if (hasAddSub && !hasMul && !hasDiv) return "add_sub";
  if (hasMul || hasDiv || hasAddSub) return "mixed";
  return "unknown";
}

function isPromptCompatibleWithArithmeticHint(prompt: string, hint: ArithmeticOperatorHint): boolean {
  if (hint === "unknown" || hint === "mixed") return true;
  const normalized = prompt.normalize("NFKC");
  const hasMul = /[×xX＊*]/.test(normalized);
  const hasDiv = /[÷]/.test(normalized);
  const hasAddSub = /[+\-＋－]/.test(normalized);

  if (hint === "multiply") return hasMul && !hasDiv && !hasAddSub;
  if (hint === "divide") return hasDiv && !hasMul && !hasAddSub;
  if (hint === "add_sub") return hasAddSub && !hasMul && !hasDiv;
  return true;
}

function parseJsonLoose(raw: string): unknown {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }
    const obj = t.match(/\{[\s\S]*\}/);
    if (obj?.[0]) {
      return JSON.parse(obj[0]);
    }
    throw new Error("json_parse_failed");
  }
}

function extractPromptValue(item: Record<string, unknown>): string {
  const keys = ["prompt", "question", "stem", "text", "problem"];
  for (const key of keys) {
    const v = item[key];
    if (typeof v === "string" && normalizeSpaces(v)) return normalizeSpaces(v);
  }
  return "";
}

function salvageGenerationPayload(raw: unknown): GenerationDraft[] {
  const pickArray = (obj: Record<string, unknown>): unknown[] => {
    const keys = ["problems", "items", "questions", "tasks", "outputs", "data"];
    for (const key of keys) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
    return [];
  };

  const source =
    Array.isArray(raw) ? raw : raw && typeof raw === "object" ? pickArray(raw as Record<string, unknown>) : [];
  if (!Array.isArray(source)) return [];

  const out: GenerationDraft[] = [];
  for (const row of source) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const prompt = extractPromptValue(obj);
    if (!prompt) continue;
    out.push({ prompt });
  }
  return out;
}

function repairGenerationPrompt(language: string, raw: unknown): string {
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  return [
    "ROLE: json_repair_v1",
    `Language: ${language}`,
    "Convert the following output into STRICT JSON only.",
    'Target schema: {"problems":[{"prompt":"..."}]}',
    "Rules:",
    "- Keep only usable problems.",
    "- Remove all markdown or commentary.",
    "Input:",
    rawText
  ].join("\n");
}

async function callGeminiJson(payloadText: string): Promise<{ ok: boolean; status: number | null; data?: unknown; error?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: null, error: "gemini_api_key_missing" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: payloadText }] }],
          generationConfig: { temperature: 0.6, responseMimeType: "application/json" }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      return { ok: false, status: response.status, error: `gemini_http_${response.status}` };
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { ok: false, status: response.status, error: "gemini_empty_text" };
    }

    const parsed = parseJsonLoose(text);
    return { ok: true, status: response.status, data: parsed };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: null, error: "gemini_timeout" };
    }
    return { ok: false, status: null, error: "gemini_transport_error" };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiImageOcr(input: {
  imageBase64: string;
  imageMimeType: string;
  language: string;
}): Promise<{ ok: boolean; status: number | null; text?: string; error?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: null, error: "gemini_api_key_missing" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
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
              parts: [
                {
                  text: [
                    "ROLE: image_ocr_v1",
                    `Language: ${input.language}`,
                    "Extract OCR text for a Japanese elementary math worksheet image.",
                    "Return ONLY plain text, no JSON, no markdown.",
                    "Preserve math symbols when possible: + - × ÷ = □ and units."
                  ].join("\n")
                },
                {
                  inline_data: {
                    mime_type: input.imageMimeType,
                    data: input.imageBase64
                  }
                }
              ]
            }
          ],
          generationConfig: { temperature: 0.0 }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      return { ok: false, status: response.status, error: `gemini_http_${response.status}` };
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = normalizeSpaces(json.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    if (!text) {
      return { ok: false, status: response.status, error: "gemini_empty_text" };
    }
    return { ok: true, status: response.status, text };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: null, error: "gemini_timeout" };
    }
    return { ok: false, status: null, error: "gemini_transport_error" };
  } finally {
    clearTimeout(timeout);
  }
}

function generationPrompt(input: {
  ocrText: string;
  count: number;
  gradeBand: string;
  language: string;
  seed: string;
  inputMode: InputMode;
  equationTrack: EquationTrack | null;
  arithmeticHint: ArithmeticOperatorHint;
  wordProblemIntent: WordProblemIntent;
  conversionHint: boolean;
  unitDomainLock: UnitDomainLock | null;
}): string {
  const gradeInstructions =
    input.gradeBand === "g1"
      ? [
          "小学1年生向けです。",
          "漢字はできるだけ使わず、数字以外はひらがなを基本にしてください。",
          "どうしても必要な場合のみ、小1で習うかんたんな漢字を使ってください。"
        ]
      : [
          "小学2〜3年生向けです。",
          "かんたんな漢字は使ってよいですが、むずかしい漢字はひらがなにしてください。"
        ];

  return [
    "ROLE: generator_v1",
    `Language: ${input.language}`,
    `Grade band: ${input.gradeBand}`,
    `Input mode: ${input.inputMode}`,
    ...(input.inputMode === "equation" && input.equationTrack !== null ? [`Equation track: ${input.equationTrack}`] : []),
    `Requested count: ${input.count}`,
    `Seed: ${input.seed}`,
    "Target learners: Japanese elementary school students (grades 1 to 3).",
    "Subject scope: Japanese elementary mathematics only (up to grade 3 curriculum).",
    "Use natural Japanese suitable for Japanese children and parents.",
    "Task: Read the source problem and generate similar elementary math problems.",
    "Output STRICT JSON only:",
    '{"problems":[{"prompt":"..."}]}',
    "Rules:",
    "- Keep difficulty around grade 1-3.",
    "- Do not generate answer choices.",
    "- Do not include option labels like ①②③.",
    ...(input.inputMode === "equation"
      ? [
          ...(input.equationTrack === "unit_conversion_pure"
            ? [
                "- Return ONLY pure unit-conversion equations (e.g. 40mm = □cm, 3L = □dL).",
                "- Do NOT generate story problems.",
                "- Do NOT generate arithmetic-only equations without unit conversion."
              ]
            : input.equationTrack === "unit_conversion_calc"
              ? [
                  "- Return ONLY unit-conversion arithmetic equations (e.g. 2cm + 3mm = □mm).",
                  "- Keep equations with units and operators (+, -, ×, ÷) and a blank answer.",
                  "- Do NOT convert into story/word problems."
                ]
              : [
                  "- Return equation-style problems (e.g. 7 + 9 - 6 = □).",
                  "- Do NOT convert equations into story/word problems.",
                  "- Do NOT include unit-conversion constraints unless source clearly uses units."
                ]),
          ...(input.equationTrack === "arithmetic" && input.arithmeticHint === "multiply"
            ? ["- Use multiplication equations only (×). Do NOT use + or - or ÷."]
            : []),
          ...(input.equationTrack === "arithmetic" && input.arithmeticHint === "divide"
            ? ["- Use division equations only (÷). Do NOT use + or - or ×."]
            : []),
          ...(input.equationTrack === "arithmetic" && input.arithmeticHint === "add_sub"
            ? ["- Use addition/subtraction equations only (+/-). Do NOT use × or ÷."]
            : []),
          ...(input.conversionHint
            ? [
                "- Allowed elementary conversions: mm/cm, cm/m, m/km, mL/dL, dL/L, g/kg.",
                ...(input.unitDomainLock
                  ? [
                      `- Unit domain lock: ${input.unitDomainLock.domain} only.`,
                      `- Allowed units in this request: ${input.unitDomainLock.allowedUnits.join(", ")}.`,
                      "- Do NOT generate conversion problems outside this unit domain.",
                      ...(input.unitDomainLock.domain === "length"
                        ? [
                            "- Include a mix of length units, not only mm and cm.",
                            "- Include at least one problem that uses m (meter)."
                          ]
                        : [])
                    ]
                  : [])
              ]
            : [])
        ]
      : [
          ...(input.wordProblemIntent === "compare_diff"
            ? [
                "- Return ONLY compare-difference word problems.",
                "- Keep the pattern: combine two groups, then ask which side is more and by how much.",
                "- Do NOT switch to simple total-sum-only questions."
              ]
            : ["- Return short Japanese word-problem style prompts."])
        ]),
    "- No explanations.",
    ...gradeInstructions,
    "Source OCR:",
    input.ocrText
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isRetriableGenError(error?: string): boolean {
  if (!error) return false;
  return error === "gemini_timeout" || error === "gemini_transport_error" || error === "gemini_http_429" || error === "gemini_http_500" || error === "gemini_http_503";
}

function detectInputMode(ocrText: string): InputMode {
  const normalized = ocrText.normalize("NFKC");
  const hasEquals = normalized.includes("=");
  const hasBlank = /□|＿|_|\[\]|\b空欄\b/.test(normalized);
  const hasArithmeticPattern = /[0-9]\s*[\+\-\*×÷]\s*[0-9]/.test(normalized);
  const hasUnitConversionPattern = parseUnitConversion(normalized) !== null;
  const hasNumberUnitPair = /\d+\s*(mm|cm|km|mL|dL|L|kg|g|円|ミリメートル|センチメートル|メートル|キロメートル|ミリリットル|デシリットル|リットル|グラム|キログラム)/i.test(
    normalized
  );
  const wordMarkers = /(ですか|なりますか|つぎから|えらびなさい|あげました|もらいました|もっていきました|のこり|のこっています|何こ|なんこ|何本|何人|毎日|きょう|きのう|しき|こたえ)/;
  const sentenceLike = /[。！？]/.test(normalized);
  const wordMarkerCount = (normalized.match(new RegExp(wordMarkers, "g")) ?? []).length;
  const hasEquationHardSignal = hasEquals || hasBlank || hasArithmeticPattern || hasUnitConversionPattern;

  if (hasEquationHardSignal) {
    return "equation";
  }
  if (hasNumberUnitPair && !sentenceLike) {
    return "equation";
  }
  if (sentenceLike && wordMarkerCount >= 1) {
    return "word_problem";
  }
  if (sentenceLike && wordMarkerCount >= 2) {
    return "word_problem";
  }
  return "word_problem";
}

function shouldPreferImageOcrFallback(ocrText: string): boolean {
  const normalized = ocrText.normalize("NFKC");
  if (!normalized) return true;

  const hasEq = normalized.includes("=");
  const hasAnyOp = /[+\-×÷]/.test(normalized);
  const hasCanonicalEquation = /\d+\s*[+\-×÷]\s*\d+/.test(normalized);
  const hasUnitLike = new RegExp(UNIT_TOKEN_PATTERN, "i").test(normalized);

  if (normalized.length <= 10) return true;
  if (hasEq && !hasCanonicalEquation && !hasUnitLike) return true;
  if (hasEq && hasAnyOp && !/\d/.test(normalized)) return true;
  return false;
}

function generationBatches(count: 4 | 5 | 10): number[] {
  if (count === 10) return [5, 5];
  return [count];
}

function generationDraftTarget(
  batchTarget: number,
  inputMode: InputMode,
  equationTrack: EquationTrack | null,
  batchIndex: number,
  targetCount: number
): number {
  if (inputMode === "word_problem") {
    return Math.min(10, Math.max(batchTarget + 3, batchTarget));
  }
  if (equationTrack === "unit_conversion_pure" && targetCount === 10) {
    const extra = batchIndex === 0 ? 2 : 1;
    return Math.min(10, Math.max(batchTarget + extra, batchTarget));
  }
  return batchTarget;
}

type DraftFetchResult = {
  drafts: GenerationDraft[];
  calls: number;
  status: number | null;
  errors: string[];
};

async function fetchGenerationDrafts(input: {
  ocrText: string;
  count: number;
  gradeBand: string;
  language: string;
  seed: string;
  inputMode: InputMode;
  equationTrack: EquationTrack | null;
  arithmeticHint: ArithmeticOperatorHint;
  wordProblemIntent: WordProblemIntent;
  conversionHint: boolean;
  unitDomainLock: UnitDomainLock | null;
}): Promise<DraftFetchResult> {
  let calls = 0;
  let status: number | null = null;
  const errors: string[] = [];
  let drafts: GenerationDraft[] = [];

  for (let attempt = 0; attempt < MAX_GENERATION_RETRIES && drafts.length === 0; attempt += 1) {
    calls += 1;
    const genResp = await callGeminiJson(
      generationPrompt({
        ocrText: input.ocrText,
        count: input.count,
        gradeBand: input.gradeBand,
        language: input.language,
        seed: `${input.seed}:a${attempt}`,
        inputMode: input.inputMode,
        equationTrack: input.equationTrack,
        arithmeticHint: input.arithmeticHint,
        wordProblemIntent: input.wordProblemIntent,
        conversionHint: input.conversionHint,
        unitDomainLock: input.unitDomainLock
      })
    );
    status = genResp.status;
    if (!genResp.ok || !genResp.data) {
      errors.push(genResp.error ?? "generation_failed");
      if (attempt < MAX_GENERATION_RETRIES - 1 && isRetriableGenError(genResp.error)) {
        await sleep(jitterMs(250, 600));
      }
      continue;
    }

    const parsedGen = llmGenSchema.safeParse(genResp.data);
    if (parsedGen.success) {
      drafts = parsedGen.data.problems.map((p) => ({ prompt: normalizeSpaces(p.prompt) }));
    } else {
      drafts = salvageGenerationPayload(genResp.data);
      if (drafts.length === 0) {
        const repaired = await callGeminiJson(repairGenerationPrompt(input.language, genResp.data));
        if (repaired.ok && repaired.data) {
          const repairedStrict = llmGenSchema.safeParse(repaired.data);
          if (repairedStrict.success) {
            drafts = repairedStrict.data.problems.map((p) => ({ prompt: normalizeSpaces(p.prompt) }));
          } else {
            drafts = salvageGenerationPayload(repaired.data);
          }
        }
      }
    }

    if (drafts.length === 0) {
      errors.push("generation_schema_invalid");
    }
  }

  return { drafts, calls, status, errors };
}

function applyReplaceDict(text: string, dict: ReadonlyArray<[string, string]>): { text: string; changed: number } {
  let out = text;
  let changed = 0;
  for (const [from, to] of dict) {
    const next = out.split(from).join(to);
    if (next !== out) {
      changed += 1;
      out = next;
    }
  }
  return { text: out, changed };
}

function applyGradeBandLexicon(draft: GenerationDraft, gradeBand: GradeBandApplied): { draft: GenerationDraft; replacements: number } {
  const g1Dict: Array<[string, string]> = [
    ["練習", "れんしゅう"],
    ["問題", "もんだい"],
    ["開始", "はじめ"],
    ["終了", "おわり"],
    ["合計", "ごうけい"],
    ["計算", "けいさん"],
    ["選択", "せんたく"],
    ["文字", "もじ"],
    ["時間", "じかん"],
    ["分間", "ふんかん"],
    ["毎日", "まいにち"],
    ["数量", "すうりょう"],
    ["確認", "かくにん"]
  ];
  const g23Dict: Array<[string, string]> = [
    ["難しい", "むずかしい"],
    ["開始", "はじめ"],
    ["終了", "おわり"]
  ];
  const dict = gradeBand === "g1" ? g1Dict : g23Dict;

  const promptApplied = applyReplaceDict(draft.prompt, dict);
  const replacements = promptApplied.changed;

  return {
    draft: {
      prompt: normalizeSpaces(promptApplied.text)
    },
    replacements
  };
}

function shouldStopEarly(
  targetCount: number,
  acceptedCount: number,
  inputMode: InputMode
): boolean {
  if (acceptedCount >= targetCount) return true;
  if (inputMode !== "word_problem") return false;
  return false;
}

function buildLengthMeterFallbackProblem(seedText: string): GeneratedProblem {
  const meters = (hashInt(`${seedText}:meter`) % 9) + 1; // 1..9 m
  const prompt = `${meters} m = □ cm`;

  return {
    prompt,
    required_items: ["prompt"],
    items: [{ type: "prompt", slot: "stem", text: prompt }]
  };
}

function buildLengthConversionFallbackProblem(seedText: string, kind: "cm_to_m" | "m_to_cm"): GeneratedProblem {
  if (kind === "cm_to_m") {
    const meters = (hashInt(`${seedText}:cm_to_m`) % 9) + 1;
    const cm = meters * 100;
    return {
      prompt: `${cm} cm = □ m`,
      required_items: ["prompt"],
      items: [{ type: "prompt", slot: "stem", text: `${cm} cm = □ m` }]
    };
  }

  const meters = (hashInt(`${seedText}:m_to_cm`) % 9) + 1;
  return {
    prompt: `${meters} m = □ cm`,
    required_items: ["prompt"],
    items: [{ type: "prompt", slot: "stem", text: `${meters} m = □ cm` }]
  };
}

function buildUnitConversionPureFallbackPrompts(lock: UnitDomainLock, seedText: string, count: number): string[] {
  const pairPool: Array<[CanonicalUnit, CanonicalUnit]> =
    lock.domain === "length"
      ? [
          ["mm", "cm"],
          ["cm", "mm"],
          ["cm", "m"],
          ["m", "cm"],
          ["m", "km"],
          ["km", "m"]
        ]
      : lock.domain === "volume"
        ? [
            ["mL", "dL"],
            ["dL", "mL"],
            ["dL", "L"],
            ["L", "dL"]
          ]
        : [
            ["g", "kg"],
            ["kg", "g"]
          ];

  const prompts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const [fromUnit, toUnit] = pairPool[(hashInt(`${seedText}:pair:${i}`) + i) % pairPool.length];
    const ratio = conversionRatio[`${fromUnit}->${toUnit}`];
    if (ratio === undefined) continue;
    let value = (hashInt(`${seedText}:value:${i}`) % 9) + 1;
    if (ratio < 1) {
      const inv = Math.round(1 / ratio);
      value *= inv;
    }
    prompts.push(`${value} ${fromUnit} = □ ${toUnit}`);
  }
  return prompts;
}

export const microGenerateFromOcrRouter = Router();

microGenerateFromOcrRouter.post("/", async (req, res) => {
  const requestId = randomUUID();
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      request_id: requestId,
      details: parsed.error.flatten()
    });
  }

  const { ocr_text: request_ocr_text, image_base64, image_mime_type, count, grade_band, language, seed } = parsed.data;
  const seedText = String(seed);
  const start = Date.now();
  let ocrText = normalizeSpaces(request_ocr_text ?? "");
  let ocrSource: "request_text" | "image_ocr" | "none" = ocrText ? "request_text" : "none";
  let aiOcrFallbackUsed = false;
  let aiOcrStatus: number | null = null;
  let aiOcrError: string | null = null;

  if (image_base64 && (ocrText.length === 0 || shouldPreferImageOcrFallback(ocrText))) {
    const aiOcr = await callGeminiImageOcr({
      imageBase64: image_base64,
      imageMimeType: image_mime_type,
      language
    });
    aiOcrStatus = aiOcr.status;
    if (aiOcr.ok && aiOcr.text) {
      ocrText = aiOcr.text;
      ocrSource = "image_ocr";
      aiOcrFallbackUsed = true;
    } else {
      aiOcrError = aiOcr.error ?? "ai_ocr_failed";
    }
  }

  if (!ocrText) {
    return res.status(200).json({
      spec_version: "micro_problem_render_v1",
      request_id: requestId,
      schema_version: "micro_generate_from_ocr_response_v1",
      detected_mode: "unknown",
      intent: "unknown_intent",
      confidence: 0.2,
      required_items: [],
      items: [],
      problems: [],
      requested_count: count,
      applied_count: 0,
      need_confirm: true,
      reasons: {
        ...(aiOcrError ? { [aiOcrError]: 1 } : {}),
        ...(ocrSource === "none" ? { ocr_text_missing: 1 } : {})
      },
      meta: {
        note: "unknown_no_viable_candidate",
        seed: seedText,
        grade_band_applied: normalizeRequestedGradeBand(grade_band) ?? "g1",
        count_policy: "server_enforced",
        max_count: 10,
        target_count: Math.min(count, 10),
        request_hash: "",
        inference_latency_ms: Date.now() - start
      },
      debug: {
        generator_model: GEMINI_MODEL,
        solver_model: null,
        generation_calls: 0,
        solver_calls: 0,
        generation_status: null,
        solver_status: null,
        language,
        grade_band,
        input_mode: "word_problem",
        source_category: "unknown",
        source_word_intent: "general",
        equation_track: null,
        arithmetic_hint: "unknown",
        equation_track_decision: null,
        equation_track_ambiguous: false,
        equation_track_reason: null,
        ocr_retake_recommended: true,
        generation_timeline: [],
        equation_style_miss_samples: [],
        unit_domain_lock: null,
        ocr_source: ocrSource,
        ai_ocr_fallback_used: aiOcrFallbackUsed,
        ai_ocr_status: aiOcrStatus,
        ai_ocr_error: aiOcrError,
        ai_ocr_text_length: 0,
        choices_disabled: true,
        choice_generation_via_ai: false,
        kanji_guard: {
          checked: true,
          violations_count: 0,
          rewrite_attempts: 0,
          local_replacements: 0
        }
      }
    });
  }
  const requestedGradeBand = normalizeRequestedGradeBand(grade_band);
  const inputMode = detectInputMode(ocrText);
  const equationTrackAnalysis = inputMode === "equation" ? detectEquationTrack(ocrText) : null;
  const equationTrack = equationTrackAnalysis?.track ?? null;
  const arithmeticHint =
    inputMode === "equation" && equationTrack === "arithmetic" ? detectArithmeticOperatorHint(ocrText) : "unknown";
  const sourceWordIntent = inputMode === "word_problem" ? detectWordProblemIntent(ocrText) : "general";
  const sourceCategory = detectSolveCategory(ocrText);
  const sourceConversion = parseUnitConversion(ocrText);
  const sourceCompositeConversion = parseCompositeUnitConversion(ocrText);
  const unitDomainLock =
    buildUnitDomainLock(sourceConversion ?? parseUnitConversionLoose(ocrText)) ??
    buildUnitDomainLockFromComposite(sourceCompositeConversion) ??
    buildUnitDomainLockFromText(ocrText);
  const maxCount = inputMode === "word_problem" ? 5 : 10;
  const targetCount = Math.min(count, maxCount) as 4 | 5 | 10;
  const cappedByPolicy = targetCount < count;

  const accepted: GeneratedProblem[] = [];
  const reasons: Record<string, number> = {};
  const generationTimeline: Array<{
    phase: "batch" | "fill";
    index: number;
    requested: number;
    drafts: number;
    accepted: number;
    rejected: number;
    errors: string[];
  }> = [];
  const equationStyleMissSamples: string[] = [];
  let generationCalls = 0;
  const solverCalls = 0;
  let generationStatus: number | null = null;
  const solverStatus: number | null = null;
  let violationsCount = 0;
  let localReplacements = 0;
  let gradeBandApplied: GradeBandApplied = requestedGradeBand ?? "g1";
  let gradeBandEstimated = requestedGradeBand !== null;
  let hitTimeBudget = false;
  let acceptedLengthHasMeter = false;

  const batches = generationBatches(targetCount);
  for (let batchIndex = 0; batchIndex < batches.length && accepted.length < targetCount; batchIndex += 1) {
    if (Date.now() - start >= REQUEST_TIME_BUDGET_MS) {
      reasons.time_budget_exceeded = (reasons.time_budget_exceeded ?? 0) + 1;
      hitTimeBudget = true;
      break;
    }
    const batchTarget = Math.min(batches[batchIndex], targetCount - accepted.length);
    if (batchTarget <= 0) break;
    const draftTarget = generationDraftTarget(batchTarget, inputMode, equationTrack, batchIndex, targetCount);

    const generated = await fetchGenerationDrafts({
      ocrText: ocrText,
      count: draftTarget,
      gradeBand: grade_band ?? "g1_g3",
        language,
        seed: `${seedText}:b${batchIndex}`,
        inputMode,
        equationTrack,
        arithmeticHint,
        wordProblemIntent: sourceWordIntent,
        conversionHint: equationTrack === "unit_conversion_pure" || equationTrack === "unit_conversion_calc",
        unitDomainLock
      });
    const acceptedBeforeBatch = accepted.length;
    const batchRejectCounts: Record<string, number> = {};
    generationCalls += generated.calls;
    generationStatus = generated.status;
    for (const error of generated.errors) {
      reasons[error] = (reasons[error] ?? 0) + 1;
    }
    const generationDrafts = generated.drafts;

    if (generationDrafts.length === 0) {
      continue;
    }

    if (!gradeBandEstimated) {
      gradeBandApplied = estimateGradeBand({
        ocrText: ocrText,
        drafts: generationDrafts.map((d) => ({ prompt: d.prompt, choices: [] }))
      });
      gradeBandEstimated = true;
    }

    for (const draft of generationDrafts) {
      if (Date.now() - start >= REQUEST_TIME_BUDGET_MS) {
        reasons.time_budget_exceeded = (reasons.time_budget_exceeded ?? 0) + 1;
        hitTimeBudget = true;
        break;
      }
      if (shouldStopEarly(targetCount, accepted.length, inputMode)) break;
      const normalized = applyGradeBandLexicon(draft, gradeBandApplied);
      localReplacements += normalized.replacements;
      let workingDraft = normalized.draft;
      const guard = checkKanjiGuard({ prompt: workingDraft.prompt, choices: [] }, gradeBandApplied);
      violationsCount += guard.violations_count;
      if (inputMode === "equation" && equationTrack === "unit_conversion_pure" && !hasPureUnitConversionForm(workingDraft.prompt)) {
        const looseParsed = parseUnitConversionLoose(workingDraft.prompt);
        if (looseParsed !== null) {
          workingDraft = { ...workingDraft, prompt: toCanonicalUnitConversionPrompt(looseParsed) };
          reasons.unit_conversion_loose_recovered = (reasons.unit_conversion_loose_recovered ?? 0) + 1;
        }
      }
      if (inputMode === "equation" && !isPromptCompatibleWithTrack(workingDraft.prompt, equationTrack ?? "arithmetic")) {
        reasons.equation_style_miss = (reasons.equation_style_miss ?? 0) + 1;
        batchRejectCounts.equation_style_miss = (batchRejectCounts.equation_style_miss ?? 0) + 1;
        if (equationStyleMissSamples.length < 5) {
          equationStyleMissSamples.push(truncateForLog(workingDraft.prompt));
        }
        continue;
      }
      if (inputMode === "equation" && equationTrack === "arithmetic" && !isPromptCompatibleWithArithmeticHint(workingDraft.prompt, arithmeticHint)) {
        reasons.arithmetic_operator_mismatch = (reasons.arithmetic_operator_mismatch ?? 0) + 1;
        batchRejectCounts.arithmetic_operator_mismatch = (batchRejectCounts.arithmetic_operator_mismatch ?? 0) + 1;
        continue;
      }
      const generatedCategory = detectSolveCategory(workingDraft.prompt);
      if (!isCategoryCompatible(sourceCategory, generatedCategory)) {
        const relaxedWordProblemAccept =
          inputMode === "word_problem" && sourceWordIntent === "general" && isRelaxedWordProblem(workingDraft.prompt);
        if (!relaxedWordProblemAccept) {
          reasons.classification_mismatch = (reasons.classification_mismatch ?? 0) + 1;
          batchRejectCounts.classification_mismatch = (batchRejectCounts.classification_mismatch ?? 0) + 1;
          continue;
        }
        reasons.classification_relaxed_accept = (reasons.classification_relaxed_accept ?? 0) + 1;
      }
      if (inputMode === "word_problem" && !isWordProblemIntentCompatible(workingDraft.prompt, sourceWordIntent)) {
        reasons.intent_mismatch = (reasons.intent_mismatch ?? 0) + 1;
        batchRejectCounts.intent_mismatch = (batchRejectCounts.intent_mismatch ?? 0) + 1;
        continue;
      }
      if (inputMode === "equation" && equationTrack === "unit_conversion_pure" && !hasPureUnitConversionForm(workingDraft.prompt)) {
        reasons.unit_conversion_style_miss = (reasons.unit_conversion_style_miss ?? 0) + 1;
        batchRejectCounts.unit_conversion_style_miss = (batchRejectCounts.unit_conversion_style_miss ?? 0) + 1;
        continue;
      }
      if (inputMode === "equation" && equationTrack !== "arithmetic" && unitDomainLock !== null) {
        if (!promptUsesOnlyUnitDomain(workingDraft.prompt, unitDomainLock)) {
          reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
          batchRejectCounts.unit_domain_mismatch = (batchRejectCounts.unit_domain_mismatch ?? 0) + 1;
          continue;
        }
        const parsedDraftConversion = parseUnitConversion(workingDraft.prompt);
        if (parsedDraftConversion !== null && !isConversionInDomain(parsedDraftConversion, unitDomainLock)) {
          reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
          batchRejectCounts.unit_domain_mismatch = (batchRejectCounts.unit_domain_mismatch ?? 0) + 1;
          continue;
        }
      }

      if (!workingDraft.prompt || normalizeSpaces(workingDraft.prompt).length < 3) {
        reasons.prompt_too_short = (reasons.prompt_too_short ?? 0) + 1;
        batchRejectCounts.prompt_too_short = (batchRejectCounts.prompt_too_short ?? 0) + 1;
        continue;
      }
      const parsedConversion = parseUnitConversion(workingDraft.prompt);
      if (parsedConversion !== null) {
        if (unitDomainLock !== null && !isConversionInDomain(parsedConversion, unitDomainLock)) {
          reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
          batchRejectCounts.unit_domain_mismatch = (batchRejectCounts.unit_domain_mismatch ?? 0) + 1;
          continue;
        }
        if (equationTrack === "unit_conversion_pure" && convertUnitValue(parsedConversion) === null) {
          reasons.unit_conversion_pair_unsupported = (reasons.unit_conversion_pair_unsupported ?? 0) + 1;
          batchRejectCounts.unit_conversion_pair_unsupported = (batchRejectCounts.unit_conversion_pair_unsupported ?? 0) + 1;
          continue;
        }
      }

      accepted.push({
        prompt: normalizeSpaces(workingDraft.prompt),
        required_items: ["prompt"],
        items: [{ type: "prompt", slot: "stem", text: normalizeSpaces(workingDraft.prompt) }]
      });
      if (unitDomainLock?.domain === "length") {
        const acceptedConversion = parseUnitConversion(workingDraft.prompt);
        if (acceptedConversion !== null && includesMeterUnit(acceptedConversion)) {
          acceptedLengthHasMeter = true;
        }
      }

      if (shouldStopEarly(targetCount, accepted.length, inputMode)) {
        break;
      }
    }
    generationTimeline.push({
      phase: "batch",
      index: batchIndex,
      requested: draftTarget,
      drafts: generationDrafts.length,
      accepted: accepted.length - acceptedBeforeBatch,
      rejected: Object.values(batchRejectCounts).reduce((sum, v) => sum + v, 0),
      errors: generated.errors
    });
  }

  if (!shouldStopEarly(targetCount, accepted.length, inputMode)) {
    const fillDeadline = start + REQUEST_TIME_BUDGET_MS + FILL_EXTRA_BUDGET_MS;
    for (
      let fillTry = 0;
      fillTry < FILL_RETRY_MAX && !shouldStopEarly(targetCount, accepted.length, inputMode);
      fillTry += 1
    ) {
      if (Date.now() >= fillDeadline) {
        reasons.fill_retry_timeout = (reasons.fill_retry_timeout ?? 0) + 1;
        break;
      }

      const needed = targetCount - accepted.length;
      const fillTarget = generationDraftTarget(Math.min(needed, 5), inputMode, equationTrack, fillTry + 10, targetCount);
      const generated = await fetchGenerationDrafts({
        ocrText: ocrText,
        count: fillTarget,
        gradeBand: grade_band ?? "g1_g3",
        language,
        seed: `${seedText}:fill:${fillTry}`,
        inputMode,
        equationTrack,
        arithmeticHint,
        wordProblemIntent: sourceWordIntent,
        conversionHint: equationTrack === "unit_conversion_pure" || equationTrack === "unit_conversion_calc",
        unitDomainLock
      });
      const acceptedBeforeFill = accepted.length;
      const fillRejectCounts: Record<string, number> = {};
      generationCalls += generated.calls;
      generationStatus = generated.status;
      for (const error of generated.errors) {
        reasons[error] = (reasons[error] ?? 0) + 1;
      }
      if (generated.drafts.length === 0) {
        reasons.fill_retry_empty = (reasons.fill_retry_empty ?? 0) + 1;
        continue;
      }

      for (const draft of generated.drafts) {
        if (shouldStopEarly(targetCount, accepted.length, inputMode) || Date.now() >= fillDeadline) break;
        const normalized = applyGradeBandLexicon(draft, gradeBandApplied);
        localReplacements += normalized.replacements;
        let workingDraft = normalized.draft;
        const guard = checkKanjiGuard({ prompt: workingDraft.prompt, choices: [] }, gradeBandApplied);
        violationsCount += guard.violations_count;
        if (inputMode === "equation" && equationTrack === "unit_conversion_pure" && !hasPureUnitConversionForm(workingDraft.prompt)) {
          const looseParsed = parseUnitConversionLoose(workingDraft.prompt);
          if (looseParsed !== null) {
            workingDraft = { ...workingDraft, prompt: toCanonicalUnitConversionPrompt(looseParsed) };
            reasons.unit_conversion_loose_recovered = (reasons.unit_conversion_loose_recovered ?? 0) + 1;
          }
        }
        if (inputMode === "equation" && !isPromptCompatibleWithTrack(workingDraft.prompt, equationTrack ?? "arithmetic")) {
          reasons.equation_style_miss = (reasons.equation_style_miss ?? 0) + 1;
          fillRejectCounts.equation_style_miss = (fillRejectCounts.equation_style_miss ?? 0) + 1;
          if (equationStyleMissSamples.length < 5) {
            equationStyleMissSamples.push(truncateForLog(workingDraft.prompt));
          }
          continue;
        }
        if (inputMode === "equation" && equationTrack === "arithmetic" && !isPromptCompatibleWithArithmeticHint(workingDraft.prompt, arithmeticHint)) {
          reasons.arithmetic_operator_mismatch = (reasons.arithmetic_operator_mismatch ?? 0) + 1;
          fillRejectCounts.arithmetic_operator_mismatch = (fillRejectCounts.arithmetic_operator_mismatch ?? 0) + 1;
          continue;
        }
        const generatedCategory = detectSolveCategory(workingDraft.prompt);
        if (!isCategoryCompatible(sourceCategory, generatedCategory)) {
          const relaxedWordProblemAccept =
            inputMode === "word_problem" && sourceWordIntent === "general" && isRelaxedWordProblem(workingDraft.prompt);
          if (!relaxedWordProblemAccept) {
            reasons.classification_mismatch = (reasons.classification_mismatch ?? 0) + 1;
            fillRejectCounts.classification_mismatch = (fillRejectCounts.classification_mismatch ?? 0) + 1;
            continue;
          }
          reasons.classification_relaxed_accept = (reasons.classification_relaxed_accept ?? 0) + 1;
        }
        if (inputMode === "word_problem" && !isWordProblemIntentCompatible(workingDraft.prompt, sourceWordIntent)) {
          reasons.intent_mismatch = (reasons.intent_mismatch ?? 0) + 1;
          fillRejectCounts.intent_mismatch = (fillRejectCounts.intent_mismatch ?? 0) + 1;
          continue;
        }
        if (inputMode === "equation" && equationTrack === "unit_conversion_pure" && !hasPureUnitConversionForm(workingDraft.prompt)) {
          reasons.unit_conversion_style_miss = (reasons.unit_conversion_style_miss ?? 0) + 1;
          fillRejectCounts.unit_conversion_style_miss = (fillRejectCounts.unit_conversion_style_miss ?? 0) + 1;
          continue;
        }
        if (inputMode === "equation" && equationTrack !== "arithmetic" && unitDomainLock !== null) {
          if (!promptUsesOnlyUnitDomain(workingDraft.prompt, unitDomainLock)) {
            reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
            fillRejectCounts.unit_domain_mismatch = (fillRejectCounts.unit_domain_mismatch ?? 0) + 1;
            continue;
          }
          const parsedDraftConversion = parseUnitConversion(workingDraft.prompt);
          if (parsedDraftConversion !== null && !isConversionInDomain(parsedDraftConversion, unitDomainLock)) {
            reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
            fillRejectCounts.unit_domain_mismatch = (fillRejectCounts.unit_domain_mismatch ?? 0) + 1;
            continue;
          }
        }

        if (!workingDraft.prompt || normalizeSpaces(workingDraft.prompt).length < 3) {
          reasons.prompt_too_short = (reasons.prompt_too_short ?? 0) + 1;
          fillRejectCounts.prompt_too_short = (fillRejectCounts.prompt_too_short ?? 0) + 1;
          continue;
        }
        const parsedConversion = parseUnitConversion(workingDraft.prompt);
        if (parsedConversion !== null) {
          if (unitDomainLock !== null && !isConversionInDomain(parsedConversion, unitDomainLock)) {
            reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
            fillRejectCounts.unit_domain_mismatch = (fillRejectCounts.unit_domain_mismatch ?? 0) + 1;
            continue;
          }
          if (equationTrack === "unit_conversion_pure" && convertUnitValue(parsedConversion) === null) {
            reasons.unit_conversion_pair_unsupported = (reasons.unit_conversion_pair_unsupported ?? 0) + 1;
            fillRejectCounts.unit_conversion_pair_unsupported = (fillRejectCounts.unit_conversion_pair_unsupported ?? 0) + 1;
            continue;
          }
        }

        accepted.push({
          prompt: normalizeSpaces(workingDraft.prompt),
          required_items: ["prompt"],
          items: [{ type: "prompt", slot: "stem", text: normalizeSpaces(workingDraft.prompt) }]
        });
        if (unitDomainLock?.domain === "length") {
          const acceptedConversion = parseUnitConversion(workingDraft.prompt);
          if (acceptedConversion !== null && includesMeterUnit(acceptedConversion)) {
            acceptedLengthHasMeter = true;
          }
        }

        if (shouldStopEarly(targetCount, accepted.length, inputMode)) {
          break;
        }
      }
      generationTimeline.push({
        phase: "fill",
        index: fillTry,
        requested: fillTarget,
        drafts: generated.drafts.length,
        accepted: accepted.length - acceptedBeforeFill,
        rejected: Object.values(fillRejectCounts).reduce((sum, v) => sum + v, 0),
        errors: generated.errors
      });
    }
  }

  if (equationTrack === "unit_conversion_pure" && unitDomainLock !== null && accepted.length < targetCount) {
    const missing = targetCount - accepted.length;
    const fallbackPrompts = buildUnitConversionPureFallbackPrompts(unitDomainLock, `${seedText}:purefill`, missing * 2);
    const existing = new Set(accepted.map((p) => p.prompt));
    let filled = 0;
    for (const prompt of fallbackPrompts) {
      if (filled >= missing) break;
      if (existing.has(prompt)) continue;
      accepted.push({
        prompt,
        required_items: ["prompt"],
        items: [{ type: "prompt", slot: "stem", text: prompt }]
      });
      existing.add(prompt);
      filled += 1;
    }
    if (filled > 0) {
      reasons.unit_conversion_pure_fallback_fill = (reasons.unit_conversion_pure_fallback_fill ?? 0) + filled;
    }
  }

  if (unitDomainLock?.domain === "length" && targetCount >= 10 && accepted.length > 0) {
    const parsedPairs = accepted
      .map((p) => parseUnitConversion(p.prompt))
      .filter((x): x is UnitConversionParsed => x !== null)
      .map((p) => conversionPairKey(p));
    const pairSet = new Set(parsedPairs);
    const hasMeter = accepted
      .map((p) => parseUnitConversion(p.prompt))
      .some((p) => p !== null && includesMeterUnit(p));

    let replaced = 0;
    if (!hasMeter) {
      const fallback = buildLengthMeterFallbackProblem(seedText);
      accepted[accepted.length - 1] = fallback;
      replaced += 1;
      reasons.unit_diversity_fallback_meter = (reasons.unit_diversity_fallback_meter ?? 0) + 1;
      pairSet.add("m->cm");
    }

    if (pairSet.size < 2 && accepted.length >= 2) {
      const fallback2 = buildLengthConversionFallbackProblem(seedText, "cm_to_m");
      accepted[accepted.length - 2] = fallback2;
      replaced += 1;
      reasons.unit_diversity_fallback_pair = (reasons.unit_diversity_fallback_pair ?? 0) + 1;
    }

    if (replaced > 0) {
      acceptedLengthHasMeter = true;
    }
  }

  const appliedCount = accepted.length;
  const topItems = accepted[0]?.items ?? [];
  const needConfirm = appliedCount === 0 || (equationTrackAnalysis?.ambiguous ?? false);
  const note =
    appliedCount === 0
      ? "unknown_no_viable_candidate"
      : hitTimeBudget
        ? "partial_success_timeout"
        : appliedCount < targetCount
          ? "partial_success"
          : equationTrackAnalysis?.ambiguous
            ? "ok_ambiguous_unit_conversion"
          : cappedByPolicy
            ? "ok_count_capped_by_policy"
          : "ok";

  const response = {
    spec_version: "micro_problem_render_v1" as const,
    request_id: requestId,
    schema_version: "micro_generate_from_ocr_response_v1" as const,
    detected_mode: appliedCount > 0 ? (inputMode as "equation" | "word_problem") : ("unknown" as const),
    intent: appliedCount > 0 ? "llm_free_generation" : "unknown_intent",
    confidence: appliedCount > 0 ? 0.78 : 0.2,
    required_items: appliedCount > 0 ? (["prompt"] as const) : ([] as const),
    items: topItems,
    problems: accepted,
    requested_count: count,
    applied_count: appliedCount,
    need_confirm: needConfirm,
    reasons,
    meta: {
      note,
      seed: seedText,
      grade_band_applied: gradeBandApplied,
      count_policy: "server_enforced",
      max_count: maxCount,
      target_count: targetCount,
      request_hash: sha(normalizeSpaces(ocrText)),
      inference_latency_ms: Date.now() - start
    },
    debug: {
      generator_model: GEMINI_MODEL,
      solver_model: null,
      generation_calls: generationCalls,
      solver_calls: solverCalls,
      generation_status: generationStatus,
      solver_status: solverStatus,
      language,
      grade_band,
      input_mode: inputMode,
      source_category: sourceCategory,
      source_word_intent: sourceWordIntent,
      equation_track: equationTrack,
      arithmetic_hint: arithmeticHint,
      equation_track_decision: equationTrackAnalysis?.decision ?? null,
      equation_track_ambiguous: equationTrackAnalysis?.ambiguous ?? false,
      equation_track_reason: equationTrackAnalysis?.reason ?? null,
      ocr_retake_recommended: equationTrackAnalysis?.ambiguous ?? false,
      ocr_source: ocrSource,
      ai_ocr_fallback_used: aiOcrFallbackUsed,
      ai_ocr_status: aiOcrStatus,
      ai_ocr_error: aiOcrError,
      ai_ocr_text_length: ocrSource === "image_ocr" ? ocrText.length : 0,
      generation_timeline: generationTimeline,
      equation_style_miss_samples: equationStyleMissSamples,
      unit_domain_lock: unitDomainLock,
      choices_disabled: true,
      choice_generation_via_ai: false,
      kanji_guard: {
        checked: true,
        violations_count: violationsCount,
        rewrite_attempts: 0,
        local_replacements: localReplacements
      }
    }
  };

  console.log(
    JSON.stringify({
      event: "micro_generate_from_ocr_observe",
      request_id: requestId,
      input_mode: inputMode,
      equation_track: equationTrack,
      arithmetic_hint: arithmeticHint,
      equation_track_decision: equationTrackAnalysis?.decision ?? null,
      equation_track_ambiguous: equationTrackAnalysis?.ambiguous ?? false,
      equation_track_reason: equationTrackAnalysis?.reason ?? null,
      ocr_source: ocrSource,
      ai_ocr_fallback_used: aiOcrFallbackUsed,
      ai_ocr_status: aiOcrStatus,
      ai_ocr_error: aiOcrError,
      ai_ocr_text_length: ocrSource === "image_ocr" ? ocrText.length : 0,
      source_word_intent: sourceWordIntent,
      requested_count: count,
      target_count: targetCount,
      applied_count: appliedCount,
      reasons,
      generation_timeline: generationTimeline,
      equation_style_miss_samples: equationStyleMissSamples
    })
  );

  return res.status(200).json(response);
});

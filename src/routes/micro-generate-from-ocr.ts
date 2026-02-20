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
const EARLY_SATISFY_COUNT = 4;

type RenderItem =
  | { type: "prompt"; slot: "stem"; text: string }
  | { type: "choices"; slot: "options"; style: "mc"; choices: string[]; correct_index: number };

type GeneratedProblem = {
  prompt: string;
  choices: string[];
  correct_index: number;
  answer_value: number;
  equation?: string;
  check_trace?: string;
  required_items: ["prompt", "choices"];
  items: RenderItem[];
};

const requestSchema = z
  .object({
    ocr_text: z.string().min(1),
    count: z.union([z.literal(4), z.literal(5), z.literal(10)]).default(DEFAULT_COUNT),
    grade_band: z.enum(["g1", "g2_g3", "g1_g3"]).optional(),
    language: z.string().default("ja"),
    seed: z.union([z.string().min(1), z.number().int()])
  })
  .strict();

const llmGenSchema = z
  .object({
    problems: z
      .array(
        z
          .object({
            prompt: z.string().min(1),
            choices: z.array(z.string().min(1)).min(5)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

const llmSolveSchema = z
  .object({
    answer_value: z.number(),
    correct_index: z.number().int(),
    equation: z.string().optional(),
    check_trace: z.string().optional()
  })
  .strict();

type GenerationDraft = {
  prompt: string;
  choices: string[];
};

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
      String.raw`(\d+(?:\.\d+)?)${sep}(mm|cm|km|mL|dL|L|kg|g|ミリメートル|センチメートル|キロメートル|メートル|ミリリットル|デシリットル|リットル|キログラム|グラム)${sep}=${sep}${blank}${sep}(mm|cm|km|mL|dL|L|kg|g|ミリメートル|センチメートル|キロメートル|メートル|ミリリットル|デシリットル|リットル|キログラム|グラム)`,
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

function validateLight(problem: { prompt: string; choices: string[]; correct_index: number; answer_value: number }): { ok: boolean; reason?: string } {
  const choices = problem.choices.map((c) => normalizeSpaces(c));
  if (!problem.prompt || normalizeSpaces(problem.prompt).length < 5) return { ok: false, reason: "prompt_too_short" };
  if (choices.length !== 5) return { ok: false, reason: "choices_not_5" };
  if (problem.correct_index < 0 || problem.correct_index > 4) return { ok: false, reason: "correct_index_out_of_range" };
  const uniq = new Set(choices.map((c) => c.toLowerCase()));
  if (uniq.size !== choices.length) return { ok: false, reason: "choices_duplicated" };

  const selected = choices[problem.correct_index];
  const selectedNum = extractFirstNumber(selected);
  if (selectedNum === null) return { ok: false, reason: "selected_choice_has_no_number" };
  if (Math.abs(selectedNum - problem.answer_value) > 1e-9) return { ok: false, reason: "answer_choice_mismatch" };
  if (!Number.isFinite(problem.answer_value) || problem.answer_value < 0 || problem.answer_value > 9999) {
    return { ok: false, reason: "answer_out_of_range" };
  }
  return { ok: true };
}

function isEquationStylePrompt(prompt: string): boolean {
  const normalized = prompt.normalize("NFKC");
  const arithmeticStyle = /[0-9]\s*[\+\-\*×÷]\s*[0-9]/.test(normalized) && /=|□|口|ロ|_/.test(normalized);
  const conversionStyle = parseUnitConversion(normalized) !== null;
  return arithmeticStyle || conversionStyle;
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

function normalizeChoiceValue(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .flatMap((x) => {
        if (typeof x === "string") return [normalizeSpaces(x)];
        if (x && typeof x === "object") {
          const t = (x as Record<string, unknown>).text;
          if (typeof t === "string") return [normalizeSpaces(t)];
        }
        return [];
      })
      .filter(Boolean);
  }
  if (typeof v === "string") {
    const normalized = v.normalize("NFKC");
    return normalized
      .split(/\n|,|、|;|；|\|/)
      .map((x) => normalizeSpaces(x.replace(/^[①-⑩\d\.\)\(]+\s*/, "")))
      .filter(Boolean);
  }
  return [];
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
    const choiceKeys = ["choices", "options", "candidates", "answers", "select_options"];
    let choices: string[] = [];
    for (const key of choiceKeys) {
      choices = normalizeChoiceValue(obj[key]);
      if (choices.length > 0) break;
    }
    const dedup = Array.from(new Set(choices.map((x) => normalizeSpaces(x).toLowerCase()))).map((x) => {
      const original = choices.find((c) => normalizeSpaces(c).toLowerCase() === x);
      return original ?? x;
    });
    if (!prompt || dedup.length < 5) continue;
    out.push({ prompt, choices: dedup.slice(0, 5) });
  }
  return out;
}

function repairGenerationPrompt(language: string, raw: unknown): string {
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  return [
    "ROLE: json_repair_v1",
    `Language: ${language}`,
    "Convert the following output into STRICT JSON only.",
    'Target schema: {"problems":[{"prompt":"...","choices":["...","...","...","...","..."]}]}',
    "Rules:",
    "- Keep only usable problems.",
    "- choices must be exactly 5 strings per problem.",
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

function generationPrompt(input: {
  ocrText: string;
  count: number;
  gradeBand: string;
  language: string;
  seed: string;
  inputMode: "equation" | "word_problem";
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
    `Requested count: ${input.count}`,
    `Seed: ${input.seed}`,
    "Task: Read the source problem and generate similar elementary math multiple-choice problems.",
    "Output STRICT JSON only:",
    '{"problems":[{"prompt":"...","choices":["...","...","...","...","..."]}]}',
    "Rules:",
    "- Keep difficulty around grade 1-3.",
    "- Each problem must be answerable with one correct option.",
    ...(input.inputMode === "equation"
      ? [
          "- Return equation-style problems (e.g. 7 + 9 - 6 = □).",
          "- Do NOT convert equations into story/word problems.",
          ...(input.conversionHint
            ? [
                "- Keep unit-conversion equation style (e.g. 40mm = □cm, 3L = □dL).",
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
      : ["- Return short Japanese word-problem style prompts."]),
    "- No explanations.",
    ...gradeInstructions,
    "Source OCR:",
    input.ocrText
  ].join("\n");
}

function solvePrompt(input: { prompt: string; choices: string[]; language: string }): string {
  return [
    "ROLE: solver_v1",
    `Language: ${input.language}`,
    "Solve the multiple-choice elementary math problem.",
    "Output STRICT JSON only:",
    '{"answer_value":56,"correct_index":3,"equation":"8*7","check_trace":"..."}',
    "Rules:",
    "- correct_index must be 0-based.",
    "- answer_value must match the selected choice numerically.",
    "Problem:",
    input.prompt,
    "Choices:",
    input.choices.map((c, i) => `${i}: ${c}`).join("\n")
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

function detectInputMode(ocrText: string): "equation" | "word_problem" {
  const normalized = ocrText.normalize("NFKC");
  const hasEquals = normalized.includes("=");
  const hasBlank = /□|＿|_|\[\]|\b空欄\b/.test(normalized);
  const hasArithmeticPattern = /[0-9]\s*[\+\-\*×÷]\s*[0-9]/.test(normalized);
  const hasUnitConversionPattern = parseUnitConversion(normalized) !== null;
  const hasNumberUnitPair = /\d+\s*(mm|cm|km|mL|dL|L|kg|g|円|ミリメートル|センチメートル|メートル|キロメートル|ミリリットル|デシリットル|リットル|グラム|キログラム)/i.test(
    normalized
  );
  const wordMarkers = /(ですか|なりますか|つぎから|えらびなさい|あげました|のこり|何こ|何本|何人|毎日|きょう|きのう)/;
  const sentenceLike = /[。！？]/.test(normalized);
  const wordMarkerCount = (normalized.match(new RegExp(wordMarkers, "g")) ?? []).length;

  if (hasEquals || hasBlank || hasArithmeticPattern || hasUnitConversionPattern || hasNumberUnitPair) {
    return "equation";
  }
  if (sentenceLike && wordMarkerCount >= 2) {
    return "word_problem";
  }
  return "equation";
}

function generationBatches(count: 4 | 5 | 10): number[] {
  if (count === 10) return [5, 5];
  return [count];
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
  inputMode: "equation" | "word_problem";
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
      drafts = parsedGen.data.problems.map((p) => ({
        prompt: normalizeSpaces(p.prompt),
        choices: p.choices.slice(0, 5).map((c) => normalizeSpaces(c))
      }));
    } else {
      drafts = salvageGenerationPayload(genResp.data);
      if (drafts.length === 0) {
        const repaired = await callGeminiJson(repairGenerationPrompt(input.language, genResp.data));
        if (repaired.ok && repaired.data) {
          const repairedStrict = llmGenSchema.safeParse(repaired.data);
          if (repairedStrict.success) {
            drafts = repairedStrict.data.problems.map((p) => ({
              prompt: normalizeSpaces(p.prompt),
              choices: p.choices.slice(0, 5).map((c) => normalizeSpaces(c))
            }));
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
  let replacements = promptApplied.changed;
  const nextChoices = draft.choices.map((c) => {
    const applied = applyReplaceDict(c, dict);
    replacements += applied.changed;
    return normalizeSpaces(applied.text);
  });

  return {
    draft: {
      prompt: normalizeSpaces(promptApplied.text),
      choices: nextChoices
    },
    replacements
  };
}

function shouldStopEarly(
  targetCount: number,
  acceptedCount: number,
  inputMode: "equation" | "word_problem"
): boolean {
  if (acceptedCount >= targetCount) return true;
  if (inputMode !== "word_problem") return false;
  return targetCount >= 5 && acceptedCount >= EARLY_SATISFY_COUNT;
}

function buildLengthMeterFallbackProblem(seedText: string): GeneratedProblem {
  const meters = (hashInt(`${seedText}:meter`) % 9) + 1; // 1..9 m
  const answer = meters * 100;
  const distractors = [answer - 100, answer + 100, answer + 200, answer - 200]
    .filter((v) => v >= 0)
    .slice(0, 4);
  while (distractors.length < 4) {
    distractors.push(answer + (distractors.length + 1) * 300);
  }
  const all = [answer, ...distractors];
  const unique = Array.from(new Set(all)).slice(0, 5);
  while (unique.length < 5) {
    unique.push(answer + (unique.length + 1) * 500);
  }
  const correctIndex = unique.indexOf(answer);
  const choices = unique.map((v) => String(v));
  const prompt = `${meters} m = □ cm`;

  return {
    prompt,
    choices,
    correct_index: correctIndex,
    answer_value: answer,
    equation: `${meters}*100`,
    check_trace: `${meters}m = ${answer}cm`,
    required_items: ["prompt", "choices"],
    items: [
      { type: "prompt", slot: "stem", text: prompt },
      { type: "choices", slot: "options", style: "mc", choices, correct_index: correctIndex }
    ]
  };
}

function buildLengthConversionFallbackProblem(seedText: string, kind: "cm_to_m" | "m_to_cm"): GeneratedProblem {
  if (kind === "cm_to_m") {
    const meters = (hashInt(`${seedText}:cm_to_m`) % 9) + 1;
    const cm = meters * 100;
    const answer = meters;
    const choices = [String(answer), String(answer + 1), String(answer + 2), String(answer + 3), String(answer + 4)];
    return {
      prompt: `${cm} cm = □ m`,
      choices,
      correct_index: 0,
      answer_value: answer,
      equation: `${cm}/100`,
      check_trace: `${cm}cm = ${answer}m`,
      required_items: ["prompt", "choices"],
      items: [
        { type: "prompt", slot: "stem", text: `${cm} cm = □ m` },
        { type: "choices", slot: "options", style: "mc", choices, correct_index: 0 }
      ]
    };
  }

  const meters = (hashInt(`${seedText}:m_to_cm`) % 9) + 1;
  const answer = meters * 100;
  const distractors = [answer - 100, answer + 100, answer + 200, answer - 200].filter((v) => v >= 0).slice(0, 4);
  while (distractors.length < 4) distractors.push(answer + (distractors.length + 1) * 300);
  const raw = [answer, ...distractors];
  const unique = Array.from(new Set(raw)).slice(0, 5);
  while (unique.length < 5) unique.push(answer + (unique.length + 1) * 500);
  const choices = unique.map(String);
  const correctIndex = unique.indexOf(answer);
  return {
    prompt: `${meters} m = □ cm`,
    choices,
    correct_index: correctIndex,
    answer_value: answer,
    equation: `${meters}*100`,
    check_trace: `${meters}m = ${answer}cm`,
    required_items: ["prompt", "choices"],
    items: [
      { type: "prompt", slot: "stem", text: `${meters} m = □ cm` },
      { type: "choices", slot: "options", style: "mc", choices, correct_index: correctIndex }
    ]
  };
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

  const { ocr_text, count, grade_band, language, seed } = parsed.data;
  const seedText = String(seed);
  const start = Date.now();
  const requestedGradeBand = normalizeRequestedGradeBand(grade_band);
  const inputMode = detectInputMode(ocr_text);
  const sourceConversion = parseUnitConversion(ocr_text);
  const unitDomainLock = buildUnitDomainLock(sourceConversion);
  const maxCount = inputMode === "word_problem" ? 5 : 10;
  const targetCount = Math.min(count, maxCount) as 4 | 5 | 10;
  const cappedByPolicy = targetCount < count;

  const accepted: GeneratedProblem[] = [];
  const reasons: Record<string, number> = {};
  let generationCalls = 0;
  let solverCalls = 0;
  let generationStatus: number | null = null;
  let solverStatus: number | null = null;
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

    const generated = await fetchGenerationDrafts({
      ocrText: ocr_text,
      count: batchTarget,
      gradeBand: grade_band ?? "g1_g3",
        language,
        seed: `${seedText}:b${batchIndex}`,
        inputMode,
        conversionHint: sourceConversion !== null,
        unitDomainLock
      });
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
      gradeBandApplied = estimateGradeBand({ ocrText: ocr_text, drafts: generationDrafts });
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
      const workingDraft = normalized.draft;
      const guard = checkKanjiGuard({ prompt: workingDraft.prompt, choices: workingDraft.choices }, gradeBandApplied);
      violationsCount += guard.violations_count;
      if (inputMode === "equation" && !isEquationStylePrompt(workingDraft.prompt)) {
        reasons.equation_style_miss = (reasons.equation_style_miss ?? 0) + 1;
        continue;
      }
      if (inputMode === "equation" && sourceConversion !== null && parseUnitConversion(workingDraft.prompt) === null) {
        reasons.unit_conversion_style_miss = (reasons.unit_conversion_style_miss ?? 0) + 1;
        continue;
      }
      if (inputMode === "equation" && sourceConversion !== null && unitDomainLock !== null) {
        const parsedDraftConversion = parseUnitConversion(workingDraft.prompt);
        if (parsedDraftConversion !== null && !isConversionInDomain(parsedDraftConversion, unitDomainLock)) {
          reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
          continue;
        }
      }

      solverCalls += 1;
      const solveResp = await callGeminiJson(solvePrompt({ prompt: workingDraft.prompt, choices: workingDraft.choices.slice(0, 5), language }));
      solverStatus = solveResp.status;
      if (!solveResp.ok || !solveResp.data) {
        reasons[solveResp.error ?? "solver_failed"] = (reasons[solveResp.error ?? "solver_failed"] ?? 0) + 1;
        continue;
      }

      const parsedSolve = llmSolveSchema.safeParse(solveResp.data);
      if (!parsedSolve.success) {
        reasons.solver_schema_invalid = (reasons.solver_schema_invalid ?? 0) + 1;
        continue;
      }

      const light = validateLight({
        prompt: workingDraft.prompt,
        choices: workingDraft.choices.slice(0, 5),
        correct_index: parsedSolve.data.correct_index,
        answer_value: parsedSolve.data.answer_value
      });
      if (!light.ok) {
        const key = light.reason ?? "light_validation_failed";
        reasons[key] = (reasons[key] ?? 0) + 1;
        continue;
      }
      const parsedConversion = parseUnitConversion(workingDraft.prompt);
      if (parsedConversion !== null) {
        if (unitDomainLock !== null && !isConversionInDomain(parsedConversion, unitDomainLock)) {
          reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
          continue;
        }
        const expected = convertUnitValue(parsedConversion);
        if (expected === null) {
          reasons.unit_conversion_pair_unsupported = (reasons.unit_conversion_pair_unsupported ?? 0) + 1;
          continue;
        }
        if (Math.abs(expected - parsedSolve.data.answer_value) > 1e-9) {
          reasons.unit_conversion_answer_mismatch = (reasons.unit_conversion_answer_mismatch ?? 0) + 1;
          continue;
        }
      }

      accepted.push({
        prompt: normalizeSpaces(workingDraft.prompt),
        choices: workingDraft.choices.slice(0, 5).map((c) => normalizeSpaces(c)),
        correct_index: parsedSolve.data.correct_index,
        answer_value: parsedSolve.data.answer_value,
        equation: parsedSolve.data.equation,
        check_trace: parsedSolve.data.check_trace,
        required_items: ["prompt", "choices"],
        items: [
          { type: "prompt", slot: "stem", text: normalizeSpaces(workingDraft.prompt) },
          {
            type: "choices",
            slot: "options",
            style: "mc",
            choices: workingDraft.choices.slice(0, 5).map((c) => normalizeSpaces(c)),
            correct_index: parsedSolve.data.correct_index
          }
        ]
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
      const generated = await fetchGenerationDrafts({
        ocrText: ocr_text,
        count: Math.min(needed, 5),
        gradeBand: grade_band ?? "g1_g3",
        language,
        seed: `${seedText}:fill:${fillTry}`,
        inputMode,
        conversionHint: sourceConversion !== null,
        unitDomainLock
      });
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
        const workingDraft = normalized.draft;
        const guard = checkKanjiGuard({ prompt: workingDraft.prompt, choices: workingDraft.choices }, gradeBandApplied);
        violationsCount += guard.violations_count;
        if (inputMode === "equation" && !isEquationStylePrompt(workingDraft.prompt)) {
          reasons.equation_style_miss = (reasons.equation_style_miss ?? 0) + 1;
          continue;
        }
        if (inputMode === "equation" && sourceConversion !== null && parseUnitConversion(workingDraft.prompt) === null) {
          reasons.unit_conversion_style_miss = (reasons.unit_conversion_style_miss ?? 0) + 1;
          continue;
        }
        if (inputMode === "equation" && sourceConversion !== null && unitDomainLock !== null) {
          const parsedDraftConversion = parseUnitConversion(workingDraft.prompt);
          if (parsedDraftConversion !== null && !isConversionInDomain(parsedDraftConversion, unitDomainLock)) {
            reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
            continue;
          }
        }

        solverCalls += 1;
        const solveResp = await callGeminiJson(
          solvePrompt({ prompt: workingDraft.prompt, choices: workingDraft.choices.slice(0, 5), language })
        );
        solverStatus = solveResp.status;
        if (!solveResp.ok || !solveResp.data) {
          reasons[solveResp.error ?? "solver_failed"] = (reasons[solveResp.error ?? "solver_failed"] ?? 0) + 1;
          continue;
        }

        const parsedSolve = llmSolveSchema.safeParse(solveResp.data);
        if (!parsedSolve.success) {
          reasons.solver_schema_invalid = (reasons.solver_schema_invalid ?? 0) + 1;
          continue;
        }

        const light = validateLight({
          prompt: workingDraft.prompt,
          choices: workingDraft.choices.slice(0, 5),
          correct_index: parsedSolve.data.correct_index,
          answer_value: parsedSolve.data.answer_value
        });
        if (!light.ok) {
          const key = light.reason ?? "light_validation_failed";
          reasons[key] = (reasons[key] ?? 0) + 1;
          continue;
        }
        const parsedConversion = parseUnitConversion(workingDraft.prompt);
        if (parsedConversion !== null) {
          if (unitDomainLock !== null && !isConversionInDomain(parsedConversion, unitDomainLock)) {
            reasons.unit_domain_mismatch = (reasons.unit_domain_mismatch ?? 0) + 1;
            continue;
          }
          const expected = convertUnitValue(parsedConversion);
          if (expected === null) {
            reasons.unit_conversion_pair_unsupported = (reasons.unit_conversion_pair_unsupported ?? 0) + 1;
            continue;
          }
          if (Math.abs(expected - parsedSolve.data.answer_value) > 1e-9) {
            reasons.unit_conversion_answer_mismatch = (reasons.unit_conversion_answer_mismatch ?? 0) + 1;
            continue;
          }
        }

        accepted.push({
          prompt: normalizeSpaces(workingDraft.prompt),
          choices: workingDraft.choices.slice(0, 5).map((c) => normalizeSpaces(c)),
          correct_index: parsedSolve.data.correct_index,
          answer_value: parsedSolve.data.answer_value,
          equation: parsedSolve.data.equation,
          check_trace: parsedSolve.data.check_trace,
          required_items: ["prompt", "choices"],
          items: [
            { type: "prompt", slot: "stem", text: normalizeSpaces(workingDraft.prompt) },
            {
              type: "choices",
              slot: "options",
              style: "mc",
              choices: workingDraft.choices.slice(0, 5).map((c) => normalizeSpaces(c)),
              correct_index: parsedSolve.data.correct_index
            }
          ]
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
  const needConfirm = appliedCount === 0;
  const note =
    appliedCount === 0
      ? "unknown_no_viable_candidate"
      : hitTimeBudget
        ? "partial_success_timeout"
        : appliedCount < targetCount
          ? inputMode === "word_problem" && appliedCount >= EARLY_SATISFY_COUNT
            ? "partial_success_filled"
            : "partial_success"
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
    required_items: appliedCount > 0 ? (["prompt", "choices"] as const) : ([] as const),
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
      request_hash: sha(normalizeSpaces(ocr_text)),
      inference_latency_ms: Date.now() - start
    },
    debug: {
      generator_model: GEMINI_MODEL,
      solver_model: GEMINI_MODEL,
      generation_calls: generationCalls,
      solver_calls: solverCalls,
      generation_status: generationStatus,
      solver_status: solverStatus,
      language,
      grade_band,
      input_mode: inputMode,
      unit_domain_lock: unitDomainLock,
      kanji_guard: {
        checked: true,
        violations_count: violationsCount,
        rewrite_attempts: 0,
        local_replacements: localReplacements
      }
    }
  };

  return res.status(200).json(response);
});

import { randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = 15000;
const MAX_GENERATION_RETRIES = 2;

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
    count: z.union([z.literal(4), z.literal(5), z.literal(10)]),
    grade_band: z.string().default("g1_g3"),
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

function extractFirstNumber(s: string): number | null {
  const normalized = s.normalize("NFKC").replace(/,/g, "");
  const m = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
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

function generationPrompt(input: { ocrText: string; count: number; gradeBand: string; language: string; seed: string }): string {
  return [
    "ROLE: generator_v1",
    `Language: ${input.language}`,
    `Grade band: ${input.gradeBand}`,
    `Requested count: ${input.count}`,
    `Seed: ${input.seed}`,
    "Task: Read the source problem and generate similar elementary math multiple-choice problems.",
    "Output STRICT JSON only:",
    '{"problems":[{"prompt":"...","choices":["...","...","...","...","..."]}]}',
    "Rules:",
    "- Keep difficulty around grade 1-3.",
    "- Each problem must be answerable with one correct option.",
    "- No explanations.",
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

function generationBatches(count: 4 | 5 | 10): number[] {
  if (count === 10) return [5, 5];
  return [count];
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

  const accepted: GeneratedProblem[] = [];
  const reasons: Record<string, number> = {};
  let generationCalls = 0;
  let solverCalls = 0;
  let generationStatus: number | null = null;
  let solverStatus: number | null = null;

  const batches = generationBatches(count);
  for (let batchIndex = 0; batchIndex < batches.length && accepted.length < count; batchIndex += 1) {
    const batchTarget = Math.min(batches[batchIndex], count - accepted.length);
    if (batchTarget <= 0) break;

    let generationDrafts: GenerationDraft[] = [];
    for (let attempt = 0; attempt < MAX_GENERATION_RETRIES && generationDrafts.length === 0; attempt += 1) {
      generationCalls += 1;
      const genResp = await callGeminiJson(
        generationPrompt({
          ocrText: ocr_text,
          count: batchTarget,
          gradeBand: grade_band,
          language,
          seed: `${seedText}:b${batchIndex}:a${attempt}`
        })
      );
      generationStatus = genResp.status;
      if (!genResp.ok || !genResp.data) {
        const key = genResp.error ?? "generation_failed";
        reasons[key] = (reasons[key] ?? 0) + 1;
        if (attempt < MAX_GENERATION_RETRIES - 1 && isRetriableGenError(genResp.error)) {
          await sleep(jitterMs(250, 600));
        }
        continue;
      }

      const parsedGen = llmGenSchema.safeParse(genResp.data);
      if (parsedGen.success) {
        generationDrafts = parsedGen.data.problems.map((p) => ({
          prompt: normalizeSpaces(p.prompt),
          choices: p.choices.slice(0, 5).map((c) => normalizeSpaces(c))
        }));
      } else {
        generationDrafts = salvageGenerationPayload(genResp.data);
        if (generationDrafts.length === 0) {
          const repaired = await callGeminiJson(repairGenerationPrompt(language, genResp.data));
          if (repaired.ok && repaired.data) {
            const repairedStrict = llmGenSchema.safeParse(repaired.data);
            if (repairedStrict.success) {
              generationDrafts = repairedStrict.data.problems.map((p) => ({
                prompt: normalizeSpaces(p.prompt),
                choices: p.choices.slice(0, 5).map((c) => normalizeSpaces(c))
              }));
            } else {
              generationDrafts = salvageGenerationPayload(repaired.data);
            }
          }
        }
      }

      if (generationDrafts.length === 0) {
        reasons.generation_schema_invalid = (reasons.generation_schema_invalid ?? 0) + 1;
        continue;
      }
    }

    if (generationDrafts.length === 0) {
      continue;
    }

    for (const draft of generationDrafts) {
      if (accepted.length >= count) break;
      solverCalls += 1;
      const solveResp = await callGeminiJson(solvePrompt({ prompt: draft.prompt, choices: draft.choices.slice(0, 5), language }));
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
        prompt: draft.prompt,
        choices: draft.choices.slice(0, 5),
        correct_index: parsedSolve.data.correct_index,
        answer_value: parsedSolve.data.answer_value
      });
      if (!light.ok) {
        const key = light.reason ?? "light_validation_failed";
        reasons[key] = (reasons[key] ?? 0) + 1;
        continue;
      }

      accepted.push({
        prompt: normalizeSpaces(draft.prompt),
        choices: draft.choices.slice(0, 5).map((c) => normalizeSpaces(c)),
        correct_index: parsedSolve.data.correct_index,
        answer_value: parsedSolve.data.answer_value,
        equation: parsedSolve.data.equation,
        check_trace: parsedSolve.data.check_trace,
        required_items: ["prompt", "choices"],
        items: [
          { type: "prompt", slot: "stem", text: normalizeSpaces(draft.prompt) },
          {
            type: "choices",
            slot: "options",
            style: "mc",
            choices: draft.choices.slice(0, 5).map((c) => normalizeSpaces(c)),
            correct_index: parsedSolve.data.correct_index
          }
        ]
      });
    }
  }

  const appliedCount = accepted.length;
  const topItems = accepted[0]?.items ?? [];
  const needConfirm = appliedCount === 0;

  const response = {
    spec_version: "micro_problem_render_v1" as const,
    request_id: requestId,
    schema_version: "micro_generate_from_ocr_response_v1" as const,
    detected_mode: appliedCount > 0 ? ("word_problem" as const) : ("unknown" as const),
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
      note: appliedCount === 0 ? "unknown_no_viable_candidate" : appliedCount < count ? "partial_success" : "ok",
      seed: seedText,
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
      grade_band
    }
  };

  return res.status(200).json(response);
});

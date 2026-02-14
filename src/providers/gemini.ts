import { z } from "zod";
import { type ExtractRequest } from "../schemas/extract.js";

export const PROMPT_VERSION = "extract_v1_2026-02-15";

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 8000);
const DEFAULT_TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE ?? 0.1);

const geminiCandidateSchema = z
  .object({
    template_id: z.string(),
    confidence: z.number().min(0).max(1),
    items: z.array(
      z.object({
        slot: z.string().optional(),
        category: z.string(),
        count_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      })
    ),
    scene: z
      .object({
        categories: z.array(z.string()),
        total_count_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      })
      .optional()
  })
  .strict();

export type GeminiCandidate = z.infer<typeof geminiCandidateSchema>;

export class GeminiError extends Error {
  constructor(
    public readonly kind: "timeout" | "model" | "decode",
    message: string
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

function buildPrompt(input: ExtractRequest): string {
  return [
    "You extract coarse candidates from OCR text for count worksheets.",
    "Return ONLY JSON and match this exact schema:",
    '{"template_id":"string","confidence":0.0,"items":[{"slot":"string","category":"string","count_range":[1,3]}],"scene":{"categories":["string"],"total_count_range":[1,10]}}',
    "Rules:",
    "- Keep confidence between 0 and 1.",
    "- count_range and total_count_range must be integer [min,max] with min <= max.",
    "- Never include markdown, comments, or explanation.",
    `locale: ${input.locale}`,
    `grade_hint: ${input.hint?.grade ?? "unknown"}`,
    `ocr_text: ${input.ocr_text}`
  ].join("\n");
}

function getTextFromGeminiResponse(data: unknown): string {
  const root = data as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text = root.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiError("decode", "gemini_empty_response");
  }

  return text;
}

function seedFromHash(hash: string): number {
  return Number.parseInt(hash.slice(0, 8), 16);
}

export async function extractWithGemini(
  input: ExtractRequest,
  ocrHash: string
): Promise<{ candidate: GeminiCandidate; model: string; promptVersion: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("model", "gemini_api_key_missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
          generationConfig: {
            temperature: DEFAULT_TEMPERATURE,
            seed: seedFromHash(ocrHash),
            responseMimeType: "application/json"
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new GeminiError("model", `gemini_http_${response.status}`);
    }

    const json = (await response.json()) as unknown;
    const text = getTextFromGeminiResponse(json);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new GeminiError("decode", "gemini_json_parse_failed");
    }

    const candidate = geminiCandidateSchema.safeParse(parsed);
    if (!candidate.success) {
      throw new GeminiError("decode", "gemini_schema_parse_failed");
    }

    return {
      candidate: candidate.data,
      model: DEFAULT_MODEL,
      promptVersion: PROMPT_VERSION
    };
  } catch (error) {
    if (error instanceof GeminiError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new GeminiError("timeout", "gemini_timeout");
    }

    throw new GeminiError("model", "gemini_unknown_error");
  } finally {
    clearTimeout(timeout);
  }
}

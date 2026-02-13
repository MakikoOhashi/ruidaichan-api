import { extractResponseSchema, type ExtractRequest, type ExtractResponse } from "../schemas/extract.js";

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 8000);

function buildPrompt(input: ExtractRequest): string {
  return [
    "You are an extraction engine for kindergarten/school count worksheets.",
    "Return ONLY valid JSON with this exact shape:",
    '{"template_id":"string","subquestion_count":number,"items_hint":[{"category":"string","object_hint":"string","count_range":[number,number]}],"confidence":number}',
    "Rules:",
    "- Keep confidence between 0 and 1.",
    "- count_range must have integer min/max.",
    "- Do not output markdown.",
    "- Do not output explanation.",
    "Input follows.",
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
    throw new Error("gemini_empty_response");
  }

  return text;
}

export async function extractWithGemini(input: ExtractRequest): Promise<ExtractResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("gemini_api_key_missing");
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
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(`gemini_http_${response.status}`);
    }

    const json = (await response.json()) as unknown;
    const text = getTextFromGeminiResponse(json);
    const parsed = JSON.parse(text) as unknown;

    return extractResponseSchema.parse(parsed);
  } finally {
    clearTimeout(timeout);
  }
}

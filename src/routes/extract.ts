import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { extractWithGemini, GeminiError } from "../providers/gemini.js";
import {
  MAX_OCR_TEXT_LENGTH,
  extractRequestSchema,
  extractResponseSchema,
  type ExtractResponse
} from "../schemas/extract.js";

export const extractRouter = Router();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function classifyError(error: unknown): "timeout" | "model" | "decode" | "internal" {
  if (error instanceof GeminiError) {
    return error.kind;
  }
  return "internal";
}

function buildStableResponse(
  raw: Awaited<ReturnType<typeof extractWithGemini>>,
  rawHash: string,
  normalizedHash: string
): ExtractResponse {
  const items = raw.candidate.items.map((item, index) => ({
    slot: item.slot ?? `slot_${index + 1}`,
    category: item.category,
    count_range: item.count_range
  }));

  const scene = raw.candidate.scene ?? {
    categories: Array.from(new Set(items.map((item) => item.category))),
    total_count_range: items.reduce<[number, number]>(
      (acc, item) => [acc[0] + item.count_range[0], acc[1] + item.count_range[1]],
      [0, 0]
    )
  };

  return {
    template_id: raw.candidate.template_id,
    confidence: raw.candidate.confidence,
    items,
    scene,
    debug: {
      raw_ocr_hash: rawHash,
      normalized_text_hash: normalizedHash,
      model: raw.model,
      prompt_version: raw.promptVersion
    }
  };
}

extractRouter.post("/", async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();

  const rawText = typeof req.body?.ocr_text === "string" ? req.body.ocr_text : "";
  if (rawText.length > MAX_OCR_TEXT_LENGTH) {
    console.log(
      JSON.stringify({
        event: "extract_error",
        request_id: requestId,
        error: "payload_too_large",
        latency_ms: Date.now() - startedAt
      })
    );
    return res.status(413).json({
      error: "payload_too_large",
      reason: "ocr_text_too_long",
      request_id: requestId
    });
  }

  const parsed = extractRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const hasEmptyText = parsed.error.issues.some(
      (issue) => issue.path.join(".") === "ocr_text" && issue.code === "too_small"
    );

    console.log(
      JSON.stringify({
        event: "extract_error",
        request_id: requestId,
        error: hasEmptyText ? "invalid_request_empty_text" : "invalid_request",
        latency_ms: Date.now() - startedAt
      })
    );

    return res.status(400).json({
      error: "invalid_request",
      request_id: requestId,
      details: parsed.error.flatten()
    });
  }

  const normalizedText = normalizeText(parsed.data.ocr_text);
  const rawOcrHash = sha256(parsed.data.ocr_text);
  const normalizedTextHash = sha256(normalizedText);

  try {
    const extracted = await extractWithGemini(
      {
        ...parsed.data,
        ocr_text: normalizedText
      },
      normalizedTextHash
    );

    const responseCandidate = buildStableResponse(extracted, rawOcrHash, normalizedTextHash);
    const validated = extractResponseSchema.safeParse(responseCandidate);

    if (!validated.success) {
      console.log(
        JSON.stringify({
          event: "extract_error",
          request_id: requestId,
          ocr_text_hash: rawOcrHash,
          error: "response_schema_invalid",
          latency_ms: Date.now() - startedAt
        })
      );
      return res.status(500).json({
        error: "internal_response_invalid",
        request_id: requestId
      });
    }

    console.log(
      JSON.stringify({
        event: "extract_success",
        request_id: requestId,
        ocr_text_hash: rawOcrHash,
        template_id: validated.data.template_id,
        confidence: validated.data.confidence,
        latency_ms: Date.now() - startedAt
      })
    );

    return res.status(200).json(validated.data);
  } catch (error) {
    const classified = classifyError(error);
    const message = error instanceof Error ? error.message : "unknown_error";

    console.log(
      JSON.stringify({
        event: "extract_error",
        request_id: requestId,
        ocr_text_hash: rawOcrHash,
        error: classified,
        detail: message,
        latency_ms: Date.now() - startedAt
      })
    );

    return res.status(502).json({
      error: "upstream_failed",
      request_id: requestId
    });
  }
});

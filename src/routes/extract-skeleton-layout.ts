import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  skeletonLayoutRequestSchema,
  skeletonLayoutResponseSchema,
  type SkeletonLayoutResponse
} from "../schemas/skeleton-layout.js";

export const extractSkeletonLayoutRouter = Router();

const MODEL_NAME = "heuristic_skeleton_stub";
const PROMPT_VERSION = "extract_skeleton_v1_2026-02-17";
const CONFIDENCE_THRESHOLD = 0.75;
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 8000);

type UnknownReason = "not_supported_in_v1" | "low_confidence" | "ambiguous" | "insufficient_signals";

type OcrSignals = {
  question_count: number;
  choice_token_count: number;
  select_phrase_hit: boolean;
  slot_phrase_hit: boolean;
};

type LayoutSignals = {
  row_count: number;
  col_count: number;
  stable_two_column_cluster: boolean;
};

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function decodeBase64Text(input: string): string {
  try {
    const normalized = input.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
    const text = Buffer.from(normalized, "base64").toString("utf8");
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function looksReadableText(text: string): boolean {
  if (!text) return false;
  const printableChars = (text.match(/[ -~\u3000-\u30FF\u4E00-\u9FFF]/g) ?? []).length;
  const ratio = printableChars / text.length;
  return ratio >= 0.6;
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function extractOcrSignals(text: string): OcrSignals {
  return {
    question_count: countMatches(text, /(\(\d+\)|（\d+）)/g),
    choice_token_count: countMatches(text, /[①②③④⑤]/g),
    select_phrase_hit: /(つぎから.?1つ選びなさい|つぎから.?ひとつ選びなさい|1つ選びなさい|ひとつ選びなさい|えらびなさい)/.test(
      text
    ),
    slot_phrase_hit: /(○をかこう|○をかきましょう|ぬりましょう|ます目|マス目|しるしをつけましょう)/.test(text)
  };
}

function extractLayoutSignals(text: string, ocr: OcrSignals): LayoutSignals {
  const rowMatches = [...text.matchAll(/r(\d+)c[12]/gi)];
  const rows = new Set(rowMatches.map((m) => m[1]));
  const col1 = countMatches(text, /r\d+c1/gi);
  const col2 = countMatches(text, /r\d+c2/gi);
  const inferredRows = ocr.slot_phrase_hit ? Math.max(ocr.question_count, 0) : 0;
  const row_count = rows.size > 0 ? rows.size : inferredRows;
  const hasAnswerCue = /(かずだけ|したの.?○|○をぬりましょう)/.test(text);
  const col_count = col1 >= 2 && col2 >= 2 ? 2 : hasAnswerCue ? 2 : 1;

  return {
    row_count,
    col_count,
    stable_two_column_cluster: row_count >= 2 && col_count === 2
  };
}

function buildBodyRegions(rowCount: number): SkeletonLayoutResponse["body_regions"] {
  const rows = Math.max(2, rowCount);
  const bodyTop = 0.2;
  const bodyHeight = 0.75;
  const rowHeight = bodyHeight / rows;
  const bodyRegions: SkeletonLayoutResponse["body_regions"] = [];

  for (let r = 0; r < rows; r += 1) {
    const y = clamp01(bodyTop + r * rowHeight);
    bodyRegions.push({
      id: `r${r + 1}c1`,
      role: "question_panel",
      rect: { x: 0.05, y, w: 0.44, h: clamp01(rowHeight - 0.01) }
    });
    bodyRegions.push({
      id: `r${r + 1}c2`,
      role: "answer_panel",
      rect: { x: 0.51, y, w: 0.44, h: clamp01(rowHeight - 0.01) }
    });
  }

  return bodyRegions;
}

function buildUnknown(
  reason: UnknownReason,
  detail: string,
  confidence = 0,
  model = MODEL_NAME
): SkeletonLayoutResponse {
  return {
    spec_version: "layout_skeleton_v1",
    layout_family: "unknown",
    unknown_reason: reason,
    slot_schema: {
      type: "mark_slots",
      mark_shape: "circle",
      rows: 1,
      cols: 1
    },
    header_region: null,
    body_regions: [],
    undefineds: [
      {
        path: "layout_family",
        reason: detail,
        severity: "blocking",
        fallback: "manual_select_family"
      }
    ],
    debug: {
      model,
      prompt_version: PROMPT_VERSION,
      confidence
    }
  };
}

function classifySkeletonFromSignals(text: string): { response: SkeletonLayoutResponse; ocr: OcrSignals } {
  const ocr = extractOcrSignals(text);
  const layout = extractLayoutSignals(text, ocr);
  const forceLowConfidence = /LOW_CONFIDENCE/i.test(text);

  const looksLikeWordProblemChoice =
    ocr.question_count >= 2 && ocr.choice_token_count >= 4 && ocr.select_phrase_hit;

  if (looksLikeWordProblemChoice) {
    return {
      response: buildUnknown(
        "not_supported_in_v1",
        "word_problem_with_choice_pattern_detected",
        0.25
      ),
      ocr
    };
  }

  if ((layout.stable_two_column_cluster && !ocr.slot_phrase_hit) || (!layout.stable_two_column_cluster && ocr.slot_phrase_hit)) {
    return {
      response: buildUnknown("ambiguous", "ocr_layout_signals_conflict", 0.5),
      ocr
    };
  }

  if (!layout.stable_two_column_cluster || !ocr.slot_phrase_hit) {
    return {
      response: buildUnknown("insufficient_signals", "missing_required_two_column_signals", 0.45),
      ocr
    };
  }

  const confidence = forceLowConfidence ? 0.7 : 0.8;
  if (confidence < CONFIDENCE_THRESHOLD) {
    return {
      response: buildUnknown("low_confidence", "below_confidence_threshold", confidence),
      ocr
    };
  }

  return {
    response: {
      spec_version: "layout_skeleton_v1",
      layout_family: "two_column_rows",
      slot_schema: {
        type: "mark_slots",
        mark_shape: "circle",
        rows: Math.max(2, layout.row_count),
        cols: 2
      },
      header_region: { x: 0.05, y: 0.04, w: 0.9, h: 0.12 },
      body_regions: buildBodyRegions(layout.row_count),
      undefineds: [],
      debug: {
        model: MODEL_NAME,
        prompt_version: PROMPT_VERSION,
        confidence
      }
    },
    ocr
  };
}

type VisionClassifyResult = {
  family: "two_column_rows" | "unknown";
  rows: number;
  cols: number;
  confidence: number;
  reason: string;
};

function mimeFromInput(base64: string): string {
  const m = base64.match(/^data:([^;,]+)[;,]/);
  return m?.[1] ?? "image/png";
}

async function classifyFromImageWithGemini(imageBase64: string): Promise<VisionClassifyResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const payload = imageBase64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  if (!payload) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const prompt = [
      "Classify worksheet skeleton family.",
      "Return ONLY JSON:",
      '{"family":"two_column_rows|unknown","rows":3,"cols":10,"confidence":0.0,"reason":"short"}',
      "Rules:",
      "- Choose two_column_rows ONLY when this is clearly a mark-slots worksheet with multiple numbered rows and circle answer slots.",
      "- Word-problem + choices sheet must be unknown.",
      "- If uncertain, return unknown."
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

    const parsed = JSON.parse(text) as Partial<VisionClassifyResult>;
    if (parsed.family !== "two_column_rows" && parsed.family !== "unknown") return null;

    return {
      family: parsed.family,
      rows: Math.max(1, Math.floor(parsed.rows ?? 1)),
      cols: Math.max(1, Math.floor(parsed.cols ?? 1)),
      confidence: clamp01(parsed.confidence ?? 0),
      reason: String(parsed.reason ?? "vision_no_reason")
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOrUnknown(candidate: unknown): SkeletonLayoutResponse {
  const parsed = skeletonLayoutResponseSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }
  return buildUnknown("insufficient_signals", "response_normalization_failed", 0);
}

extractSkeletonLayoutRouter.post("/", async (req, res) => {
  const requestId = randomUUID();

  const reqParsed = skeletonLayoutRequestSchema.safeParse(req.body);
  const rawText = reqParsed.success ? decodeBase64Text(reqParsed.data.image_base64) : "";
  const readable = looksReadableText(rawText);
  let classified = !reqParsed.success
    ? { response: buildUnknown("insufficient_signals", "invalid_request_schema", 0), ocr: extractOcrSignals("") }
    : !readable
    ? {
        response: buildUnknown("not_supported_in_v1", "matching_task_not_supported_in_v1", 0.3),
        ocr: extractOcrSignals("")
      }
    : classifySkeletonFromSignals(rawText);

  if (reqParsed.success && !readable) {
    const vision = await classifyFromImageWithGemini(reqParsed.data.image_base64);
    if (vision && vision.family === "two_column_rows" && vision.confidence >= CONFIDENCE_THRESHOLD) {
      classified = {
        response: {
          spec_version: "layout_skeleton_v1",
          layout_family: "two_column_rows",
          slot_schema: {
            type: "mark_slots",
            mark_shape: "circle",
            rows: vision.rows,
            cols: vision.cols
          },
          header_region: { x: 0.05, y: 0.04, w: 0.9, h: 0.12 },
          body_regions: buildBodyRegions(vision.rows),
          undefineds: [],
          debug: {
            model: `gemini_vision:${GEMINI_MODEL}`,
            prompt_version: PROMPT_VERSION,
            confidence: vision.confidence
          }
        },
        ocr: extractOcrSignals("")
      };
    } else if (vision && vision.family === "unknown") {
      classified = {
        response: buildUnknown(
          "not_supported_in_v1",
          vision.reason || "vision_unknown",
          vision.confidence,
          `gemini_vision:${GEMINI_MODEL}`
        ),
        ocr: extractOcrSignals("")
      };
    }
  }

  const normalized = normalizeOrUnknown(classified.response);

  console.log(
    JSON.stringify({
      event: "extract_skeleton_layout",
      request_id: requestId,
      detected_signals: {
        question_count: classified.ocr.question_count,
        choice_token_count: classified.ocr.choice_token_count,
        select_phrase_hit: classified.ocr.select_phrase_hit
      },
      chosen_family: normalized.layout_family,
      unknown_reason: normalized.unknown_reason,
      confidence: normalized.debug.confidence,
      undefined_count: normalized.undefineds.length
    })
  );

  return res.status(200).json(normalized);
});

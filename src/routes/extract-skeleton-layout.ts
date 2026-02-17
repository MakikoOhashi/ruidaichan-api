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

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function buildUnknown(reason: string): SkeletonLayoutResponse {
  return {
    spec_version: "layout_skeleton_v1",
    layout_family: "unknown",
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
        reason,
        severity: "blocking",
        fallback: "unknown"
      }
    ],
    debug: {
      model: MODEL_NAME,
      prompt_version: PROMPT_VERSION,
      confidence: 0
    }
  };
}

function looksLikeBase64(input: string): boolean {
  if (input.length < 64) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(input);
}

function heuristicFromImage(imageBase64: string): SkeletonLayoutResponse {
  if (!looksLikeBase64(imageBase64)) {
    return buildUnknown("image_base64_invalid_or_too_short");
  }

  const rows = 3;
  const cols = 2;
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

  return {
    spec_version: "layout_skeleton_v1",
    layout_family: "two_column_rows",
    slot_schema: {
      type: "mark_slots",
      mark_shape: "circle",
      rows,
      cols
    },
    header_region: { x: 0.05, y: 0.04, w: 0.9, h: 0.12 },
    body_regions: bodyRegions,
    undefineds: [],
    debug: {
      model: MODEL_NAME,
      prompt_version: PROMPT_VERSION,
      confidence: 0.72
    }
  };
}

function normalizeOrUnknown(candidate: unknown): SkeletonLayoutResponse {
  const parsed = skeletonLayoutResponseSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }
  return buildUnknown("response_normalization_failed");
}

extractSkeletonLayoutRouter.post("/", async (req, res) => {
  const requestId = randomUUID();

  const reqParsed = skeletonLayoutRequestSchema.safeParse(req.body);
  const candidate = reqParsed.success
    ? heuristicFromImage(reqParsed.data.image_base64)
    : buildUnknown("invalid_request_schema");

  const normalized = normalizeOrUnknown(candidate);

  console.log(
    JSON.stringify({
      event: "extract_skeleton_layout",
      request_id: requestId,
      layout_family: normalized.layout_family,
      rows: normalized.slot_schema.rows,
      cols: normalized.slot_schema.cols,
      undefined_count: normalized.undefineds.length,
      confidence: normalized.debug.confidence
    })
  );

  return res.status(200).json(normalized);
});

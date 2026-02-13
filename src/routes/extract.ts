import { Router } from "express";
import { extractWithGemini } from "../providers/gemini.js";
import {
  extractRequestSchema,
  extractResponseSchema,
  type ExtractResponse
} from "../schemas/extract.js";

export const extractRouter = Router();

const fallbackResponse: ExtractResponse = {
  template_id: "nencho_count_multi_v1",
  subquestion_count: 3,
  items_hint: [
    { category: "fruit", object_hint: "apple", count_range: [3, 10] },
    { category: "stationery", object_hint: "ruler", count_range: [3, 10] }
  ],
  confidence: 0.8
};

extractRouter.post("/", async (req, res) => {
  const parsed = extractRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      details: parsed.error.flatten()
    });
  }

  try {
    const extracted = await extractWithGemini(parsed.data);
    return res.status(200).json(extractResponseSchema.parse(extracted));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error(`[extract] fallback used: ${message}`);
    return res.status(200).json(fallbackResponse);
  }
});

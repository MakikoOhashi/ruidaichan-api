import { z } from "zod";

export const MAX_OCR_TEXT_LENGTH = 20000;

const gradeSchema = z.enum([
  "nencho",
  "nensho",
  "nenchu",
  "shogaku1",
  "shogaku2",
  "shogaku3",
  "shogaku4",
  "shogaku5",
  "shogaku6"
]);

export const extractRequestSchema = z.object({
  ocr_text: z.string().min(1).max(MAX_OCR_TEXT_LENGTH),
  locale: z.string().min(2).max(16).default("ja-JP"),
  hint: z
    .object({
      grade: gradeSchema.optional()
    })
    .optional()
}).strict();

export type ExtractRequest = z.infer<typeof extractRequestSchema>;

const countRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([min, max]) => min <= max, "count_range_min_must_be_lte_max");

export const extractResponseSchema = z.object({
  template_id: z.string(),
  confidence: z.number().min(0).max(1),
  items: z.array(
    z.object({
      slot: z.string().min(1),
      category: z.string(),
      count_range: countRangeSchema
    }).strict()
  ),
  scene: z
    .object({
      categories: z.array(z.string()),
      total_count_range: countRangeSchema
    })
    .strict(),
  debug: z
    .object({
      raw_ocr_hash: z.string().length(64),
      normalized_text_hash: z.string().length(64),
      model: z.string(),
      prompt_version: z.string()
    })
    .strict()
}).strict();

export type ExtractResponse = z.infer<typeof extractResponseSchema>;

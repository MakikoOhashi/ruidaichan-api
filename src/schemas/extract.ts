import { z } from "zod";

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
  ocr_text: z.string().min(1).max(20000),
  locale: z.string().min(2).max(16).default("ja-JP"),
  hint: z
    .object({
      grade: gradeSchema.optional()
    })
    .optional()
});

export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const extractResponseSchema = z.object({
  template_id: z.string(),
  subquestion_count: z.number().int().nonnegative(),
  items_hint: z.array(
    z.object({
      category: z.string(),
      object_hint: z.string(),
      count_range: z.tuple([z.number().int(), z.number().int()])
    })
  ),
  confidence: z.number().min(0).max(1)
});

export type ExtractResponse = z.infer<typeof extractResponseSchema>;

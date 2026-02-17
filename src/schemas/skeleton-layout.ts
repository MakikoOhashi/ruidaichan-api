import { z } from "zod";

const norm01 = z.number().min(0).max(1);

export const skeletonLayoutRequestSchema = z
  .object({
    image_base64: z.string().min(1),
    locale: z.string().min(2).max(16).default("ja-JP")
  })
  .strict();

export const rectSchema = z
  .object({
    x: norm01,
    y: norm01,
    w: norm01,
    h: norm01
  })
  .strict();

export const undefinedEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
    severity: z.enum(["info", "blocking"]),
    fallback: z.string().nullable()
  })
  .strict();

export const skeletonLayoutResponseSchema = z
  .object({
    spec_version: z.literal("layout_skeleton_v1"),
    layout_family: z.enum(["two_column_rows", "unknown"]),
    slot_schema: z
      .object({
        type: z.literal("mark_slots"),
        mark_shape: z.literal("circle"),
        rows: z.number().int().min(1),
        cols: z.number().int().min(1)
      })
      .strict(),
    header_region: rectSchema.nullable(),
    body_regions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            role: z.enum(["question_panel", "answer_panel"]),
            rect: rectSchema
          })
          .strict()
      )
      .default([]),
    undefineds: z.array(undefinedEntrySchema).default([]),
    debug: z
      .object({
        model: z.string(),
        prompt_version: z.string(),
        confidence: z.number().min(0).max(1)
      })
      .strict()
  })
  .strict();

export type SkeletonLayoutResponse = z.infer<typeof skeletonLayoutResponseSchema>;

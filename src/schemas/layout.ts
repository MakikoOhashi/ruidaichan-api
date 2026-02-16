import { z } from "zod";

export const undefinedEntrySchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  severity: z.enum(["blocking", "degraded", "info"]),
  fallback: z.string().min(1)
}).passthrough();

const sectionSchema = z.object({
  section_id: z.string().optional(),
  type: z.string().optional()
}).passthrough();

export const worksheetDslSchema = z.object({
  spec_version: z.literal("worksheet_dsl_v1"),
  content: z.object({
    sections: z.array(sectionSchema).default([])
  }).passthrough(),
  undefineds: z.array(undefinedEntrySchema).default([]),
  debug: z.object({
    model: z.string().optional(),
    prompt_version: z.string().default("layout_v1"),
    confidence: z.number().min(0).max(1).optional()
  }).passthrough().optional()
}).passthrough();

export type WorksheetDsl = z.infer<typeof worksheetDslSchema>;

import { z } from "zod";

export const problemFamilySchema = z.enum([
  "a_plus_blank_eq_b",
  "blank_plus_a_eq_b",
  "a_plus_b_eq_blank",
  "b_minus_a_eq_blank",
  "compare_totals_diff_mc",
  "times_scale_mc"
]);

export const difficultySchema = z.enum(["easy", "same", "hard"]);
export const detectedModeSchema = z.enum(["equation", "word_problem", "unknown"]);

export const renderItemSchema = z.union([
  z
    .object({
      type: z.literal("prompt"),
      slot: z.literal("stem"),
      text: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal("expression"),
      slot: z.literal("expr"),
      text: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal("blank"),
      slot: z.literal("expr_blank"),
      symbol: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal("choices"),
      slot: z.literal("options"),
      style: z.literal("mc"),
      choices: z.array(z.string().min(1)).min(2),
      correct_index: z.number().int().min(0)
    })
    .strict()
]);

export const microGenerateRequestSchema = z
  .object({
    image_base64: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    N: z.union([z.literal(4), z.literal(5), z.literal(10)]),
    difficulty: difficultySchema,
    seed: z.union([z.string().min(1), z.number().int()])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.image_base64 && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "image_base64_or_text_required"
      });
    }
  });

export const microProblemDslSchema = z
  .object({
    spec_version: z.literal("micro_problem_dsl_v1"),
    family: problemFamilySchema,
    params: z.record(z.union([z.number().int(), z.string(), z.array(z.string())])),
    render_text: z.string().min(1),
    answer: z.number().int(),
    detected_mode: detectedModeSchema,
    intent: z.string().min(1),
    required_items: z.array(z.enum(["prompt", "choices", "expression"])),
    items: z.array(renderItemSchema)
  })
  .strict();

export const detectedSchema = z
  .object({
    family: z.union([problemFamilySchema, z.literal("unknown")]),
    confidence: z.number().min(0).max(1),
    parsed_example: microProblemDslSchema.nullable()
  })
  .strict();

export const microGenerateResponseSchema = z
  .object({
    spec_version: z.literal("micro_problem_render_v1"),
    request_id: z.string().min(1),
    schema_version: z.literal("micro_generate_response_v1"),
    detected_mode: detectedModeSchema,
    intent: z.string().min(1),
    confidence: z.number().min(0).max(1),
    required_items: z.array(z.enum(["prompt", "choices", "expression"])),
    items: z.array(renderItemSchema),
    detected: detectedSchema,
    problems: z.array(microProblemDslSchema),
    rejected_count: z.number().int().nonnegative(),
    reasons: z.record(z.number().int().nonnegative()),
    need_confirm: z.boolean(),
    confirm_choices: z.array(problemFamilySchema).optional(),
    debug: z
      .object({
        deploy_commit: z.string(),
        build_timestamp: z.string(),
        selected_detector_path: z.string()
      })
      .strict()
      .optional(),
    meta: z
      .object({
        family: z.string(),
        count_policy: z.string(),
        max_count: z.number().int().positive(),
        applied_count: z.number().int().nonnegative(),
        note: z.string(),
        seed: z.string().optional(),
        sha: z.string().optional()
      })
      .strict()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.need_confirm && (!value.confirm_choices || value.confirm_choices.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirm_choices_required_when_need_confirm_true"
      });
    }

    if (!value.need_confirm && value.confirm_choices !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirm_choices_must_be_omitted_when_need_confirm_false"
      });
    }
  });

export type ProblemFamily = z.infer<typeof problemFamilySchema>;
export type Difficulty = z.infer<typeof difficultySchema>;
export type MicroProblemDsl = z.infer<typeof microProblemDslSchema>;

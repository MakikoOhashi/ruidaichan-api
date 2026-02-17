import { z } from "zod";

export const problemFamilySchema = z.enum([
  "a_plus_blank_eq_b",
  "blank_plus_a_eq_b",
  "a_plus_b_eq_blank",
  "b_minus_a_eq_blank",
  "compare_totals_diff_mc"
]);

export const difficultySchema = z.enum(["easy", "same", "hard"]);

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
    params: z.record(z.number().int()),
    render_text: z.string().min(1),
    answer: z.number().int()
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
    request_id: z.string().min(1),
    schema_version: z.literal("micro_generate_response_v1"),
    detected: detectedSchema,
    problems: z.array(microProblemDslSchema),
    rejected_count: z.number().int().nonnegative(),
    reasons: z.record(z.number().int().nonnegative()),
    need_confirm: z.boolean(),
    confirm_choices: z.array(problemFamilySchema).optional()
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

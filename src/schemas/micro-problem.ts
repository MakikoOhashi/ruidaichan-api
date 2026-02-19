import { z } from "zod";

export const problemFamilySchema = z.enum([
  "a_plus_blank_eq_b",
  "blank_plus_a_eq_b",
  "a_plus_b_eq_blank",
  "b_minus_a_eq_blank",
  "a_plus_b_minus_c_eq_blank",
  "compare_totals_diff_mc",
  "times_scale_mc"
]);

export const difficultySchema = z.enum(["easy", "same", "hard"]);
export const detectedModeSchema = z.enum(["equation", "word_problem", "unknown"]);
const inferenceLevelSchema = z.enum(["strict", "soft", "unknown"]);
const candidateSourceSchema = z.enum(["deterministic", "heuristic", "ai_assist"]);
const inputFormSchema = z.enum(["equation_like", "word_problem_like", "unknown_like"]);

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
    inference_level: inferenceLevelSchema,
    input_form: inputFormSchema,
    intent_candidates: z.array(
      z
        .object({
          intent: z.string().min(1),
          detected_mode: detectedModeSchema,
          confidence: z.number().min(0).max(1),
          source_stage: candidateSourceSchema
        })
        .strict()
    ),
    semantic_frame: z
      .object({
        spec_version: z.literal("semantic_frame_v1"),
        givens: z.array(
          z
            .object({
              name: z.string().min(1),
              value: z.number(),
              unit: z.string().optional()
            })
            .strict()
        ),
        relations: z.array(
          z
            .object({
              type: z.enum(["add", "subtract", "multiply", "divide", "repeat_multiply", "compare_diff", "scale_times"]),
              args: z.array(z.string().min(1))
            })
            .strict()
        ),
        ask: z
          .object({
            target: z.string().min(1),
            unit: z.string().optional()
          })
          .strict(),
        constraints: z.object({ grade_band: z.literal("g1_g3") }).strict(),
        confidence: z.number().min(0).max(1)
      })
      .nullable(),
    frame_candidates_count: z.number().int().nonnegative(),
    equation_candidates_count: z.number().int().nonnegative(),
    candidate_count: z.number().int().nonnegative(),
    selected_candidate_source: candidateSourceSchema,
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
        input_mode: z.enum(["text", "image", "none"]),
        selected_detector_path: z.string(),
        detector_fallback_reason: z.string().nullable(),
        image_bytes_length: z.number().int().nonnegative(),
        mime_type: z.string(),
        model_name: z.string(),
        model_http_status: z.number().int().nullable(),
        ocr_line_count: z.number().int().nonnegative(),
        ocr_primary_engine: z.enum(["vision", "tesseract", "none"]),
        ocr_primary_line_count: z.number().int().nonnegative(),
        keyword_hits: z.number().int().nonnegative(),
        parse_candidates_count: z.number().int().nonnegative(),
        prompt_verb: z.string().nullable(),
        prompt_unit: z.string().nullable(),
        lexicon_version: z.string(),
        input_form: inputFormSchema,
        input_form_score: z
          .object({
            equation_like: z.number(),
            word_problem_like: z.number()
          })
          .strict(),
        parse_stage_selected: z.enum(["local_ocr_regex", "ai_refine", "unknown"]),
        local_regex_hit: z.boolean(),
        equation_regex_hit: z.boolean(),
        equation_normalized_text: z.string(),
        equation_compact_text: z.string(),
        equation_candidate_source: z.enum(["detector_text", "ocr_lines", "raw_ocr", "none"]),
        equation_candidate_length: z.number().int().nonnegative(),
        correction_stage_selected: z.enum(["deterministic", "ai_assist", "none"]),
        equation_candidate_before: z.string(),
        equation_candidate_after: z.string(),
        blank_missing_detected: z.boolean(),
        blank_missing_rewritten: z.boolean(),
        blank_confusion_detected: z.boolean(),
        blank_confusion_original: z.string().nullable(),
        blank_confusion_rewritten: z.string().nullable(),
        correction_confidence: z.number().min(0).max(1).nullable(),
        binary_candidate_rejected: z.boolean(),
        binary_reject_reason: z.string().nullable(),
        normalize_input_empty: z.boolean(),
        unknown_reason: z.string().nullable(),
        candidate_count: z.number().int().nonnegative(),
        fail_reasons_by_stage: z.record(z.array(z.string())),
        normalized_text: z.string()
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
        sha: z.string().optional(),
        request_hash: z.string().optional(),
        detector_version: z.string().optional(),
        fallback_count: z.number().int().nonnegative().optional(),
        inference_latency_ms: z.number().int().nonnegative().optional(),
        theme_id: z.string().optional(),
        theme_candidates: z.array(z.string()).optional(),
        theme_policy: z.literal("seed_deterministic").optional()
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

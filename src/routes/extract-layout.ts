import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { extractRequestSchema } from "../schemas/extract.js";
import { worksheetDslSchema, type WorksheetDsl } from "../schemas/layout.js";

export const extractLayoutRouter = Router();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function buildFixedLayoutDsl(input: { rawOcr: string; normalized: string }): WorksheetDsl {
  return {
    spec_version: "worksheet_dsl_v1",
    document: {
      doc_id: randomUUID(),
      source: {
        input_type: "text",
        source_hash: sha256(input.rawOcr),
        pages: 1,
        language: "ja"
      },
      page: {
        size: "A4",
        orientation: "portrait",
        writing_direction: "horizontal",
        margin_profile: "unknown"
      }
    },
    capabilities: {
      can_render_pdf: true,
      can_generate_new_content: true,
      can_extract_layout_from_image: "partial",
      can_extract_geometry_from_image: "none"
    },
    layout: {
      root: {
        node_type: "Stack",
        params: { axis: "vertical", count: 3, gap: "standard" },
        children: ["header", "questions", "answers"]
      },
      regions: [
        { id: "header", role: "instruction", node: { node_type: "Block", params: {}, children: [] }, style: {} },
        { id: "questions", role: "questions", node: { node_type: "Stack", params: { axis: "vertical" }, children: [] }, style: {} },
        { id: "answers", role: "answers", node: { node_type: "Stack", params: { axis: "vertical" }, children: [] }, style: {} }
      ]
    },
    content: {
      header: {
        exists: true,
        elements: {
          page_label: "undefined",
          title: "undefined",
          name_field: { exists: true, label: "なまえ" },
          score_field: { exists: false, label: "undefined" },
          notes: [{ text: "もんだいを よんで こたえましょう。", emphasis: "none", ruby: false }]
        }
      },
      sections: [
        {
          section_id: "sec1",
          label: "1",
          type: "mc_blank_arithmetic",
          instruction: {
            text: "しきの □ に あてはまる かずを えらびましょう。",
            position_hint: "top"
          },
          task: {
            task_type: "select",
            answer_submission: "in_sheet"
          },
          items: [
            {
              item_id: "1",
              label: "(1)",
              stem: {
                stem_type: "equation_blank",
                text: "3 + 4 = □",
                equation: { op: "+", a: 3, b: 4, blank: "rhs" }
              },
              scene_ref: "undefined",
              choices: [
                { label: "①", value: 6 },
                { label: "②", value: 7 },
                { label: "③", value: 8 }
              ],
              answer_ui: { ui_type: "choice_circle", max_count: 3, select_count: 1 }
            }
          ]
        }
      ]
    },
    constraints: {
      learner_level: {
        grade_hint: "lower_elementary",
        language_level: "mixed"
      },
      generation: {
        reuse_original_text: false,
        allow_new_theme: true,
        difficulty_control: "client_logic"
      }
    },
    undefineds: [],
    extensions: {
      raw_ocr: input.normalized,
      raw_layout_detection: "optional",
      vendor_specific: {}
    },
    debug: {
      model: "fixed_layout_stub",
      prompt_version: "layout_v1_stub_2026-02-16",
      confidence: 0.65
    }
  };
}

extractLayoutRouter.post("/", async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();

  const parsed = extractRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      request_id: requestId,
      details: parsed.error.flatten()
    });
  }

  const normalizedText = normalizeText(parsed.data.ocr_text);
  const candidate = buildFixedLayoutDsl({ rawOcr: parsed.data.ocr_text, normalized: normalizedText });
  const validated = worksheetDslSchema.safeParse(candidate);

  if (!validated.success) {
    return res.status(500).json({
      error: "internal_response_invalid",
      request_id: requestId
    });
  }

  console.log(
    JSON.stringify({
      event: "extract_layout_success",
      request_id: requestId,
      ocr_text_hash: sha256(parsed.data.ocr_text),
      spec_version: validated.data.spec_version,
      section_types: (validated.data.content?.sections ?? []).map((s) => s.type ?? "unknown"),
      latency_ms: Date.now() - startedAt
    })
  );

  return res.status(200).json(validated.data);
});

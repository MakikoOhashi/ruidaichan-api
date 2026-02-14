import { TEMPLATE_CONTRACT, normalizeTemplateId } from "../config/template-contract.js";
import type { ExtractResponse } from "../schemas/extract.js";

type ProviderCandidate = {
  template_id: string;
  confidence: number;
  items: Array<{
    slot?: string;
    category: string;
    count_range: [number, number];
  }>;
  scene?: {
    categories: string[];
    total_count_range: [number, number];
  };
};

type BuildInput = {
  candidate: ProviderCandidate;
  model: string;
  rawOcrHash: string;
  normalizedTextHash: string;
};

export function buildStableExtractResponse(input: BuildInput): ExtractResponse {
  const template = normalizeTemplateId(input.candidate.template_id);

  const items = input.candidate.items.map((item, index) => ({
    slot: item.slot ?? `slot_${index + 1}`,
    category: item.category,
    count_range: item.count_range
  }));

  const scene = input.candidate.scene ?? {
    categories: Array.from(new Set(items.map((item) => item.category))),
    total_count_range: items.reduce<[number, number]>(
      (acc, item) => [acc[0] + item.count_range[0], acc[1] + item.count_range[1]],
      [0, 0]
    )
  };

  return {
    template_id: template.normalized_template_id,
    confidence: input.candidate.confidence,
    items,
    scene,
    debug: {
      raw_ocr_hash: input.rawOcrHash,
      normalized_text_hash: input.normalizedTextHash,
      model: input.model,
      prompt_version: TEMPLATE_CONTRACT.prompt_version,
      raw_template_id: template.raw_template_id,
      normalized_template_id: template.normalized_template_id,
      normalization_reason: template.normalization_reason
    }
  };
}

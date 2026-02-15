import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CONTRACT_VERSION = "extract_contract_v1_2026-02-15";

const templateContractSchema = z
  .object({
    contract_version: z.string().min(1),
    default_template_id: z.string().min(1),
    allowed_template_ids: z.array(z.string().min(1)).min(1),
    prompt_version: z.string().min(1)
  })
  .strict()
  .refine(
    (data) => data.allowed_template_ids.includes(data.default_template_id),
    "default_template_id_must_be_in_allowed_template_ids"
  );

type TemplateContract = z.infer<typeof templateContractSchema>;

function loadTemplateContract(): TemplateContract {
  const contractPath = path.resolve(process.cwd(), "contracts/template_ids.json");
  const raw = readFileSync(contractPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return templateContractSchema.parse(parsed);
}

export const TEMPLATE_CONTRACT = loadTemplateContract();

export type TemplateNormalizationReason = "allowed" | "not_allowed_fallback" | "alias_map";

export function normalizeTemplateId(templateId: string): {
  raw_template_id: string;
  normalized_template_id: string;
  normalization_reason: TemplateNormalizationReason;
} {
  if (TEMPLATE_CONTRACT.allowed_template_ids.includes(templateId)) {
    return {
      raw_template_id: templateId,
      normalized_template_id: templateId,
      normalization_reason: "allowed"
    };
  }
  return {
    raw_template_id: templateId,
    normalized_template_id: TEMPLATE_CONTRACT.default_template_id,
    normalization_reason: "not_allowed_fallback"
  };
}

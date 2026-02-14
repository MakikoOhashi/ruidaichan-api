import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const templateContractSchema = z
  .object({
    default_template_id: z.string().min(1),
    allowed_template_ids: z.array(z.string().min(1)).min(1),
    prompt_version: z.string().min(1)
  })
  .strict();

type TemplateContract = z.infer<typeof templateContractSchema>;

function loadTemplateContract(): TemplateContract {
  const contractPath = path.resolve(process.cwd(), "contracts/template_ids.json");
  const raw = readFileSync(contractPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return templateContractSchema.parse(parsed);
}

export const TEMPLATE_CONTRACT = loadTemplateContract();

export function normalizeTemplateId(templateId: string): string {
  if (TEMPLATE_CONTRACT.allowed_template_ids.includes(templateId)) {
    return templateId;
  }
  return TEMPLATE_CONTRACT.default_template_id;
}

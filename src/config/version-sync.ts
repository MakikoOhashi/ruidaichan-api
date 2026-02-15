import { PROMPT_VERSION } from "../providers/gemini.js";
import { CONTRACT_VERSION, TEMPLATE_CONTRACT } from "./template-contract.js";

export function assertVersionSync(): void {
  if (TEMPLATE_CONTRACT.contract_version !== CONTRACT_VERSION) {
    throw new Error(
      `contract_version_mismatch: expected=${CONTRACT_VERSION} actual=${TEMPLATE_CONTRACT.contract_version}`
    );
  }

  if (TEMPLATE_CONTRACT.prompt_version !== PROMPT_VERSION) {
    throw new Error(
      `prompt_version_mismatch: contract=${TEMPLATE_CONTRACT.prompt_version} prompt=${PROMPT_VERSION}`
    );
  }
}

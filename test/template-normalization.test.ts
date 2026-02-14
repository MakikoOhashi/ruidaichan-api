import test from "node:test";
import assert from "node:assert/strict";
import { buildStableExtractResponse } from "../src/services/extract-response.js";

test("unsupported template_id falls back to default and debug fields are populated", () => {
  const response = buildStableExtractResponse({
    candidate: {
      template_id: "count_worksheets",
      confidence: 0.75,
      items: [{ category: "fruit", count_range: [3, 10] }]
    },
    model: "gemini-2.0-flash",
    rawOcrHash: "a".repeat(64),
    normalizedTextHash: "b".repeat(64)
  });

  assert.equal(response.template_id, "nencho_count_multi_v1");
  assert.equal(response.debug.raw_template_id, "count_worksheets");
  assert.equal(response.debug.normalized_template_id, "nencho_count_multi_v1");
  assert.equal(response.debug.normalization_reason, "not_allowed_fallback");
});

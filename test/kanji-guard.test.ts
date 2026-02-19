import assert from "node:assert/strict";
import test from "node:test";
import {
  checkKanjiGuard,
  estimateGradeBand,
  normalizeRequestedGradeBand,
  sameNumberTokens
} from "../src/guards/kanji-guard.js";

test("normalizeRequestedGradeBand handles explicit and legacy values", () => {
  assert.equal(normalizeRequestedGradeBand("g1"), "g1");
  assert.equal(normalizeRequestedGradeBand("g2_g3"), "g2_g3");
  assert.equal(normalizeRequestedGradeBand("g1_g3"), null);
  assert.equal(normalizeRequestedGradeBand(undefined), null);
});

test("estimateGradeBand falls to g2_g3 on multiplication signals", () => {
  const band = estimateGradeBand({
    ocrText: "毎日3こずつあめをたべます",
    drafts: [{ prompt: "2倍のかずをもとめよう", choices: ["2", "3", "4", "5", "6"] }]
  });
  assert.equal(band, "g2_g3");
});

test("kanji guard rejects disallowed g1 kanji but allows g2_g3", () => {
  const sample = {
    prompt: "けいさんの練習をします。",
    choices: ["1こ", "2こ", "3こ", "4こ", "5こ"]
  };
  const g1 = checkKanjiGuard(sample, "g1");
  const g23 = checkKanjiGuard(sample, "g2_g3");
  assert.equal(g1.ok, false);
  assert.equal(g1.violations_count > 0, true);
  assert.equal(g23.ok, true);
});

test("sameNumberTokens ensures rewrite does not alter numbers", () => {
  const before = {
    prompt: "4月1日から4月5日までに何個ですか。",
    choices: ["6個", "8個", "10個", "12個", "14個"]
  };
  const afterOk = {
    prompt: "4がつ1にちから4がつ5にちまでになんこですか。",
    choices: ["6こ", "8こ", "10こ", "12こ", "14こ"]
  };
  const afterNg = {
    prompt: "4がつ1にちから4がつ6にちまでになんこですか。",
    choices: ["6こ", "8こ", "10こ", "12こ", "14こ"]
  };
  assert.equal(sameNumberTokens(before, afterOk), true);
  assert.equal(sameNumberTokens(before, afterNg), false);
});

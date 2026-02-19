import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GradeBandApplied = "g1" | "g2_g3";

type ProblemText = {
  prompt: string;
  choices: string[];
};

type Violation = {
  field: "prompt" | "choice";
  index?: number;
  chars: string[];
};

function loadAllowedKanji(fileName: string): Set<string> {
  const path = resolve(process.cwd(), "src", "resources", fileName);
  const raw = readFileSync(path, "utf-8");
  const chars = [...raw.replace(/\s+/g, "")].filter((ch) => /\p{Script=Han}/u.test(ch));
  return new Set(chars);
}

const allowedG1 = loadAllowedKanji("allowed-kanji-g1.txt");
const allowedG2G3 = loadAllowedKanji("allowed-kanji-g2g3.txt");

export function normalizeRequestedGradeBand(input?: string): GradeBandApplied | null {
  if (!input) return null;
  if (input === "g1") return "g1";
  if (input === "g2_g3") return "g2_g3";
  if (input === "g1_g3") return null;
  return null;
}

export function estimateGradeBand(input: { ocrText: string; drafts: ProblemText[] }): GradeBandApplied {
  const merged = `${input.ocrText}\n${input.drafts.map((d) => `${d.prompt}\n${d.choices.join("\n")}`).join("\n")}`;
  const hasMultiplicationSignals =
    /[×xX]/.test(merged) ||
    /倍/.test(merged) ||
    /毎日\s*\d+\s*(?:こ|個|本|まい|枚|ページ|分|回)\s*ずつ/.test(merged) ||
    /まいにち\s*\d+\s*(?:こ|個|本|まい|枚|ページ|ふん|回)\s*ずつ/.test(merged);

  return hasMultiplicationSignals ? "g2_g3" : "g1";
}

export function allowedKanjiForGrade(gradeBand: GradeBandApplied): Set<string> {
  return gradeBand === "g1" ? allowedG1 : allowedG2G3;
}

export function extractNumberTokens(text: string): string[] {
  return [...text.normalize("NFKC").matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

export function sameNumberTokens(before: ProblemText, after: ProblemText): boolean {
  const beforeTokens = [before.prompt, ...before.choices].flatMap((s) => extractNumberTokens(s));
  const afterTokens = [after.prompt, ...after.choices].flatMap((s) => extractNumberTokens(s));
  if (beforeTokens.length !== afterTokens.length) return false;
  return beforeTokens.every((t, i) => t === afterTokens[i]);
}

export function findDisallowedKanji(text: string, allowed: Set<string>): string[] {
  const found = new Set<string>();
  for (const ch of text.match(/\p{Script=Han}/gu) ?? []) {
    if (!allowed.has(ch)) found.add(ch);
  }
  return [...found];
}

export function checkKanjiGuard(problem: ProblemText, gradeBand: GradeBandApplied): {
  ok: boolean;
  violations_count: number;
  violations: Violation[];
} {
  const allowed = allowedKanjiForGrade(gradeBand);
  const violations: Violation[] = [];

  const promptViolations = findDisallowedKanji(problem.prompt, allowed);
  if (promptViolations.length > 0) {
    violations.push({ field: "prompt", chars: promptViolations });
  }

  problem.choices.forEach((choice, idx) => {
    const disallowed = findDisallowedKanji(choice, allowed);
    if (disallowed.length > 0) {
      violations.push({ field: "choice", index: idx, chars: disallowed });
    }
  });

  const violations_count = violations.reduce((acc, v) => acc + v.chars.length, 0);
  return {
    ok: violations.length === 0,
    violations_count,
    violations
  };
}

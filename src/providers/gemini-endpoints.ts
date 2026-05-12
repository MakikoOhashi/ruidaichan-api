export function buildGeminiGenerateContentUrls(input: { model: string; apiKey: string }): string[] {
  const key = encodeURIComponent(input.apiKey);
  const suffix = `models/${input.model}:generateContent?key=${key}`;

  const preferred = (process.env.GEMINI_API_VERSION ?? "v1beta").toLowerCase();
  const v1beta = `https://generativelanguage.googleapis.com/v1beta/${suffix}`;
  const v1 = `https://generativelanguage.googleapis.com/v1/${suffix}`;

  if (preferred === "v1") return [v1, v1beta];
  return [v1beta, v1];
}


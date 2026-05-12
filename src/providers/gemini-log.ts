function compactBody(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function redactApiKey(text: string): string {
  // Never log raw API keys. Gemini REST uses `?key=...`.
  return text.replace(/([?&]key=)[^&\s]+/g, "$1REDACTED");
}

export function logGeminiError(input: {
  event: string;
  requestId: string;
  url: string;
  status: number;
  bodyText: string;
  mode?: string;
}): void {
  // Use stdout so Render logs reliably capture the payload.
  console.log(
    JSON.stringify({
      event: input.event,
      request_id: input.requestId,
      status: input.status,
      url: redactApiKey(input.url),
      mode: input.mode ?? null,
      body: redactApiKey(compactBody(input.bodyText, 2000))
    })
  );
}

export function logGeminiTransportException(input: { event: string; requestId: string; error: unknown }): void {
  const name = input.error instanceof Error ? input.error.name : "unknown";
  const message = input.error instanceof Error ? input.error.message : "unknown_error";
  console.log(
    JSON.stringify({
      event: input.event,
      request_id: input.requestId,
      error_name: name,
      error_message: redactApiKey(message).slice(0, 300)
    })
  );
}

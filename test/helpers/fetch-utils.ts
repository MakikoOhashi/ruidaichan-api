type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export function getFetchUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

export async function getFetchBody(input: FetchInput, init?: FetchInit): Promise<string> {
  const body = init?.body;
  if (body != null) {
    if (typeof body === "string") return body;
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      return await new Response(body).text();
    }
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof Blob !== "undefined" && body instanceof Blob) return await body.text();
    if (typeof FormData !== "undefined" && body instanceof FormData) return "[formdata]";
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
    if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer).toString("utf8");
    return String(body);
  }
  if (input instanceof Request) {
    return await input.clone().text();
  }
  return "";
}

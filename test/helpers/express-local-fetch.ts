import http from "node:http";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { getFetchBody, getFetchUrl } from "./fetch-utils.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

class NullDuplex extends Duplex {
  _read(): void {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback(null);
  }
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    for (const [k, v] of headers.entries()) record[k.toLowerCase()] = v;
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) record[String(k).toLowerCase()] = String(v);
    return record;
  }
  for (const [k, v] of Object.entries(headers)) record[k.toLowerCase()] = String(v);
  return record;
}

function toResponseHeaders(raw: ReturnType<http.ServerResponse["getHeaders"]>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) h.set(k, v.map(String).join(", "));
    else h.set(k, String(v));
  }
  return h;
}

export function createExpressFetch(app: (req: http.IncomingMessage, res: http.ServerResponse) => void, baseUrl: string) {
  const base = new URL(baseUrl);

  return async function expressFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const url = new URL(getFetchUrl(input), base);
    if (url.origin !== base.origin) {
      throw new Error(`expressFetch received non-local URL: ${url.toString()}`);
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET") ?? "GET").toUpperCase();
    const headers = {
      ...toHeaderRecord(input instanceof Request ? input.headers : undefined),
      ...toHeaderRecord(init?.headers)
    };

    const bodyText = await getFetchBody(input, init);
    const bodyBuffer = bodyText === "" ? null : Buffer.from(bodyText, "utf8");

    const socket = new NullDuplex();
    (socket as unknown as { remoteAddress?: string }).remoteAddress = "127.0.0.1";

    const server = http.createServer(app);
    const req = new http.IncomingMessage(socket as unknown as http.Socket);
    req.method = method;
    req.url = `${url.pathname}${url.search}`;
    if (bodyBuffer && headers["content-length"] === undefined) {
      headers["content-length"] = String(bodyBuffer.length);
    }
    req.headers = headers;
    (req as unknown as { complete?: boolean }).complete = true;

    const res = new http.ServerResponse(req);
    res.assignSocket(socket as unknown as http.Socket);
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = ((chunk: any, encoding?: any, cb?: any) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      return origWrite(chunk, encoding, cb);
    }) as typeof res.write;
    res.end = ((chunk?: any, encoding?: any, cb?: any) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      return origEnd(chunk, encoding, cb);
    }) as typeof res.end;

    server.emit("request", req, res);
    setTimeout(() => {
      if (bodyBuffer) req.emit("data", bodyBuffer);
      req.emit("end");
    }, 0);
    await once(res, "finish");

    const body = Buffer.concat(chunks);
    return new Response(body, { status: res.statusCode, headers: toResponseHeaders(res.getHeaders()) });
  };
}

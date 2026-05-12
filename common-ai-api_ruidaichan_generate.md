# common-ai-api: `/ruidaichan/generate` 追加メモ

このリポジトリ（`ruidaichan-api`）ではなく、Cloudflare Worker の `common-ai-api` 側に AI gateway endpoint を追加する必要があります。

## 追加先

`/Users/makiko/Documents/Documents - makiko’s MacBook Air/dev/common-ai-api/src/index.ts`

## 要件（Todo.mdから）

- `POST /ruidaichan/generate` を追加
- 既存 `POST /ruidaichan/probe-gemini` と同じ認証（`x-app-id=ruidaichan` + `x-ai-gateway-secret`）
- CORS ヘッダーは付けない（`withCors()` を通さない）
- Gemini 呼び出しは `common-ai-api` から行う

## 実装方針（index.ts）

### 1) ルーティングを追加

`fetch()` 冒頭の path 判定に以下を追加：

```ts
const isRuidaichanGeneratePath = url.pathname === '/ruidaichan/generate';
```

`isRuidaichanProbeGeminiPath` の分岐の直後に、CORS を通さずにハンドラを呼ぶ分岐を追加：

```ts
if (isRuidaichanGeneratePath) {
  // Internal gateway endpoint: server-to-server only (no CORS headers by default).
  return await handleRuidaichanGenerate(request, env);
}
```

### 2) ハンドラ関数を追加

`handleRuidaichanProbeGemini` の近くに、以下の関数を追加（認証/JSONチェックは probe と同型）：

```ts
type RuidaichanGenerateBody = { request_id?: string; role?: string; payloadText?: string };

async function handleRuidaichanGenerate(request: Request, env: Env): Promise<Response> {
  const appId = request.headers.get('x-app-id')?.trim();
  const gatewaySecret = request.headers.get('x-ai-gateway-secret')?.trim();
  if (appId !== 'ruidaichan' || !gatewaySecret || gatewaySecret !== (env.RUIDAICHAN_AI_GATEWAY_SECRET || '')) {
    return json({ ok: false, provider: 'gemini', status: 401, error: { message: 'unauthorized', status: 'UNAUTHORIZED' } }, 401);
  }

  if (request.method !== 'POST') {
    return json({ ok: false, provider: 'gemini', status: 405, error: { message: 'method_not_allowed', status: 'METHOD_NOT_ALLOWED' } }, 405);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return json({ ok: false, provider: 'gemini', status: 400, error: { message: 'content_type_must_be_json', status: 'BAD_REQUEST' } }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, provider: 'gemini', status: 400, error: { message: 'invalid_json', status: 'BAD_REQUEST' } }, 400);
  }

  const parsed = body as Partial<RuidaichanGenerateBody> | null | undefined;
  const requestId =
    typeof parsed?.request_id === 'string' && parsed.request_id.trim() ? parsed.request_id.trim() : crypto.randomUUID();

  const role = typeof parsed?.role === 'string' ? parsed.role : '';
  if (role !== 'generator_v1') {
    return json({ ok: false, provider: 'gemini', status: 400, error: { message: 'invalid_role', status: 'BAD_REQUEST' } }, 400);
  }

  const payloadText = typeof parsed?.payloadText === 'string' ? parsed.payloadText : '';
  if (!payloadText.trim()) {
    return json({ ok: false, provider: 'gemini', status: 400, error: { message: 'payloadText_required', status: 'BAD_REQUEST' } }, 400);
  }

  const apiKey = env.GEMINI_API_KEY || '';
  if (!apiKey) {
    return json({ ok: false, provider: 'gemini', status: 500, error: { message: 'missing_gemini_api_key', status: 'INTERNAL' } }, 500);
  }

  const model = env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const upstreamResponse = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: payloadText }] }],
      generationConfig: { temperature: 0.6 },
    }),
  });

  if (!upstreamResponse.ok) {
    let payload: any = null;
    let fallbackText = '';
    try {
      payload = await upstreamResponse.json();
    } catch {
      fallbackText = (await upstreamResponse.text()).slice(0, 600);
    }
    const message = payload?.error?.message || fallbackText || 'gemini_failed';
    const status = payload?.error?.status || 'UPSTREAM_ERROR';
    logEvent('error', {
      event: 'ruidaichan_generate_failed',
      requestId,
      status: upstreamResponse.status,
      message: String(message).slice(0, 600),
      upstream_status: status,
    });
    return json({ ok: false, provider: 'gemini', status: upstreamResponse.status, error: { message: 'gemini_failed', status } }, upstreamResponse.status);
  }

  const payload = (await upstreamResponse.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    return json({ ok: false, provider: 'gemini', status: 502, error: { message: 'gemini_empty_text', status: 'BAD_GATEWAY' } }, 502);
  }

  // ruidaichan-api 側は `data` が string なら JSON としてパースする前提。
  return json({ ok: true, provider: 'gemini', status: 200, request_id: requestId, data: text }, 200);
}
```

## deploy / 動作確認（Todo.mdのまま）

```sh
cd "/Users/makiko/Documents/Documents - makiko’s MacBook Air/dev/common-ai-api"
npx wrangler deploy
```

```sh
curl -X POST "https://common-ai-api.makiron19831014.workers.dev/ruidaichan/generate" \
  -H "Content-Type: application/json" \
  -H "X-App-Id: ruidaichan" \
  -H "X-AI-Gateway-Secret: <secret>" \
  -d '{"request_id":"test","role":"generator_v1","payloadText":"Return {\"problems\":[{\"prompt\":\"1+1=?\"}]} as JSON only."}'
```


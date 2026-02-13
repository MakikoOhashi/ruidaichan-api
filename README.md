# ruidaichan-api

Extract-only stateless API for ruidaichan.

## Responsibilities

- Server: OCR text -> CountExtract (coarse)
- Client: CountExtract -> CountPlan (constraints) -> PDF
- No DB / no server state

## Endpoints

### GET /health

Returns health status.

Response:

```json
{ "ok": true }
```

### POST /extract

Requires header `x-api-key: <API_KEY>`.
Rate limit: 30 requests per minute per IP.
Uses Gemini (`GEMINI_API_KEY`) for extraction.

Request:

```json
{
  "ocr_text": "...",
  "locale": "ja-JP",
  "hint": { "grade": "nencho" }
}
```

Response (dummy):

```json
{
  "template_id": "nencho_count_multi_v1",
  "subquestion_count": 3,
  "items_hint": [
    { "category": "fruit", "object_hint": "apple", "count_range": [3, 10] },
    { "category": "stationery", "object_hint": "ruler", "count_range": [3, 10] }
  ],
  "confidence": 0.82
}
```

If Gemini times out/errors, API returns the fallback JSON above (HTTP 200).

## Local run

1. Install dependencies:

```bash
npm install
```

2. Create env:

```bash
cp .env.example .env
```

Required env vars:
- `API_KEY`: request auth key (`x-api-key`)
- `GEMINI_API_KEY`: Gemini API key
- optional: `GEMINI_MODEL` (default `gemini-2.0-flash`)
- optional: `GEMINI_TIMEOUT_MS` (default `8000`)

3. Start dev server:

```bash
npm run dev
```

## Render deploy

- `render.yaml` included.
- Set secret env var `API_KEY` in Render dashboard.
- Log policy: request metadata only (method/path/status/time). OCR text body is not logged.

## Architecture Boundary (Source of Truth)

This API only returns **coarse extraction candidates**.  
Final planning and layout decisions are owned by the iOS app.

- iOS: OCR, constraints, `CountPlan` finalization, template slot fill, PDF generation
- API: candidate extraction only (`/extract`)
- Template: fixed asset for deterministic rendering

See full responsibility flow:
- [ruidaichan architecture](https://github.com/MakikoOhashi/ruidaichan/blob/main/docs/architecture.md)

## アーキテクチャ境界（責務の正本）

このAPIは**粗い抽出候補**のみを返します。  
最終的な設計・レイアウト判断はiOSアプリ側の責務です。

- iOS: OCR、制約適用、`CountPlan` の最終確定、テンプレートスロット充填、PDF生成
- API: 候補抽出のみ（`/extract`）
- Template: 決定論的レンダリングのための固定アセット

責務フローの全体像:
- [ruidaichan architecture](https://github.com/MakikoOhashi/ruidaichan/blob/main/docs/architecture.md)

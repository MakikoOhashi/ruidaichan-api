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
  "confidence": 0.82,
  "items": [
    { "slot": "slot_1", "category": "fruit", "count_range": [3, 10] },
    { "slot": "slot_2", "category": "stationery", "count_range": [3, 10] }
  ],
  "scene": {
    "categories": ["fruit", "stationery"],
    "total_count_range": [6, 20]
  },
  "debug": {
    "raw_ocr_hash": "sha256 hex",
    "normalized_text_hash": "sha256 hex",
    "model": "gemini-2.0-flash",
    "prompt_version": "extract_v1_2026-02-15"
  }
}
```

If Gemini times out/errors/decode fails, API returns `502` with `request_id`.

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
- optional: `GEMINI_TEMPERATURE` (default `0.1`)

3. Start dev server:

```bash
npm run dev
```

## Render deploy

- `render.yaml` included.
- Set secret env var `API_KEY` in Render dashboard.
- Log policy: structured logs with `request_id`, `ocr_text_hash`, `template_id`, `confidence`, `latency_ms`, `error` classification.
- OCR raw text is not logged.

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

## Shared Contract

- `contracts/template_ids.json` is the source of truth for:
  - `default_template_id`
  - `allowed_template_ids`
  - `prompt_version`
- API normalizes model output template IDs before returning `/extract` response.

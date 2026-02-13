# ruidaichan-api

Extract-only stateless API for ruidaichan.

## Responsibilities

- Server: OCR text -> CountExtract (coarse)
- Client: CountExtract -> CountPlan (constraints) -> PDF
- No DB / no server state

## Endpoints

### POST /health

Returns health status.

Response:

```json
{ "ok": true, "service": "ruidaichan-api" }
```

### POST /extract

Requires header `x-api-key: <API_KEY>`.

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

## Local run

1. Install dependencies:

```bash
npm install
```

2. Create env:

```bash
cp .env.example .env
```

3. Start dev server:

```bash
npm run dev
```

## Render deploy

- `render.yaml` included.
- Set secret env var `API_KEY` in Render dashboard.
- Optionally set `CORS_ORIGIN` to your iOS app backend origin/proxy.

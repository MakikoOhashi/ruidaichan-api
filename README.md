# ruidaichan-api

小学校1〜3年の算数向けに、類題を返す stateless API です。  
本線は `POST /micro/generate_from_ocr` です。

## Current Architecture

- Server: 問題生成・軽量検証・描画向けJSON返却
- iOS: OCR取得・UI・PDF描画
- DBなし（stateless）
- 出力は `micro_problem_render_v1` 契約
- 選択肢は生成しない（`prompt`のみ返す）

## Endpoints

### GET `/health`

```json
{
  "ok": true,
  "deploy_commit": "...",
  "build_timestamp": "..."
}
```

### POST `/micro/generate_from_ocr` (main)

Header:

- `x-api-key: <API_KEY>`
- `x-install-id: <install_id>`（iOS Keychain 永続ID）

Request:

- `ocr_text` と `image_base64` のどちらか必須
- `ocr_text` がノイズの場合、`image_base64` があればAI OCRフォールバックを実行

```json
{
  "ocr_text": "...",
  "image_base64": "...",
  "image_mime_type": "image/jpeg",
  "count": 5,
  "difficulty": "easy|same|hard",
  "grade_band": "g1|g2_g3|g1_g3",
  "language": "ja",
  "seed": "12345"
}
```

Response (shape):

```json
{
  "spec_version": "micro_problem_render_v1",
  "schema_version": "micro_generate_from_ocr_response_v1",
  "detected_mode": "equation|word_problem|unknown",
  "required_items": ["prompt"],
  "items": [{ "type": "prompt", "slot": "stem", "text": "..." }],
  "problems": [
    {
      "prompt": "...",
      "required_items": ["prompt"],
      "items": [{ "type": "prompt", "slot": "stem", "text": "..." }]
    }
  ],
  "requested_count": 10,
  "applied_count": 5,
  "need_confirm": false,
  "reasons": {},
  "meta": {
    "note": "ok|partial_success|partial_success_timeout|unknown_no_viable_candidate|ok_ambiguous_unit_conversion|ok_count_capped_by_policy|quota_check_failed|problem_language_fallback",
    "seed": "...",
    "grade_band_applied": "g1|g2_g3",
    "difficulty_applied": "easy|standard|hard",
    "plan_id": "free|light|premium",
    "problem_language": "ja|en",
    "problem_language_source": "ocr|image|heuristic|fallback",
    "problem_language_confidence": 0.92,
    "failure_code": "none|ocr_input_unreadable|upstream_rate_limited|upstream_timeout|upstream_unavailable|server_misconfigured|generation_failed|unknown",
    "retryable": true,
    "quota_limit": 10,
    "quota_used_after": 3,
    "quota_reset_at": "2026-03-01T00:00:00.000Z",
    "count_policy": "server_enforced",
    "max_count": 5,
    "target_count": 5
  },
  "debug": {}
}
```

Quota exceeded response:

```json
{
  "error": "free_quota_exceeded",
  "request_id": "...",
  "plan_id": "free",
  "limit": 5,
  "used": 5,
  "reset_at": "2026-03-01T00:00:00.000Z"
}
```

### Other endpoints (legacy/aux)

- `POST /extract`
- `POST /extract_layout`
- `POST /extract_skeleton_layout`
- `POST /micro/generate`

## Decision Flow (`/micro/generate_from_ocr`)

1. 入力受付  
- `x-install-id` を検証（不正/欠落は 400）
- Redis 月次無料枠を先に消費（初月10 / 以降5）
- 上限超過は 429 `free_quota_exceeded`
- `ocr_text` があれば先に使用
- `ocr_text` が空/ノイジーで `image_base64` があれば AI OCR フォールバック

2. モード判定  
- `input_mode`: `equation` / `word_problem`

3. 問題言語判定  
- UI language ではなく、`ocr_text` / `image_base64` から `problem_language` を推定
- v1 は `ja` / `en` のみ
- OCRが弱いときだけ画像補助判定を実行
- 判定不能時は `ja` fallback + `meta.note=problem_language_fallback`

4. 式トラック判定（equation時）  
- `arithmetic`
- `unit_conversion_pure`
- `unit_conversion_calc`

5. difficulty適用  
- 共通 difficulty（`easy` / `same` / `hard`）を内部に正規化
- `same` は内部的に `standard` として扱う
- 難易度は生成プロンプトの指示差分で調整（厳格な数値レバーは使わない）

6. 生成（AI）  
- promptのみ生成（選択肢なし）
- 生成言語は `meta.problem_language` に従う

7. 軽量フィルタ  
- モード整合
- カテゴリ整合
- 演算子ヒント整合（例: 掛け算入力は掛け算問題を優先）
- 単位ドメイン整合（length / volume / weight）
- 式表記整合（右辺回答は `=` 終端、式中未知数のみ `□`）

8. 返却  
- 取り切れなければ `partial_success`
- 候補ゼロなら `unknown` + `need_confirm=true`
- 失敗時は `meta.failure_code` で原因分類（OCR失敗 / upstream 429 など）

## Redis Key Policy (Upstash)

- `ruidaichan:free:count:{install_id}:{yyyyMM}`
  - 値: integer（月内消費数）
  - TTL: 次月UTC 00:00:00 まで
- `ruidaichan:count:{install_id}:{plan_id}:{yyyyMM}`
  - 値: integer（月内消費数）
  - TTL: 次月UTC 00:00:00 まで
  - `light` / `premium` 用
- `ruidaichan:first_month:{install_id}`
  - 値: string `yyyyMM`
  - TTL: なし（初回利用月の固定）
- `ruidaichan:rate:short:{install_id}`
  - 将来用 prefix 予約（未実装）

## Plan Policy

- `free`: 初月10回 / 以降5回
- `light`: 毎月50回
- `premium`: 毎月300回
- 現状の backend 既定 plan は `free`

## Count Policy

- `word_problem`: 最大5問
- `equation`: 最大10問
- `count`超過時はサーバー側で強制調整し、`meta.max_count` / `meta.target_count` を返却

## Timeout / Partial Success Policy

- 時間予算内で生成（UX優先）
- 取り切れない場合は `partial_success`
- 補充分の再試行は短く制限

## Classification Table (Fixed)

実装上の分類は次の3軸で固定します。

1. 表現形式
- `equation`: 式のみ / 式+□
- `word_problem`: 文章題

2. 数学的意味
- `simple_calc`: 加減乗除
- `reverse_blank`: 穴あき逆算
- `repeat_multiply`: くり返し（毎日×日数）
- `scale_times`: 倍（AはBのk倍）
- `split_equal`: 等分
- `unit_conversion`: 単位変換
- `compare_diff`: 合算して差を問う比較

3. 出力制約
- 選択肢なし（`prompt`のみ）
- 単位整合
- 学年帯（`g1` / `g2_g3`）

## Scope (Roadmap Gate)

今後の方針決定は以下教材群を基準に進めます。

- [print365 1年計算](https://www.print365.net/2gakkimadekeisan1nen/)
- [すきるまドリル](https://sukiruma.net/sandrill/)

### 対応対象（1〜3年）

- 図を使って考える（非インタラクティブで表現可能な範囲）
- グラフ・表の読み取り
- 作図（円・球）
- ものさしの読み方（実物操作を除く出題文ベース）
- 計算ピラミッド（図配置）
- 単位変換（mm/cm/m/km, mL/dL/L, g/kg）

### 除外対象（現時点）

- 百ます計算（専用UIが必要）
- 筆算

## Definition of Done (家庭利用の合格基準)

- 図を使わない算数問題の 8割以上を処理
- 入力が写真1枚またはOCRテキストで動作
- 類題5問を安定生成
- A4で即印刷できる形式で返却

## Local Development

1. Install

```bash
npm install
```

2. Env

```bash
cp .env.example .env
```

Required env vars:

- `API_KEY`
- `GEMINI_API_KEY`

Optional env vars:

- `GEMINI_MODEL` (default: `gemini-2.0-flash`)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`（設定時に月次無料枠チェックを有効化）

3. Run

```bash
npm run dev
```

4. Test

```bash
npm test
npm run build
```

## Security / Ops

- API key auth (`x-api-key`)
- Rate limit enabled
- Structured logs (`request_id`, reason, timeline)
- 画像生データはログ保存しない
- OCR本文の生ログ保存を避ける方針

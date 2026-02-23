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
    "note": "ok|partial_success|partial_success_timeout|unknown_no_viable_candidate|ok_ambiguous_unit_conversion|ok_count_capped_by_policy",
    "seed": "...",
    "grade_band_applied": "g1|g2_g3",
    "difficulty_applied": "easy|standard|hard",
    "count_policy": "server_enforced",
    "max_count": 5,
    "target_count": 5
  },
  "debug": {}
}
```

### Other endpoints (legacy/aux)

- `POST /extract`
- `POST /extract_layout`
- `POST /extract_skeleton_layout`
- `POST /micro/generate`

## Decision Flow (`/micro/generate_from_ocr`)

1. 入力受付  
- `ocr_text` があれば先に使用
- `ocr_text` が空/ノイジーで `image_base64` があれば AI OCR フォールバック

2. モード判定  
- `input_mode`: `equation` / `word_problem`

3. 式トラック判定（equation時）  
- `arithmetic`
- `unit_conversion_pure`
- `unit_conversion_calc`

4. difficulty適用  
- 共通 difficulty（`easy` / `same` / `hard`）を内部 policy に写像
- `same` は内部的に `standard` として扱う

5. 生成（AI）  
- promptのみ生成（選択肢なし）

6. 軽量フィルタ  
- モード整合
- カテゴリ整合
- 演算子ヒント整合（例: 掛け算入力は掛け算問題を優先）
- 単位ドメイン整合（length / volume / weight）
- 難易度policy整合（range / steps / blank位置 / unit変換段数）

7. 返却  
- 取り切れなければ `partial_success`
- 候補ゼロなら `unknown` + `need_confirm=true`

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

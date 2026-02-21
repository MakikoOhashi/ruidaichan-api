# ruidaichan-api

小学校1〜3年の算数向けに、OCRテキストから類題を生成して返す stateless API です。

## Current Focus

本線は `POST /micro/generate_from_ocr` です。

- 入力: iOS Vision OCRの `ocr_text`（画像は補助）
- 出力: `micro_problem_render_v1` 契約（`detected_mode` / `required_items` / `items` / `problems`）
- 目的: 「即印刷できるA4問題」を短時間で返す

## Responsibility Boundary

- Server: 問題生成・軽量検証・描画向けJSON返却
- iOS: OCR取得・UI・PDF描画
- ServerはDBを持たない（stateless）

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

```json
{
  "ocr_text": "...",
  "count": 5,
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
  "required_items": ["prompt", "choices"],
  "items": [],
  "problems": [],
  "requested_count": 5,
  "applied_count": 5,
  "meta": {
    "count_policy": "server_enforced",
    "max_count": 10,
    "target_count": 5,
    "grade_band_applied": "g1"
  },
  "debug": {}
}
```

### Other endpoints (legacy/aux)

- `POST /extract`
- `POST /extract_layout`
- `POST /extract_skeleton_layout`
- `POST /micro/generate`

## Count Policy

- `word_problem`: 最大5問
- `equation`: 最大10問
- `count`超過時はサーバー側で強制調整し、`meta.max_count` / `meta.target_count` を返却

## Timeout / Partial Success Policy

- 生成は時間予算内で実行
- 取り切れない場合は `partial_success` を返す
- 補充分の追加予算は短く制限（UX優先）

## Scope (Roadmap Gate)

今後の方針決定は以下教材群を基準に進めます。

- [print365 1年計算](https://www.print365.net/2gakkimadekeisan1nen/)
- [すきるまドリル](https://sukiruma.net/sandrill/)

## Classification Table (Fixed)

実装上の分類は次の3軸で固定します。

1. 表現形式（UIに直結）
- `equation`: 式のみ / 式+□
- `word_problem`: 文章題

2. 数学的意味（solver側）
- `simple_calc`: 加減乗除（小数含む）
- `reverse_blank`: 穴あき逆算
- `repeat_or_times`: くり返し / 倍
- `split_equal`: 等分
- `unit_conversion`: 単位変換

3. 出力制約
- 選択肢あり / なし
- 単位必須 / 不要
- 学年帯（`g1` / `g2_g3`）

判定順序:
1. 式っぽさ判定（記号・数字・単位）  
2. 穴あき判定（`□`）  
3. 単位変換判定  
4. 選択肢要件適用  

`unknown` は最終手段（候補ゼロまたは検証全落ち）のときだけ返します。

### 対応対象（1〜3年）

- 図を使って考える（非インタラクティブで表現可能な範囲）
- グラフ・表の読み取り
- 作図（円・球）
- ものさしの読み方（実物操作を除く出題文ベース）
- 計算ピラミッド（図配置）
- 単位変換（mm/cm, m, L/dL, g/kg など）

### 対応例（確定）

- `16-8`
- `25+5+7`
- `14+3-2`
- `7×9=`
- `0.4+0.7`
- `2×□=16`
- `98-□=39`
- `2cm1mm = □mm`
- `1kg480g = □g`
- `1L8dL + 7dL = □dL`
- 「はなまるを9こ、きょう7こ。ぜんぶでなんこ」
- 「なふだ15こ、8こもっていった。のこりはなんこ」
- 「プリント5まい、1まい2分。全部で何分」
- 「子ども8人に48本を同じ数ずつ分ける」
- 「毎日1ページ、1ページ8問。6/4〜6/10で何問」
- 「黄色のチューリップは赤の2ばい。赤15本のとき黄色は何本」
- 「赤/黄色のあめ玉を2人で合計比較し、どちらが何こ多いか」
- 「バケツに1L8dL、さらに7dL。合計何dL」

### 除外対象（現時点）

- 百ます計算（専用UIが必要）
- 筆算

## Definition of Done (家庭利用の合格基準)

次を満たせば「小学1〜3年 家庭用途として完成」と判定します。

- 図を使わない算数問題の **8割以上** を処理できる
- 入力が **写真1枚 または OCRテキスト** で動作する
- **類題5問** を安定生成できる
- **A4で即印刷** できる形式で返せる

この内容チェックが通ったら、UI作成フェーズへ進みます。

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
- `GEMINI_TIMEOUT_MS`
- `GEMINI_TEMPERATURE`

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
- Structured logs (`request_id`, latency, reason)
- OCR本文は生ログ保存しない方針

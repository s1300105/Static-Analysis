# webpack5-endpoints

`extract_endpoints`（ast_url）のテスト用の webpack 5 production ビルド（`devtool: false`）。
`build/src/api.js` に、fetch・ベース URL つきのクライアント（axios 風）・XHR・WebSocket・sendBeacon・`$.ajax` の設定オブジェクト・
テンプレートリテラル・文字列の連結を置き、`expected.json` に正解（拾うべき呼び出し）を書いた。
クライアント側のルート定義・`headers.get('content-type')`・`URLSearchParams#get`・静的ファイルのパスは拾ってはいけないもの。

terser がクライアントの生成を畳み込むので、出力では `baseURL` の文字列が消え、`fetch("/api/v2"+t+…)` だけが残る（ベース URL の推定の確認になる）。

作り直し方（webpack 5.102.1 / webpack-cli 6.0.1）:

```bash
cp -r build /tmp/wp5e && cd /tmp/wp5e
npm install --no-save webpack@5.102.1 webpack-cli@6.0.1
npx webpack --config webpack.config.cjs   # dist/ に出る
```

`jsluice-urls.jsonl` は jsluice（`v0.0.0-20240110145140-0ddfab153e06`、docker/sa/Dockerfile と同じ版）の出力の記録。
jsluice 抽出器のテストはこれを返す偽の実行ファイルで回す（`filename` は手元のパスを外してある）。

```bash
jsluice urls --include-source --placeholder EXPR "$PWD/output/main.c452f02c.js" \
  | sed "s#\"filename\":\"$PWD/output/#\"filename\":\"#" > jsluice-urls.jsonl
```

`output-v2/` は手順6の前提確認（`scripts/lineage-precheck.ts`）のテスト用に、`build/src/api.js` を少し変えて作り直したもの
（`login` の `X-Client-Version` を `3.2` に、`legacySearch` を削除、`exportAll` を追加）。`build/` には変更前のソースだけを置いている。

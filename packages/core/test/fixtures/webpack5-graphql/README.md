# webpack5-graphql

GraphQL の抽出（`extract_endpoints` の graphql_text / graphql_ast / relay）のテスト用の webpack 5 production ビルド（`devtool: false`）。

- `src/queries.js`: graphql-tag に似たタグ付きテンプレート（本番ビルドでタグの名前は短くなる）。query・mutation・subscription と、
  `${...}` で埋め込む fragment（fragment だけの文書はエンドポイントではない）
- `src/precompiled.js`: ビルド時に変換された DocumentNode のオブジェクトリテラル。`loc.source.body` の無い形（AdminUsers）と有る形（UpdateSettings）
- `src/__generated__/UserProfileQuery.graphql.js`: Relay コンパイラの生成物の形（persisted query: `params.text` は null、`params.id` がハッシュ）。
  CommonJS なのでモジュールマップに別のモジュール（979）として残り、terser が `argumentDefinitions` の変数を代入式に畳み込む
- `src/client.js`: 本文の文字列を `fetch("/graphql", { method: "POST" })` で送る（ast_url の POST /graphql と graphql_text の SearchUsers）、
  GraphQL に見えて GraphQL ではない文字列

webpack は ESM のモジュールを 1 つに連結してランタイムの中に埋め込むので、Relay の生成物以外はモジュールマップの外にある
（ast_url がファイルごと読むことの確認にもなる）。

作り直し方（webpack 5.102.1 / webpack-cli 6.0.1）:

```bash
cp -r build /tmp/wp5g && cd /tmp/wp5g
npm install --no-save webpack@5.102.1 webpack-cli@6.0.1
npx webpack --config webpack.config.cjs   # dist/ に出る
```

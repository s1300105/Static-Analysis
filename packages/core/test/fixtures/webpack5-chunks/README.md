# webpack5-chunks

`find_missing_chunks` のテスト用の webpack 5 production ビルド（`devtool: 'source-map'`、公開パス `https://cdn.example.com/assets/`）。

- `main.f21b19c3.js`: ランタイムとエントリ。`__webpack_require__.u` がチャンク ID からファイル名を組み立てる
  （名前つきの `admin`・`settings` と名前なしの `867`）。`/*! For license information please see main.f21b19c3.js.LICENSE.txt */` と
  `sourceMappingURL` のコメント、webpack が触らないブラウザの動的 import（`https://widgets.thirdparty.example/w.js`）を持つ
- `admin.3be16cd6.chunk.js`・`867.75f286be.chunk.js`・`settings.f61ce08e.chunk.js`: 非同期チャンク（それぞれ sourcemap つき）
- `main.f21b19c3.js.LICENSE.txt`: terser が `src/vendor-lib.js` の `/*!` コメントを抜き出したもの

作り直し方（webpack 5.102.1 / webpack-cli 6.0.1）:

```bash
cp -r build /tmp/wp5c && cd /tmp/wp5c
npm install --no-save webpack@5.102.1 webpack-cli@6.0.1
npx webpack --config webpack.config.cjs   # dist/ に出る
```

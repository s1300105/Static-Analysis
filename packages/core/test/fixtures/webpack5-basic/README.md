# webpack5-basic

`unpack_bundle` / `import_sourcemap` のテスト用の、webpack 5 の production ビルド（`devtool: 'source-map'`、`splitChunks: all`）。

- `output/`: ビルド結果（コミットしたもの）。`main` はランタイム（モジュールマップを持つ IIFE）、
  `lazy` は動的 import のチャンク、`949` は node_modules（`tiny-escape`）を切り出したチャンク（どちらも `webpackChunk*.push(...)`）
- `expected.json`: webpack の stats から取ったチャンク ID とモジュール ID（ランタイムモジュールは除く）
- `other-build/main.57d12ed8.js.map`: `build/src/render.js` にメソッドを 1 つ足してビルドした別ビルドの map（「別ビルドの map」の検査用）
- `build/`: 入力。`src/greeting.js` は 3 バイト文字とサロゲートペア（4 バイト）を含む（バイト位置の変換の検査用）

作り直し方（webpack 5.102.1 / webpack-cli 6.0.1 で作成。同じ版なら同じハッシュになる）:

```bash
cp -r build /tmp/wp5 && cd /tmp/wp5
npm install --no-save webpack@5.102.1 webpack-cli@6.0.1
mkdir -p node_modules/tiny-escape && cp vendor/tiny-escape/* node_modules/tiny-escape/
npx webpack --config webpack.config.cjs --json=stats.json   # dist/ に出る
```

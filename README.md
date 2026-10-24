# static-analysis

Bug Bounty 向けの静的解析 AI エージェント＋MCP サーバ。**ターゲットには一切通信しない**（静的解析に特化）。
対象は Web / JavaScript・TypeScript のソースおよびバンドル。

設計は `docs/` を参照:

- `docs/design.md` — 要件・概念設計・DB スキーマ・評価（rev.3）
- `docs/plan.md` — 実装計画（マイルストーン・合格/撤退条件）
- `docs/architecture.md` — 実装アーキテクチャ（パッケージ境界・モジュール・型・規約）

## モノレポ構成

| パッケージ | 役割 |
|---|---|
| `@sa/types` | ドメイン型・語彙・定数・zod スキーマ（実装/I-O を持たない） |
| `@sa/core` | 全ロジック。唯一の DB 書き手。層生成・解析・状態遷移・事実・較正 |
| `@sa/cli` | `sa` コマンド。人間と自動化の入口。判定の書き込みはここだけ |
| `@sa/mcp` | 薄い MCP サーバ。読み取り・解析・パイプライン書き込みだけを公開 |

依存は一方向（`@sa/types ← @sa/core ← {@sa/cli, @sa/mcp}`）で、`pnpm depcruise` が CI で検査する。

## 使い方（いまできること）

```bash
pnpm install && pnpm build
alias sa="node $(pwd)/packages/cli/dist/cli.js"

# 対象を作る（llm_code_policy の既定は deny。deny 以外にするには規約の確認日と URL が要る）
sa target add example --allow example.com --allow api.example.com
sa target set-scope example --llm-code-policy no_original \
  --policy-confirmed-at 2026-10-20 --policy-source https://hackerone.com/example/policy

# 取得した JS・sourcemap を取り込む（raw 層 → unpack → sourcemap の簡易検証と original 層）
sa load example dist/*.js dist/*.map --collected-at now --label v1
sa target show example

# DB のスナップショット（blob ストアは別に保管する）
sa backup ~/sa-backup-$(date +%F).db
```

データは `--home`（既定 `$SA_HOME` か `~/.sa`）の下に置く: `sa.db`・`blobs/`・`workspace/`。設定は `<home>/config.json`（任意）。
`--json` を付けると結果を JSON で出す。

## 開発

要件: Node.js >= 22、pnpm。

```bash
pnpm install
pnpm check      # lint + typecheck + test + build + smoke + depcruise
```

個別:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke      # ビルド後の dist で取り込み → unpack → sourcemap を一通り動かす（worker の dist 解決の確認）
pnpm depcruise
```

テストは worker（`packages/core/src/jobs/workers/*.worker.ts`）を Node の型除去で直接読むので、Node 22.18 以降が要る。

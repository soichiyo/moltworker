# CLAUDE.md

Claude Code がこのリポジトリで作業する際のガイダンス。

## プロジェクト概要

Cloudflare Worker + Sandbox Container 上で [OpenClaw](https://github.com/openclaw/openclaw) を実行するプロジェクト。

- OpenClaw Gateway へのプロキシ（Web UI + WebSocket）
- `/_admin/` でデバイス管理用 Admin UI
- `/api/*` でデバイスペアリング用 API
- 5分ごとの cron で R2 にバックアップ

## コマンド

```bash
npm test              # テスト実行（vitest）
npm run build         # Worker + クライアントビルド
npm run deploy        # ビルドして Cloudflare にデプロイ
npm run typecheck     # TypeScript 型チェック
npm run dev           # Vite 開発サーバー
```

## アーキテクチャ

```
Browser → Cloudflare Worker (src/index.ts)
              ↓
         Cloudflare Sandbox Container
              └── OpenClaw Gateway (port 18789)
```

## プロジェクト構造

```
src/
├── index.ts          # Hono アプリ、ルートマウント、cron ハンドラ
├── types.ts          # TypeScript 型定義（MoltbotEnv）
├── config.ts         # 定数（MOLTBOT_PORT, STARTUP_TIMEOUT_MS, R2_MOUNT_PATH）
├── auth/             # Cloudflare Access 認証
├── gateway/          # Gateway 管理
│   ├── process.ts    # ensureMoltbotGateway(), findExistingMoltbotProcess()
│   ├── env.ts        # buildEnvVars() - コンテナに渡す環境変数
│   ├── r2.ts         # R2 バケットマウント（s3fs）
│   ├── restore.ts    # R2 からの復元（TypeScript、起動前に実行）
│   ├── sync.ts       # R2 へのバックアップ（TypeScript、cron で実行）
│   └── utils.ts      # waitForProcess()
├── routes/           # API ルートハンドラ
│   ├── api.ts        # /api/* エンドポイント
│   ├── admin.ts      # /_admin/* 静的ファイル配信
│   └── debug.ts      # /debug/* デバッグエンドポイント
└── client/           # React Admin UI（Vite）
start-openclaw.sh     # コンテナ内起動スクリプト
```

## 重要なルール

### R2 バックアップ（最重要）

**`start-openclaw.sh` に s3fs 操作を絶対に書かない。**

- `start-openclaw.sh` は `set -e` で動作する
- s3fs（`/data/moltbot/` 以下）は不安定（タイムアウト、stale mount）
- s3fs 操作が失敗すると `ProcessExitedBeforeReadyError` でゲートウェイが起動しない

正しいフロー:
```
ensureMoltbotGateway() in process.ts:
  1. mountR2Storage()        ← TypeScript、エラーハンドリング済み
  2. findExistingMoltbotProcess() ← 既存プロセスがあればそれを使う
  3. restoreFromR2()         ← 新規起動時のみ、TypeScript、失敗=新規開始
  4. start-openclaw.sh       ← ローカルファイルのみ操作
  5. waitForPort(18789)
```

R2 関連のロジックを追加する場合:
- **復元** → `src/gateway/restore.ts`
- **バックアップ** → `src/gateway/sync.ts`
- **起動スクリプトには絶対に追加しない**

### Sandbox API の注意点

- `proc.exitCode` は高速プロセスでは `undefined` になることがある → stdout パースで判定
- `proc.status` は即座に更新されない場合がある → `waitForProcess()` でポーリング
- `restoreFromR2()` は `ensureMoltbotGateway()` の毎回ではなく、**新規起動時のみ**実行する（s3fs I/O の遅延を避けるため）

### デプロイの注意

- デプロイごとに Durable Object がリセットされ、コンテナが切断される
- 連続デプロイはコンテナのリスタートループを引き起こす
- デプロイ後はゲートウェイ起動に 2〜3 分かかる
- Admin UI の「Restart Gateway」は起動中に押さない

## テスト

Vitest 使用。テストファイルはソースと同じ場所に配置（`*.test.ts`）。

```bash
npm test  # 全テスト実行
```

テストのモックパターン:
- `createMockSandbox()` で sandbox をモック
- `startProcessMock.mockResolvedValueOnce()` でプロセス呼び出し順を制御
- `createMockProcess(stdout, { exitCode, stderr, status })` でプロセス結果を指定

## コードスタイル

- TypeScript strict モード
- 関数シグネチャには明示的な型
- ルートハンドラは薄く保ち、ロジックは `gateway/` に抽出
- Hono のコンテキストメソッド（`c.json()`, `c.html()`）を使用

## 環境変数の追加手順

1. `src/types.ts` の `MoltbotEnv` インターフェースに追加
2. コンテナに渡す場合は `src/gateway/env.ts` の `buildEnvVars()` に追加
3. `.dev.vars.example` を更新

## R2 ストレージの注意点

- R2 は s3fs 経由で `/data/moltbot` にマウント
- rsync は `rsync -r --no-times` を使用（`-a` は不可）
- `/data/moltbot/*` を削除すると R2 データが消える
- バックアップは `openclaw/` プレフィックスで保存（レガシー `clawdbot/` も対応）

## 詳細なドキュメント

`AGENTS.md` にさらに詳しいアーキテクチャ情報、環境変数一覧、よくあるタスクの手順がある。

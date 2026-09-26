# M0 スパイク

結果は [docs/spikes.md](../../docs/spikes.md) を参照。

## 再現手順
1. `sandbox/` の中身を、空の git リポジトリにコピーする（`git init` して 1 回 commit する）。
2. そのリポジトリで偽プロバイダと opencode のサーバを起動する。
   ```
   node mock-429.mjs
   opencode serve --port 4097
   ```
3. このディレクトリでスクリプトを実行する（接続先は `OC_BASE` で変えられる）。

| スクリプト | 項目 |
|---|---|
| `t0-probe-models.mjs <provider/model>...` | モデルの疎通確認（Codex で使えるモデル） |
| `t1-agent-model.mjs` | #1 agent の指定、#5 途中でモデルを替える、#8 トークン |
| `t2-long-tool.mjs <秒> [中断までの秒]` | #2 長時間のツール、中断の伝達 |
| `t3-limit.mjs` | #3 上限エラー（偽プロバイダ） |
| `t7-worktree.mjs` / `t7b-worktree-perm.mjs` | #7 worktree の子セッション、#4 ask で止まる |
| `t9-autocontinue.mjs` | #9 自動継続 |
| `t6-compaction.mjs` | #6 圧縮（`sandbox/compact/opencode.json` の設定で、別のサーバを `--port 4098` で起動する） |
| `t10-cache.mjs` | #10 セッション間のキャッシュ |

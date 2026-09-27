# omo（OmO Ultimate）の評価

- 実施日: 2026-09-27
- 対象: 試験用リポジトリ [is-9108/opencode-harness-sandbox](https://github.com/is-9108/opencode-harness-sandbox)（非公開）の issue #1、#2
- 環境: opencode 1.18.31 / oh-my-openagent 5.0.1 / Windows 11 / Node 22.17
- モデル: Codex（ChatGPT サブスク）のみ。OMO の全エージェントとカテゴリに Codex のモデルを割り当てた
- 結論: **採用しない**（[plan.md](plan.md) の決定 12）

## 比べたもの

| | トークン（キャッシュ込み） | 所要時間 | テストの数 | red の検証 | 人の承認 |
|---|---|---|---|---|---|
| ハーネスの `/dev`（OMO なし、[M1 の E2E](e2e/m1.md)、issue #2） | **73,385** | 約 4 分 | 14 件 | JUnit で検証し、テストをロック | 計画の承認 1 回 |
| ハーネスの `/dev` ＋ OMO を入れた状態（issue #1） | 125,248（OMO なしの 69,810 の約 1.8 倍） | 約 5 分 | 7 件 | 同上 | 同上 |
| OMO の `ultrawork` だけ、既定の設定（issue #2） | 7,659,395 | 約 12 分 | 5 件 | エージェントの自己申告だけ | なし |
| OMO だけ、`ultrawork` なし、トークンを抑える設定（issue #2） | 3,315,285 | 約 10 分 | 8 件 | 同上 | なし |

- トークンは、アシスタントの全メッセージの input + output + reasoning + cache（read / write）の合計。ハーネスの `events.jsonl` の `tokens.total` と同じ数え方
- OMO だけの 2 回は、どちらも PR まで作れた（テンプレートどおり、`Closes #2` あり）。品質に大きな問題はなかったが、テストは受け入れ基準 1 つにつき 1 件程度で、commit は 1 つ（テストを先に書いたかを履歴から確かめられない）
- 「トークンを抑える設定」は、Claude Code のコマンド・スキル・フック・MCP の読み込みを止め、`experimental.truncate_all_tool_outputs` と `dynamic_context_pruning` を有効にしたもの

## トークンが多い理由

- **Sisyphus（司令塔）が何十回もやりとりし、そのたびに大きな文脈を読み直す**。既定の設定では 87 回のやりとりで、文脈は 2.9 万から 10 万トークンまで膨らんだ（合計 682 万トークンがキャッシュの読み込み）
- **スキルの本文が文脈に残り続ける**。`programming`（約 1 万トークン）、`git-master`（約 8 千）、`review-work`（約 5 千）を毎回読み込む
- **`ultrawork` を使わなくても、サブエージェントに仕事を振る**。plan（64 万）、Sisyphus-Junior（115 万）、explore / librarian（9 万）、oracle（3 万）
- OMO の強み（役割ごとのエージェントに振り分け、スキルで手順を厚くする）そのものがトークンを使う理由なので、設定で絞るほど「素の opencode ＋ ハーネス」に近づく

## 共存させたときに見つかったこと

| # | 見つかったこと | ハーネスへの影響 |
|---|---|---|
| 1 | OMO は `.opencode/commands/dev.md` を「スキル」として取り込み、Sisyphus が自分から `harness_start` / `harness_advance` を呼んだ（承認のゲートは `question` で守られた） | **ハーネスのツールは、司令塔以外のどのエージェントからも見える**。OMO がなくても、`build` などのエージェントが呼べてしまう。M2 で司令塔以外から隠す |
| 2 | ツールが 17 → 31 に増え、子セッションの 1 回目の文脈が約 1 万トークン増えた | 子セッションには、工程に必要なツールだけを渡すのがよい（今は権限で編集だけを絞っている） |
| 3 | opencode 本体が `~/.agents/skills`（Cursor などと共有するスキル）を読み込み、スキルの一覧に載る | ハーネスの子セッションにも載っている。影響は約 1〜2 千トークンと小さい |
| 4 | OMO は起動時に設定ファイルを新しい形式に書き換える。`.omo/run-continuation/` を作る。`~/.omo` に LSP のデーモンと ast-grep を置く | 評価の後、すべて削除した |

## 参考にするもの

- `runtime-fallback`: 上限やエラーのときに、待ち時間を読み取ってモデルを切り替える（M3 のフォールバック）
- 編集の失敗時の再試行（`edit-error-recovery`）、JSON の解析の失敗時の再試行
- ツールの出力の切り詰め（`tool-output-truncator`）と、古いツールの出力の間引き（`dynamic_context_pruning`）

## 設定の書き方（参考）

5.0 では `~/.omo/omo.jsonc`（または `.omo/omo.jsonc`）に、共通の設定を最上位に、opencode の設定を `"[opencode]"` の中に書く。テレメトリは既定で有効なので、`"telemetry": { "enabled": false }` で止める。

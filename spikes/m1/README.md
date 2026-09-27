# M1 の実機確認

## drive-dev.mjs
TUI の代わりに opencode のサーバの HTTP API で `/dev <issue>` を実行し、司令塔の `question` に自動で答えるスクリプトです。承認のやり取りを含む受け入れ基準（#10 以降）を実機で確かめるために使います。

- 1 回目の承認の問い → 「修正指示」（内容も答える）、2 回目 → 「承認」
- 権限の確認が出たら、内容を記録して 1 回だけ許可する（出ること自体が問題の兆候なので、出力を確認すること）
- コマンドの HTTP 応答は 5 分で切れるので待たず、完了はセッションの状態（idle）で判定する

```
opencode serve --port 4097          # ハーネスを入れたリポジトリで起動する
ISSUE=3 MODEL=openai/gpt-6-luna node spikes/m1/drive-dev.mjs
SESSION=<ses_...> node spikes/m1/drive-dev.mjs   # 既存のセッションにつなぎ直す
```

注意: 質問と権限の一覧は、セッション単位の `/api/session/{id}/question` では見えず、全体の `/question` と `/permission` で取得する必要があった。

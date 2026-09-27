---
description: issue の開発を開始・再開する（計画 → テスト → 実装 → レビュー → PR）
agent: harness
---

issue #$ARGUMENTS の開発を進めてください。

`harness_start(kind: "dev", arg: $ARGUMENTS)` で run を用意し、`harness_advance` を「結果: continue」の間は呼び続けてください。need_user になったら、メッセージの手順に従ってユーザーに確認してください。

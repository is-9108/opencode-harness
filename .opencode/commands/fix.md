---
description: エスカレーションした issue を、対話しながら直して再開する
agent: harness-fix
---

issue #$ARGUMENTS の run を直してください。

`harness_start(kind: "fix", arg: $ARGUMENTS)` を呼び、返ってきた報告の要約をユーザーに示して、方針を `question` ツールで決めてください。エスカレーションされていない run なら、何もせずに理由を伝えてください。

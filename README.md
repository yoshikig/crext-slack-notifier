# slack-notifier-extension


https://docs.google.com/document/d/1hrC8OeBs6zgEjxk0sPYFLpjgCEZtZHRia_equ7p4ysI/edit

## 設定画面の同期情報

未読数の取得・同期・表示の詳しい挙動は [docs/unread-sync.md](docs/unread-sync.md) を参照してください。

設定画面で連携先Slackのワークスペース名・ID・ドメイン・アイコン・URL、WebSocket接続状態、HTTP APIの直近30件の取得履歴、内部の未読・メンション数とミュート状態を確認できます。連携先情報は `team.info` で取得し、Token変更時に取得し直します。同期ステータスは2秒ごとに更新されます。履歴はメモリ内に保持され、サービスワーカーの再起動でリセットされます。未読チャンネル名は必要に応じて `conversations.info` で取得し、権限不足の場合はIDを表示します。

未読データは起動時・WebSocket接続/切断時・通常5分ごとのアラームで同期します。接続が11分以上続き、接続後のHTTP同期が2回成功し、直近60秒以内にpongを受信している場合は30分間隔に切り替えます。「未読データを再取得」から手動で同期することもできます。`users.counts` がTokenの種類・権限によって利用できない場合は、`users.conversations` の全ページから参加チャンネルを取得し、`conversations.info` の未読数、または最終既読時刻以降の `conversations.history` から集計します。履歴の取得には対象チャンネルの `*:history` 権限が必要です。取得できないチャンネル・数値は「未取得」と表示し、同期失敗を「未読なし」として表示しません。未読数と最終既読時刻の両方が返らないTokenでは、初期の未読数を復元できません。メンション数が返らない場合も「未取得」と表示します。

WebSocketでは接続ユーザーへの直接メンション、DM・グループDMの増分、受信済み投稿の編集・削除を反映します。削除通知では対象チャンネルをHTTPで再取得して補正します。元の未読状態が不明な削除や通知条件が未確定のグループメンションなどは診断に表示し、HTTP同期で補正します。

変更後は `bash generate2.sh` で配布用ディレクトリを生成し、Chromeの拡張機能を再読み込みしてください。

診断処理のテスト（Node.js）:

```sh
node --experimental-vm-modules --test tests/diagnostics.test.mjs
```

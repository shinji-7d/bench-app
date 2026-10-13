# bench-app

13週ベンチプログラムの記録用Webアプリ（オフライン動作）。

公開先: https://shinji-7d.github.io/bench-app/

- 記録はブラウザのlocalStorageに保存（サーバには一切送信しない）
- 外部リソースへの通信ゼロ
- 設計書・食事・進捗は `~/Desktop/Mastermind/Hotta_Program_13Weeks_Bench_Recomp_v1.xlsx`

## オフライン動作（PWA）

一度オンラインで開けば、以降は**圏外のジムでも起動する**。

- `sw.js` … Service Worker
  - HTML: ネットワーク優先＋3秒タイムアウト → キャッシュ
    （オンラインなら常に最新、回線が死んでいれば即キャッシュ）
  - アイコン等: キャッシュ優先
  - 記録データ（localStorage）には一切触らないので、更新で記録が消えることはない
- `manifest.webmanifest` … ホーム画面に追加するとフルスクリーンで起動
- `icon-192.png` / `icon-512.png` / `apple-touch-icon.png`

iPhoneは Safari で開き「共有 → ホーム画面に追加」。

### 注意

- Service Worker は https か localhost でのみ動く。
  `index.html` をファイルから直接開いた場合は登録されない（アプリ自体は動く）。
- `sw.js` を書き換えたら `VERSION` を上げる。古いキャッシュは activate 時に破棄される。

## 動作確認

node だけで検証できる（追加パッケージ不要）。

```bash
node test/verify.js      # 全13週 × 全7day を描画まで通す（種目のべ323件）
node test/sw-verify.js   # SWの install/activate/オフライン経路
```

`test/verify.js` は index.html のインラインscriptを取り出し、最小DOMスタブ上で
`render()` まで実行する。セット数・RPE・推奨重量の不正値や、描画結果に
`undefined`/`NaN` が出ていないかを全週×全dayで検査する。

`test/sw-verify.js` は Cache Storage と fetch をスタブし、オンライン／圏外／
低速回線の3条件で sw.js を実際に走らせる。

ブラウザで確認する場合:

```bash
python3 -m http.server 8933
# → http://localhost:8933/   （SWはlocalhostなら有効）
```

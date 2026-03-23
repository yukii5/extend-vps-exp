# トラブルシュートメモ

このドキュメントは、`main.mjs` を GitHub Actions 上およびローカル実行したときに確認できた問題点をまとめたものです。

最終更新日: 2026-03-24

## 現在の状況

- `GitHub-hosted runner` では `main.mjs` は最後まで実行される
- `XServer VPS` の更新画面 `https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf` には到達できる
- 画像 CAPTCHA は取得でき、OCR 結果も入力できている
- Cloudflare Turnstile 用 token も 2Captcha から取得し、hidden field へ注入できている
- GitHub-hosted runner では `POST /xapanel/xvps/server/freevps/extend/do` まで到達するが、`認証に失敗しました。` になる
- ローカル実行では同じ処理で `302 -> /xapanel/xvps/index` となり成功する

## GitHub Actions が `Waiting for a runner to pick up this job...` で止まる場合

2026-03-24 時点の workflow はどちらも以下の runner を要求している。

- `runs-on: [self-hosted, linux, x64]`
- 対象: [`.github/workflows/main.yml`](/Users/ikedayuuki/Applications/new_project/extend-vps-exp/.github/workflows/main.yml)
- 対象: [`.github/workflows/reminder.yml`](/Users/ikedayuuki/Applications/new_project/extend-vps-exp/.github/workflows/reminder.yml)

この表示で止まる場合、`main.mjs` や `reminder.mjs` の不具合ではなく、GitHub 側が条件に合う self-hosted runner をまだ見つけられていない。

### まず確認すること

1. GitHub の `Settings > Actions > Runners` で runner が `Online` になっているか
2. その runner がこの repository に紐付いているか
3. runner の label に `self-hosted` `linux` `x64` が含まれているか
4. runner を `--no-default-labels` で登録していないか
5. runner の実機が `Linux x64` か

### よくある原因

- runner が停止中で `Offline`
- runner を org/repo の別スコープに登録しており、この repository から見えていない
- runner が `ARM64` なのに workflow が `x64` を要求している
- runner が `Windows` または `macOS` なのに workflow が `linux` を要求している
- custom label だけで登録しており、デフォルト label が付いていない
- self-hosted runner 用ユーザーに password がなく、workflow 内の `sudo` で止まる

### サーバー側での確認例

`config.sh` と `run.sh` は `root` ではなく、専用の一般ユーザーで実行する。  
`/root/actions-runner` 配下に置くと一般ユーザーが扱いにくいので、例えば `/home/github-runner/actions-runner` を使う。

例:

```bash
adduser --disabled-password --gecos "" github-runner
su - github-runner
mkdir -p ~/actions-runner
cd ~/actions-runner
```

設定後の起動確認:

```bash
cd ~/actions-runner
./run.sh
```

service 化している場合:

```bash
cd /home/github-runner/actions-runner
sudo ./svc.sh install github-runner
sudo ./svc.sh start
sudo ./svc.sh status
```

### job 実行中に `[sudo] password for github-runner:` で止まる場合

原因は、runner を動かしている `github-runner` ユーザーに password がないのに、workflow が `sudo apt-get ...` を実行しているため。

対処:

1. いったんその workflow run を中止する
2. サーバーに root で必要パッケージを先に入れる
3. workflow から `Install system packages` step を外す

例:

```bash
apt-get update
apt-get install -y ffmpeg fonts-noto-cjk
```

この repository の self-hosted runner 用 workflow は、2026-03-24 時点で `sudo apt-get` step を削除してある。

### job 実行中に `yarn: command not found` で落ちる場合

原因は、runner マシンに `yarn` が入っていないのに workflow が `yarn add puppeteer` を実行しているため。

対処:

1. workflow の install step を `npm install` へ変更する
2. 変更を `main` に push する
3. runner を待機させたまま workflow を再実行する

この repository の self-hosted runner 用 workflow は、2026-03-24 時点で `npm install` を使うように変更してある。

### 対処方針

- runner が `Linux x64` なら、そのまま `self-hosted, linux, x64` で合わせる
- runner が `ARM64` なら workflow 側を `runs-on: [self-hosted, linux, ARM64]` のように実機へ合わせる
- label がずれているなら runner を再登録する

この待機状態を解消して、job が実際に起動してから初めて、下の「GitHub-hosted runner での認証失敗」の切り分けに進める。

## 実行環境ごとの差

### ローカル実行

- `POST /extend/do` のレスポンスが `302`
- `Location: https://secure.xserver.ne.jp/xapanel/xvps/index`
- 更新フォームを抜けて `XServer VPS契約管理ページ` に戻る
- Turnstile の見た目のチェック表示が付かなくても成功する
- `Page error Cannot read properties of null (reading 'classList')` が出ても成功する
- `Page console error %c%d font-size:0;color:transparent NaN` が出ても成功する
- `ethna_csrf` が空でも成功する

### GitHub-hosted runner

- `POST /extend/do` のレスポンスが `200`
- レスポンス本文に `認証に失敗しました。`
- 更新フォームに留まる
- submit ボタン `#submit_button` は最後まで `disabled: true`

この差から、コード自体よりも実行環境差の影響が大きいと考えられる。

## GitHub-hosted runner で確認できていること

### 送信前に確認できていること

- `auth_code` は hidden input と text input の両方に 6 桁で入っている
- `cf-turnstile-response` は 2 個ある hidden input の両方に同じ token が入っている
- `cf-turnstile-response` は `value` だけでなく `value attribute` にも入っている
- `uniqid` は常にセットされている
- `id_vps` は常にセットされている

### 送信前に不自然な点

- `ethna_csrf` hidden input が空
- `document.cookie` から見える cookie 一覧にも `ethna_csrf` は存在しない
- submit ボタン `#submit_button` は常に `disabled: true`
- submit ボタンの class は常に `btn btn--primary btn--md btn--loading`
- `global submit_button.click()` で送信すると `POST /extend/do` までは進むが、成功しない

### GitHub-hosted runner の network trace

- `GET /extend/index?id_vps=...`
- `POST /extend/conf`
- `POST /extend/do`

すべて `200 OK` で返っている。成功時に期待される `302` や完了ページへの遷移はまだ確認できていない。

### 送信後に確認できていること

- レスポンス画面は `https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/do`
- 画面本文に `認証に失敗しました。` が表示される
- 送信後の画面では text の `auth_code` は空に戻る
- 送信後の画面では `cf-turnstile-response` の片方が空に戻る
- hidden の `auth_code` と一部 `cf-turnstile-response` は残っている

## ここまでで除外できたこと

- GitHub Actions 側で workflow が途中で落ちているわけではない
- CAPTCHA 入力欄が見つからない問題ではない
- Turnstile の hidden field が 1 つだけ空のまま送られている問題ではない
- `auth_code` の hidden/text のどちらか片方だけ未入力という問題ではない
- `ethna_csrf` が空であること自体は、ローカル成功時の主因ではない
- `Page error Cannot read properties of null (reading 'classList')` は主因ではない
- `Page console error %c%d font-size:0;color:transparent NaN` は主因ではない
- `actions/checkout@v3` / `setup-node@v4` / `upload-artifact@v4` の deprecation 警告は本件の直接原因ではない

## 強く疑われる問題

### 1. GitHub-hosted runner 環境での Turnstile 判定差

もっとも疑わしい問題です。

理由:

- ローカルでは同じコードで成功する
- GitHub-hosted runner では同じ payload でも失敗する
- GitHub-hosted runner という datacenter 環境は Cloudflare 判定に不利
- 2Captcha が返す token を DOM に注入しても、GitHub-hosted ではクライアント側の submit ボタンは有効化されていない

### 2. ページ側の JavaScript 条件を満たしていない

submit ボタンが最後まで `disabled: true` のままです。

つまり、画面側は以下のいずれかを満たしていない可能性があります。

- Turnstile callback が正しく走っていない
- Cloudflare widget 内部 state が ready になっていない
- hidden input だけでなく別の JS state 更新が必要
- 画像 CAPTCHA と Turnstile の両方が揃ったときにだけ有効化されるロジックがある

### 3. GitHub-hosted runner で追加の hidden value または cookie が欠けている

現時点では `ethna_csrf` が見えていないが、これ自体はローカル成功時にも空である。  
したがって本命ではないが、サーバ側が runner 環境によって別条件を見ている可能性は残る。

## ログから見える補足

- `Page console error %c%d font-size:0;color:transparent NaN` が複数回出ている
- `Page error Cannot read properties of null (reading 'classList')` も出る
- ただし、これらはローカル成功時にも出ている
- したがって、現時点では実害のあるエラーというより noise の可能性が高い

## すでに入れてある対策

- GitHub Actions で `Node 24` 対応 action へ更新
- `apt-get` の冗長ログを抑制
- Turnstile token を複数 hidden field へ同期
- CAPTCHA コードを複数 `auth_code` field へ同期
- `value` だけでなく `defaultValue` と `value attribute` も同期
- submit 前後の form / field / request / response / cookie の詳細ログを追加
- debug artifact と screen recording を upload

## 次にやるべきこと

### 優先度高

1. self-hosted runner で workflow を動かし、ローカル成功に近い環境へ寄せる
2. 成功時の手動更新通信を DevTools で採取し、`/extend/do` の request payload と cookie を比較する
3. Turnstile token 注入だけでなく、ページ側が期待する JS state の差分を確認する

### 優先度中

1. `submit_button` が有効化される条件を DOM event ベースで追う
2. `renew.user.js` のブラウザ内動作と `main.mjs` の差分を比較する
3. self-hosted runner とローカル実行での network trace を突き合わせる

## 現時点の結論

2026-03-22 時点では、`main.mjs` 自体はローカル環境では成功しており、GitHub-hosted runner でのみ「更新画面の送信まではできるが、XServer 側の認証を通過できていない」状態です。

今のログからは以下の可能性が高いです。

- GitHub-hosted runner 環境では Turnstile token が受理されにくい
- 画面側の JavaScript state を hidden input 注入だけでは再現できていない
- 実行環境差により、サーバ側の判定条件が変わっている

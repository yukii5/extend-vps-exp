[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/drive/1l1fAyDzNSSCVOF_JBpXRp2b3SHuI5bz6?usp=sharing) 精度 100%、CAPTCHA の重み: xserver_captcha.keras [リポジトリ](https://github.com/GitHub30/captcha-cloudrun)

[![](https://github.com/user-attachments/assets/f3db034f-1b1b-4983-9f9a-06a3aeb1b64e)](https://colab.research.google.com/drive/1l1fAyDzNSSCVOF_JBpXRp2b3SHuI5bz6?usp=sharing)

マニュアル
https://motoki-design.co.jp/wordpress/xserver-vps-auto-renew/

![Clipchamp7-ezgif com-video-to-gif-converter](https://github.com/user-attachments/assets/745a85ef-0d5a-4532-9774-3b7fcb2c8b52)

Tampermonkey スクリプトを作成しました。 [インストール](https://raw.githubusercontent.com/GitHub30/extend-vps-exp/refs/heads/main/renew.user.js)

その後、以下へアクセスしてください。
https://secure.xserver.ne.jp/xapanel/login/xvps/

動作しない場合は、GitHub Actions の Secrets に環境変数を設定してください。

```env
EMAIL=your@gmail.com
PASSWORD=yourpassword
PROXY_SERVER=http://user:password@example.com:8888
```

<details><summary>プロキシサーバーのインストール</summary>

```bash
apt update
apt install -y tinyproxy
echo Allow 0.0.0.0/0 >> /etc/tinyproxy/tinyproxy.conf
echo BasicAuth user password >> /etc/tinyproxy/tinyproxy.conf
systemctl restart tinyproxy
systemctl status tinyproxy
```
</details>

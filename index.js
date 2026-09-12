import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  // ----------------------------------------------------
  // 基準①: トップページ（URL入力画面）を表示する
  // ----------------------------------------------------
  if (!pathPart) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Render Private Proxy</title>
        <style>
          body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f2f5; }
          .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: 100%; max-width: 400px; text-align: center; }
          h2 { margin-top: 0; color: #1a1a1a; font-size: 22px; }
          input[type="text"] { width: 100%; padding: 12px; margin: 18px 0; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
          button { width: 100%; padding: 12px; background: #28a745; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
          button:hover { background: #218838; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>アクセスしたいURLを入力</h2>
          <form action="/set-target" method="POST">
            <input type="text" name="url" placeholder="example.com" required autofocus>
            <button type="submit">Go</button>
          </form>
        </div>
      </body>
      </html>
    `);
    return;
  }

  // ----------------------------------------------------
  // 基準②: フォームからURLが送信されたらBase64にしてリダイレクト
  // ----------------------------------------------------
  if (req.method === "POST" && urlObj.pathname === "/set-target") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      let inputUrl = params.get("url") || "";
      if (!inputUrl.startsWith("http")) inputUrl = "https://" + inputUrl;

      // URLを安全なBase64文字列に変換（パディング文字 '=' を除外してスマートに）
      const b64 = Buffer.from(inputUrl).toString("base64").replace(/=/g, "");
      
      res.writeHead(302, { "Location": `/${b64}` });
      res.end();
    });
    return;
  }

  // ----------------------------------------------------
  // 基準③: パスにあるBase64をデコードして、本物のサイトに通信
  // ----------------------------------------------------
  try {
    // 削った「=」を復元してデコードする
    let b64String = pathPart;
    while (b64String.length % 4 !== 0) { b64String += "="; }
    const targetUrl = Buffer.from(b64String, "base64").toString("utf-8");
    const parsedTarget = new URL(targetUrl);

    // 通信先のプロトコルに合わせてhttpモジュールを切り替え
    const client = targetUrl.startsWith("https") ? https : http;

    // リクエストヘッダーをコピー（一部プロキシで不具合が出るものは削除）
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.referer;

    client.get(targetUrl, { headers }, (targetRes) => {
      const contentType = targetRes.headers["content-type"] || "";

      // 🔥 もしデータがHTMLなら、中身の「あらゆる相対パス」を自動でBase64に書き換える！
      if (contentType.includes("text/html")) {
        let htmlData = "";
        targetRes.on("data", chunk => { htmlData += chunk; });
        targetRes.on("end", () => {
          
          // ダブルクォーテーション、シングルクォーテーション両方の相対パス（/から始まるパス）をキャッチ
          // 例: href="/css/style.css" や src='/js/app.js'
          htmlData = htmlData.replace(/(href|src)=["']\/([^"']*)["']/g, (match, attr, path) => {
            // クエリパラメータ（?や#）も巻き込んで完全な絶対URLを作る
            const fullAbsoluteUrl = `${parsedTarget.origin}/${path}`;
            // その絶対URLを丸ごとBase64化する！
            const b64Url = Buffer.from(fullAbsoluteUrl).toString("base64").replace(/=/g, "");
            return `${attr}="/${b64Url}"`;
          });

          res.writeHead(targetRes.statusCode, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlData);
        });
      } else {
        // 画像、CSS、JSファイル、動画などは中身をいじらずそのまま最速で流し込む
        res.writeHead(targetRes.statusCode, targetRes.headers);
        targetRes.pipe(res);
      }
    }).on("error", () => {
      res.writeHead(500);
      res.end("ターゲットサイトとの通信に失敗しました。");
    });

  } catch (err) {
    res.writeHead(400);
    res.end("有効なBase64URLではないか、セッションが切れました。トップページからやり直してください。");
  }
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

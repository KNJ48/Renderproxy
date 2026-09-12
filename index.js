import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

// 1人専用：直前にアクセスしたベースURL（ドメイン）をメモリに1つだけ記憶
let lastBaseUrl = "";

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  let targetUrl = "";

  // ----------------------------------------------------
  // 1. フォームからURLが送信（POST）された場合の処理
  // ----------------------------------------------------
  if (req.method === "POST" && urlObj.pathname === "/set-target") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      let inputUrl = params.get("url") || "";
      if (!inputUrl.startsWith("http")) inputUrl = "https://" + inputUrl;

      const parsedTarget = new URL(inputUrl);
      lastBaseUrl = parsedTarget.origin; // ドメインを記憶

      console.log(`🚀 ターゲットを設定しました: ${lastBaseUrl}`);
      
      // 最初の大成功したコードと全く同じ方法で、その場で即座にサイトを読み込んでブラウザに返す！
      try {
        const client = lastBaseUrl.startsWith("https") ? https : http;
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.referer;

        client.get(lastBaseUrl, { headers }, (targetRes) => {
          res.writeHead(targetRes.statusCode, targetRes.headers);
          targetRes.pipe(res); // 100%そのまま横流し
        }).on("error", () => {
          res.writeHead(500); res.end("ターゲットとの通信に失敗しました。");
        });
      } catch (err) {
        res.writeHead(500); res.end("エラーが発生しました。");
      }
    });
    return;
  }

  // ----------------------------------------------------
  // 2. ブラウザがトップページ（パスなし）を通常読み込み・リロードした場合
  // ----------------------------------------------------
  if (!pathPart) {
    // 記憶を完全に消去してリセットする
    lastBaseUrl = "";
    console.log("🧹 リロードまたはトップアクセスにより、記憶を完全に消去しました。");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Render Private Proxy</title>
        <style>
          body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f2f5; }
          .card { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 400px; text-align: center; }
          input[type="text"] { width: 100%; padding: 10px; margin: 15px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 16px; }
          button { width: 100%; padding: 10px; background: #007bff; color: white; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
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
  // 3. 通信の振り分け（画像やCSS、ページ内のリンク移動など）
  // ----------------------------------------------------
  if (lastBaseUrl) {
    targetUrl = `${lastBaseUrl}/${pathPart}${urlObj.search}`;
    console.log(` └ 転送: ${targetUrl}`);

    // ここも最初の大成功した通信コードと100%同じ記述に戻しました
    try {
      const client = targetUrl.startsWith("https") ? https : http;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.referer;

      client.get(targetUrl, { headers }, (targetRes) => {
        res.writeHead(targetRes.statusCode, targetRes.headers);
        targetRes.pipe(res);
      }).on("error", () => {
        res.writeHead(500); res.end("ターゲットとの通信に失敗しました。");
      });
    } catch (err) {
      res.writeHead(500); res.end("エラーが発生しました。");
    }
  } else {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("セッションがありません。上のリロードボタンを押してやり直してください。");
  }
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

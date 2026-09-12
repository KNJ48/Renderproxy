import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

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

      // 【修正のポイント】記憶は一切せず、その場で即座に指定されたURLをフェッチして返すだけ！
      console.log(`🚀 ターゲットへ接続: ${inputUrl}`);
      forwardRequest(inputUrl, req, res);
    });
    return;
  }

  // ----------------------------------------------------
  // 2. フォーム表示（最初のアクセス、およびブラウザで「リロード」したときは必ずここに来る）
  // ----------------------------------------------------
  if (!pathPart) {
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
  // 3. その他（エラー対応）
  // ----------------------------------------------------
  res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
  res.end("セッションがありません。上のリロードボタンを押してやり直してください。");

}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// 大成功していた、一番シンプルに通信を横流しする共通関数
function forwardRequest(targetUrl, req, res) {
  try {
    const client = targetUrl.startsWith("https") ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.referer;

    client.get(targetUrl, { headers }, (targetRes) => {
      res.writeHead(targetRes.statusCode, targetRes.headers);
      targetRes.pipe(res); // 100%そのまま横流し
    }).on("error", () => {
      res.writeHead(500); res.end("ターゲットとの通信に失敗しました。");
    });
  } catch (err) {
    res.writeHead(500); res.end("エラーが発生しました。");
  }
}

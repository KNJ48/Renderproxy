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
  // 1. 【ここが核心】パスなし（＝リロード、またはトップへのアクセス）の処理
  // ----------------------------------------------------
  if (!pathPart) {
    // 記憶していたドメインを綺麗さっぱり消し去る（完全リセット）
    lastBaseUrl = "";
    console.log("🧹 リロードされたため、記憶を完全に消去しました。");

    // URL入力画面を表示
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
  // 2. フォームからURLが送信された場合の処理
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

      console.log(`🚀 ターゲットを設定: ${lastBaseUrl}`);
      
      // 登録したら、アドレスバーのURLを汚さないように「/」にリダイレクトしてページを表示させる
      res.writeHead(302, { "Location": "/" });
      res.end();
    });
    return;
  }

  // ----------------------------------------------------
  // 3. 通信の振り分け（画像やCSSなどの裏の通信を流す）
  // ----------------------------------------------------
  if (lastBaseUrl) {
    // 記憶しておいたドメインのあとに、届いたパスとクエリをそのまま合体
    targetUrl = `${lastBaseUrl}/${pathPart}${urlObj.search}`;
    console.log(` └ 転送: ${targetUrl}`);
  } else {
    res.writeHead(400); res.end("セッションがありません。トップページからやり直してください。");
    return;
  }

  // ----------------------------------------------------
  // 4. ターゲットのサイトへ通信を横流し
  // ----------------------------------------------------
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
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

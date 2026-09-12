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
  // 1. トップページ（URL入力画面）
  // ----------------------------------------------------
  if (!pathPart && !lastBaseUrl) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <form action="/set-target" method="POST">
        <input type="text" name="url" placeholder="example.com" required autofocus>
        <button type="submit">Go</button>
      </form>
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

      // ドメインを記憶
      const parsedTarget = new URL(inputUrl);
      lastBaseUrl = parsedTarget.origin;

      console.log(`🆕 フォームからドメインを記憶: ${lastBaseUrl}`);
      
      // そのままターゲットのトップページへ移動させる
      res.writeHead(302, { "Location": "/" });
      res.end();
    });
    return;
  }

  // ----------------------------------------------------
  // 3. 通信の振り分け（Denoのときと全く同じロジック）
  // ----------------------------------------------------
  // パスがBase64のURL（＝手動でBase64でアクセスしてきた場合など）
  if (pathPart.startsWith("aHR0c")) {
    try {
      let b64String = pathPart;
      while (b64String.length % 4 !== 0) { b64String += "="; }
      targetUrl = Buffer.from(b64String, "base64").toString("utf-8");
      
      const parsedTarget = new URL(targetUrl);
      lastBaseUrl = parsedTarget.origin; // ドメインを更新して記憶
      console.log(`🆕 Base64からドメインを記憶: ${lastBaseUrl}`);
    } catch {
      res.writeHead(400); res.end("Base64のデコードに失敗しました");
      return;
    }
  } 
  // パスが普通の文字列（＝画像やCSS、フォーム設定後のトップページなど）
  else if (lastBaseUrl) {
    // 記憶しておいたドメインのあとに、届いたパスとクエリをそのまま合体
    targetUrl = `${lastBaseUrl}/${pathPart}${urlObj.search}`;
    console.log(` └ 記憶したベースから転送: ${targetUrl}`);
  } 
  else {
    res.writeHead(400); res.end("最初にURLを設定してください。");
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
      // データの改変は一切せず、ヘッダーも中身も100%そのままブラウザに横流し
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

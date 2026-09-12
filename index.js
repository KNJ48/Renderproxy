import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  let targetUrl = "";

  // ----------------------------------------------------
  // 1. フォームからURLが送信された場合の処理
  // ----------------------------------------------------
  if (req.method === "POST" && urlObj.pathname === "/set-target") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      let inputUrl = params.get("url") || "";
      if (!inputUrl.startsWith("http")) inputUrl = "https://" + inputUrl;

      // 【修正の核心】ドメインは記憶しない！
      // 入力されたURL全体を安全なBase64文字列に変換する
      const b64 = Buffer.from(inputUrl).toString("base64").replace(/=/g, "");
      
      // アドレスバーのURLをBase64に書き換えてリダイレクトする
      res.writeHead(302, { "Location": `/${b64}` });
      res.end();
    });
    return;
  }

  // ----------------------------------------------------
  // 2. 通信の振り分け（手動Base64、またはフォーム送信後の通信）
  // ----------------------------------------------------
  // パスがBase64のURL（＝現在開いているページのURL）の場合
  if (pathPart.startsWith("aHR0c")) {
    try {
      let b64String = pathPart;
      while (b64String.length % 4 !== 0) { b64String += "="; }
      // アドレスバーにあるBase64をデコードして、本物の通信先にする
      targetUrl = Buffer.from(b64String, "base64").toString("utf-8");
      console.log(`👁️ 閲覧中: ${targetUrl}`);
    } catch {
      res.writeHead(400); res.end("Base64のデコードに失敗しました");
      return;
    }
  } 
  // パスも記憶も何もない場合（最初のアクセス、またはブラウザで「再読み込み」した時！）
  else {
    // 記憶を一切していないので、リロード（パスが空）されたら100%確実にここに来る！
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
  // 3. ターゲットのサイトへ通信を横流し（大成功したコードと100%同じ処理）
  // ----------------------------------------------------
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
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

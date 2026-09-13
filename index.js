import http from 'http';
import https from 'https';

// 【唯一の違い】Renderの環境に合わせてポートを設定（なければ3000）
const PORT = process.env.PORT || 3000;

// 1人専用：直前にアクセスしたベースURL（ドメイン）をメモリに1つだけ記憶
let lastBaseUrl = "";

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  let targetUrl = "";

  // ----------------------------------------------------
  // 1. パスなし（トップページ）の処理
  // ----------------------------------------------------
  if (!pathPart && !lastBaseUrl) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("最初にURLをBase64にして、ドメインの後ろにくっつけてアクセスしてください。");
    return;
  }

  // ----------------------------------------------------
  // 2. 通信の振り分け（ローカルで大成功したロジックと完全同一）
  // ----------------------------------------------------
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
  else if (lastBaseUrl) {
    targetUrl = `${lastBaseUrl}/${pathPart}${urlObj.search}`;
    console.log(` └ 記憶したベースから転送: ${targetUrl}`);
  } 
  else {
    res.writeHead(400); res.end("最初にURLを設定してください。");
    return;
  }

  // ----------------------------------------------------
  // 3. ターゲットのサイトへ通信を横流し（完全同一の処理）
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

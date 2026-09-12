import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  let targetUrl = "";

  // ----------------------------------------------------
  // 1. 【核心】開いた瞬間にプロンプトを出し、その場でBase64化してジャンプする処理
  // ----------------------------------------------------
  if (!pathPart) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    // 余計なフォームや自動送信は一切なし。
    // プロンプトに入力されたURLを、ブラウザの標準機能（btoa）でBase64にしてそのまま移動するだけ！
    res.end(`
      <script>
        let url = prompt("アクセスしたいURLを入力してください（例: https://example.com）:");
        if (url) {
          if (!url.startsWith("http")) url = "https://" + url;
          // ブラウザ側でBase64に一瞬で変換して、自分のドメインの直後にくっつけて移動する
          const b64 = btoa(url).replace(/=/g, "");
          window.location.href = "/" + b64;
        } else {
          document.body.innerHTML = "URLが入力されませんでした。再読み込みしてやり直してください。";
        }
      </script>
    `);
    return;
  }

  // ----------------------------------------------------
  // 2. 通信の振り分け（大成功したコードと100%同じロジック）
  // ----------------------------------------------------
  if (pathPart.startsWith("aHR0c")) {
    try {
      let b64String = pathPart;
      while (b64String.length % 4 !== 0) { b64String += "="; }
      targetUrl = Buffer.from(b64String, "base64").toString("utf-8");
      console.log(`👁️ 閲覧中: ${targetUrl}`);
    } catch {
      res.writeHead(400); res.end("Base64のデコードに失敗しました");
      return;
    }
  } else {
    res.writeHead(400); res.end("セッションがありません。上のリロードボタンを押してやり直してください。");
    return;
  }

  // ----------------------------------------------------
  // 3. ターゲットのサイトへ通信を横流し（100%そのままの成功コード）
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

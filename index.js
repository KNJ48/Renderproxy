import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  let targetUrl = "";

  // ----------------------------------------------------
  // 共通処理: iframeでの埋め込みや別ドメインからの通信を100%許可するヘッダー
  // ----------------------------------------------------
  const setSecurityBypassHeaders = (statusCode, customHeaders = {}) => {
    const baseHeaders = {
      // 1. 【核心】iframe禁止コマンドを徹底的にへし折る・上書きする
      "X-Frame-Options": "ALLOWALL", 
      "Content-Security-Policy": "frame-ancestors *", 
      // 2. ブラウザのドメイン制限（CORS）を完全に無効化してどこからでも通信可能にする
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };
    res.writeHead(statusCode, { ...targetResHeadersFilter(customHeaders), ...baseHeaders });
  };

  // ターゲットサイトのヘッダーから、iframeを禁止する邪魔な設定だけを消すフィルター
  const targetResHeadersFilter = (headers) => {
    const cleanHeaders = { ...headers };
    delete cleanHeaders['x-frame-options'];
    delete cleanHeaders['content-security-policy'];
    return cleanHeaders;
  };

  // ----------------------------------------------------
  // 1. 開いた瞬間にプロンプトを出す処理（iframe内でぴこんっと動く）
  // ----------------------------------------------------
  if (!pathPart) {
    setSecurityBypassHeaders(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <script>
        // iframe内でも確実にプロンプトが起動する
        let url = prompt("アクセスしたいURLを入力してください（例: https://example.com）:");
        if (url) {
          if (!url.startsWith("http")) url = "https://" + url;
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
      console.log(`👁️ iframe内での閲覧中: ${targetUrl}`);
    } catch {
      setSecurityBypassHeaders(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("Base64のデコードに失敗しました");
      return;
    }
  } else {
    setSecurityBypassHeaders(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("セッションがありません。上のリロードボタンを押してやり直してください。");
    return;
  }

  // ----------------------------------------------------
  // 3. ターゲットのサイトへ通信を横流し（ヘッダーだけiframe用に魔改造）
  // ----------------------------------------------------
  try {
    const client = targetUrl.startsWith("https") ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.referer;

    client.get(targetUrl, { headers }, (targetRes) => {
      // ターゲットサイト自体が「iframe禁止」と言ってきても、そのヘッダーを上書きしてブラウザに流す！
      setSecurityBypassHeaders(targetRes.statusCode, targetRes.headers);
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

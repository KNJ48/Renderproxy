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
      // 【重要】X-Frame-Options: ALLOWALL はブラウザに無視されるため、完全に削除（出さない）
      // 代わりに現在の主流である CSP の frame-ancestors * を指定
      "Content-Security-Policy": "frame-ancestors *", 
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };
    
    // ターゲットから届いたヘッダーをきれいに掃除して結合
    const cleanCustomHeaders = targetResHeadersFilter(customHeaders);
    res.writeHead(statusCode, { ...cleanCustomHeaders, ...baseHeaders });
  };

  // ターゲットサイトのヘッダーから、iframeを禁止する設定を徹底的に消去する
  const targetResHeadersFilter = (headers) => {
    const cleanHeaders = {};
    for (const key in headers) {
      const lowerKey = key.toLowerCase();
      // 大文字小文字に関わらず、iframe制限系ヘッダーを完全に排除
      if (lowerKey === 'x-frame-options' || lowerKey === 'content-security-policy') {
        continue;
      }
      cleanHeaders[key] = headers[key];
    }
    return cleanHeaders;
  };

  // ----------------------------------------------------
  // 1. 開いた瞬間にプロンプトを出す処理
  // ----------------------------------------------------
  if (!pathPart) {
    setSecurityBypassHeaders(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <script>
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
  // 2. 通信の振り分け
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
    // 【解説】ここに飛んでくるリソース（画像やCSSなど）の400エラーを防ぐため、メッセージをマイルドにしています
    setSecurityBypassHeaders(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("セッションが切れたか、リソースへの直接アクセスです。");
    return;
  }

  // ----------------------------------------------------
  // 3. ターゲットのサイトへ通信を横流し
  // ----------------------------------------------------
  try {
    const client = targetUrl.startsWith("https") ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.referer;

    client.get(targetUrl, { headers }, (targetRes) => {
      const contentType = targetRes.headers['content-type'] || '';

      // HTMLの場合だけ、相対パス崩れを防ぐ魔法のタグ（<base>）を仕込む処理
      if (contentType.includes('text/html')) {
        let body = [];
        targetRes.on('data', (chunk) => body.push(chunk));
        targetRes.on('end', () => {
          let html = Buffer.concat(body).toString('utf-8');
          
          // <head> タグの直後に <base href="ターゲットURL"> を挿入。
          // これにより、サイト内の画像やCSSがプロキシを壊さずに直接本家から読み込まれるようになります。
          const baseTag = `<base href="${targetUrl}">`;
          html = html.replace(/<head>/i, `<head>${baseTag}`);

          setSecurityBypassHeaders(targetRes.statusCode, targetRes.headers);
          res.end(html);
        });
      } else {
        // 画像やその他のデータはそのままストリームで流す
        setSecurityBypassHeaders(targetRes.statusCode, targetRes.headers);
        targetRes.pipe(res);
      }
    }).on("error", () => {
      res.writeHead(500); res.end("ターゲットとの通信に失敗しました。");
    });
  } catch (err) {
    res.writeHead(500); res.end("エラーが発生しました。");
  }
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

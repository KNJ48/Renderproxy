import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1); // 先頭の "/" を削る

  let targetUrl = "";

  // ----------------------------------------------------
  // 1. プロンプトからURLが送信（POST）された場合の処理
  // ----------------------------------------------------
  if (req.method === "POST" && urlObj.pathname === "/set-target") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      let inputUrl = params.get("url") || "";
      if (!inputUrl.startsWith("http")) inputUrl = "https://" + inputUrl;

      // 記憶はせず、入力されたURL全体をBase64に変換してアドレスバーへ
      const b64 = Buffer.from(inputUrl).toString("base64").replace(/=/g, "");
      
      res.writeHead(302, { "Location": `/${b64}` });
      res.end();
    });
    return;
  }

  // ----------------------------------------------------
  // 2. 【ここが核心】開いた瞬間に上からプロンプトを「ぴこん」と出す処理
  // ----------------------------------------------------
  if (!pathPart) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    // ダサい画面は出さず、ブラウザの標準プロンプトを起動して裏で自動送信する
    res.end(`
      <script>
        const url = prompt("アクセスしたいURLを入力してください（例: example.com）:");
        if (url) {
          // 入力されたら、見えないフォームを作って一瞬でサーバーにPOST送信する
          const form = document.createElement("form");
          form.method = "POST";
          form.action = "/set-target";
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = "url";
          input.value = url;
          form.appendChild(input);
          document.body.appendChild(form);
          form.submit();
        } else {
          // キャンセルされたら文字を表示
          document.body.innerHTML = "URLが入力されませんでした。再読み込みしてやり直してください。";
        }
      </script>
    `);
    return;
  }

  // ----------------------------------------------------
  // 3. 通信の振り分け（手動Base64、またはフォーム送信後の通信）
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
  // 4. ターゲットのサイトへ通信を横流し（大成功したコードと100%同じ処理）
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

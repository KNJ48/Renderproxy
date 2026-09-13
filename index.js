```js
import http from "http";

const PORT = process.env.PORT || 3000;

// プロキシ側のRender URL
const PROXY_URL = "https://YOUR-PROXY.onrender.com";

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>Web Proxy Viewer</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #111;
      font-family: Arial, sans-serif;
    }

    #topbar {
      width: 100%;
      height: 52px;

      display: flex;
      align-items: center;
      gap: 8px;

      padding: 8px 10px;

      background: #1b1b1b;
      border-bottom: 1px solid #333;
    }

    #urlInput {
      flex: 1;
      min-width: 0;

      height: 36px;
      padding: 0 12px;

      border: 1px solid #444;
      border-radius: 6px;

      background: #252525;
      color: white;

      font-size: 14px;
      outline: none;
    }

    #urlInput:focus {
      border-color: #777;
    }

    #openButton {
      height: 36px;
      padding: 0 15px;

      border: none;
      border-radius: 6px;

      background: #3a3a3a;
      color: white;

      cursor: pointer;
      font-size: 14px;
    }

    #openButton:hover {
      background: #505050;
    }

    #frame {
      display: block;

      width: 100%;
      height: calc(100% - 52px);

      border: none;

      background: white;
    }
  </style>
</head>

<body>

  <div id="topbar">
    <input
      id="urlInput"
      type="text"
      placeholder="https://example.com"
      autocomplete="off"
      spellcheck="false"
    >

    <button id="openButton">開く</button>
  </div>

  <iframe
    id="frame"
    src="about:blank"
    allowfullscreen>
  </iframe>

  <script>
    const PROXY_URL = ${JSON.stringify(PROXY_URL)};

    const urlInput = document.getElementById("urlInput");
    const openButton = document.getElementById("openButton");
    const frame = document.getElementById("frame");

    function encodeBase64(text) {
      const bytes = new TextEncoder().encode(text);

      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      return btoa(binary).replace(/=/g, "");
    }

    function openUrl() {
      let targetUrl = urlInput.value.trim();

      if (!targetUrl) {
        return;
      }

      if (!/^https?:\\/\\//i.test(targetUrl)) {
        targetUrl = "https://" + targetUrl;
      }

      try {
        new URL(targetUrl);
      } catch {
        alert("URLが正しくありません。");
        return;
      }

      const encodedUrl = encodeBase64(targetUrl);

      const proxyUrl =
        PROXY_URL.replace(/\\/$/, "") + "/" + encodedUrl;

      console.log("Target URL:", targetUrl);
      console.log("Proxy URL:", proxyUrl);

      frame.src = proxyUrl;
    }

    openButton.addEventListener("click", openUrl);

    urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        openUrl();
      }
    });
  </script>

</body>
</html>`;

const server = http.createServer((req, res) => {

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    res.end(html);
    return;
  }

  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
```

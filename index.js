import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const VERSION = "4.0.0";

// =============================================
// CONFIG
// =============================================

const MAX_HTML = 8 * 1024 * 1024;
const MAX_WS_MESSAGE = 2 * 1024 * 1024;
const MAX_WS_BUFFER = 4 * 1024 * 1024;

const MAX_REQUESTS = 40;
const MAX_WEBSOCKETS = 15;

// 元のプロキシと同じ記憶方式
let lastBaseUrl = "";

let httpCount = 0;
let wsCount = 0;

let activeRequests = 0;
let activeWebSockets = 0;

// =============================================
// LOG
// =============================================

function log(type, message) {
  console.log(
    `[${new Date().toISOString()}] [${type}] ${message}`
  );
}

// =============================================
// BASE64
// =============================================

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+_=-]+$/.test(value)) {
    throw new Error("Invalid Base64");
  }

  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  return Buffer.from(
    normalized,
    "base64"
  ).toString("utf8");
}

function normalizeURL(value) {
  let text = String(value).trim();

  if (!/^https?:\/\//i.test(text)) {
    text = "https://" + text;
  }

  const url = new URL(text);

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error("Unsupported protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials not allowed");
  }

  return url;
}

// =============================================
// NETWORK SAFETY
// =============================================

function isPublicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;

  const [a, b, c] = ip.split(".").map(Number);

  if (a === 0 || a === 10 || a === 127) return false;
  if (a >= 224) return false;

  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;

  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 88 && c === 99) return false;

  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;

  return true;
}

function validateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid")
  ) {
    throw new Error("Forbidden hostname");
  }

  if (net.isIP(host)) {
    if (!isPublicIPv4(host)) {
      throw new Error("Forbidden IP");
    }

    return;
  }

  if (!host.includes(".")) {
    throw new Error("Invalid hostname");
  }
}

function safeLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  try {
    validateHostname(hostname);

    if (net.isIP(hostname) === 4) {
      if (options?.all) {
        callback(null, [{
          address: hostname,
          family: 4
        }]);
      } else {
        callback(null, hostname, 4);
      }

      return;
    }

    dns.lookup(
      hostname,
      {
        all: true,
        family: 4
      },
      (error, addresses) => {
        if (error) {
          callback(error);
          return;
        }

        if (
          !addresses.length ||
          addresses.some(
            item => !isPublicIPv4(item.address)
          )
        ) {
          callback(
            new Error("Unsafe DNS result")
          );
          return;
        }

        if (options?.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, 4);
        }
      }
    );

  } catch (error) {
    callback(error);
  }
}

const httpAgent = new http.Agent({
  keepAlive: false,
  lookup: safeLookup
});

const httpsAgent = new https.Agent({
  keepAlive: false,
  lookup: safeLookup
});

// =============================================
// BROWSER WEBSOCKET RUNTIME
// =============================================

function createRuntime(targetURL) {
  const source = String.raw`
(function () {
  "use strict";

  if (window.__B64_PROXY_INSTALLED__) return;

  window.__B64_PROXY_INSTALLED__ = true;

  const TARGET_URL = __TARGET_URL__;
  const ORIGINAL = new URL(TARGET_URL);

  const NativeWebSocket = window.WebSocket;

  function encodeURL(value) {
    const bytes = new TextEncoder().encode(value);

    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function convertWebSocketURL(input) {
    const value = String(input);

    try {
      const url = new URL(value, TARGET_URL);

      // location.hostで作られた接続先を補正
      if (url.host === location.host) {
        url.host = ORIGINAL.host;
      }

      if (url.protocol === "https:") {
        url.protocol = "wss:";
      }

      if (url.protocol === "http:") {
        url.protocol = "ws:";
      }

      if (
        url.protocol !== "ws:" &&
        url.protocol !== "wss:"
      ) {
        return value;
      }

      const scheme =
        location.protocol === "https:" ? "wss:" : "ws:";

      const converted =
        scheme +
        "//" +
        location.host +
        "/__proxy_ws/" +
        encodeURL(url.href);

      console.log(
        "[PROXY WS]",
        value,
        "=>",
        url.href,
        "=>",
        converted
      );

      return converted;

    } catch (error) {
      console.warn(
        "[PROXY WS ERROR]",
        error
      );

      return value;
    }
  }

  if (NativeWebSocket) {
    class ProxyWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        const converted = convertWebSocketURL(url);

        if (protocols === undefined) {
          super(converted);
        } else {
          super(converted, protocols);
        }
      }
    }

    window.WebSocket = ProxyWebSocket;
  }

  console.log("[PROXY] WebSocket runtime v4.0 installed");
})();
`;

  return source.replace(
    "__TARGET_URL__",
    JSON.stringify(targetURL)
  );
}

// =============================================
// MINIMAL HTML MODIFICATION
// =============================================

function modifyHTML(html, req, targetURL) {

  // 元のコードと同じCSP meta削除
  html = html.replace(
    /<meta\b[^>]*(?:http-equiv\s*=\s*["']?\s*(?:content-security-policy|x-frame-options)\s*["']?)[^>]*>/gi,
    ""
  );

  // =========================================
  // BASE TAG（元の方式）
  // =========================================

  const hasBaseTag = /<base\b[^>]*>/i.test(html);

  if (!hasBaseTag) {
    const forwardedProto =
      req.headers["x-forwarded-proto"] ||
      (req.socket.encrypted ? "https" : "http");

    const proxyOrigin =
      `${forwardedProto}://${req.headers.host}/`;

    html = html.replace(
      /<head\b[^>]*>/i,
      match =>
        match + `\n<base href="${proxyOrigin}">\n`
    );
  }

  // =========================================
  // WEBSOCKET ONLY
  // =========================================

  const runtime = createRuntime(targetURL)
    .replace(/<\/script/gi, "<\\/script");

  const script = "<script>" + runtime + "</script>";

  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(
      /<head\b[^>]*>/i,
      match => match + "\n" + script
    );
  } else {
    html = script + html;
  }

  return html;
}

// =============================================
// HOME PAGE
// =============================================

const homeHTML = String.raw`
<!DOCTYPE html>
<html lang="ja">

<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Render Base64 Proxy</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #101218;
  color: white;
  font-family: Arial, sans-serif;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.container {
  width: min(90%, 650px);
  text-align: center;
}

h1 {
  font-size: 30px;
  margin-bottom: 12px;
}

p {
  color: #aeb5c5;
}

form {
  display: flex;
  gap: 10px;
  margin-top: 30px;
}

input {
  flex: 1;
  min-width: 0;
  background: #1c202b;
  color: white;
  border: 1px solid #343b4b;
  border-radius: 8px;
  padding: 15px;
  font-size: 16px;
}

button {
  border: none;
  border-radius: 8px;
  background: #426bdf;
  color: white;
  padding: 15px 25px;
  cursor: pointer;
  font-size: 16px;
}

button:hover {
  background: #557ff3;
}

.info {
  margin-top: 25px;
  font-size: 13px;
  color: #7e879a;
}

@media(max-width:500px) {
  form {
    flex-direction: column;
  }
}
</style>

</head>

<body>

<div class="container">

<h1>Render Base64 Proxy</h1>

<p>URLを入力してWebサイトを開く</p>

<form id="form">

<input
  id="url"
  placeholder="example.com"
  autocomplete="url"
  required
>

<button type="submit">OPEN</button>

</form>

<div class="info">
HTTP / HTTPS / WebSocket 対応
<br>
Base64 URL方式
</div>

</div>

<script>
document.getElementById("form").addEventListener(
  "submit",
  function(event) {
    event.preventDefault();

    try {
      let value =
        document.getElementById("url").value.trim();

      if (!/^https?:\/\//i.test(value)) {
        value = "https://" + value;
      }

      const url = new URL(value);

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        throw new Error("Invalid protocol");
      }

      const bytes = new TextEncoder().encode(url.href);

      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      // 従来の標準Base64を使用
      const encoded = btoa(binary);

      location.href = "/" + encoded;

    } catch (error) {
      alert("URLエラー: " + error.message);
    }
  }
);
</script>

</body>
</html>
`;

// =============================================
// HTTP SERVER
// =============================================

const server = http.createServer((req, res) => {
  let urlObj;

  try {
    urlObj = new URL(
      req.url,
      `http://${req.headers.host}`
    );
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const pathPart = urlObj.pathname.slice(1);

  // =========================================
  // HEALTH
  // =========================================

  if (urlObj.pathname === "/__health") {
    res.writeHead(200, {
      "content-type": "application/json"
    });

    res.end(JSON.stringify({
      version: VERSION,
      status: "ok",
      lastBaseUrl,
      activeRequests,
      activeWebSockets
    }));

    return;
  }

  // =========================================
  // HOME
  // =========================================

  if (!pathPart) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });

    res.end(homeHTML);
    return;
  }

  // =========================================
  // TARGET RESOLUTION
  // =========================================

  let targetUrl = "";

  try {

    // 従来のBase64 URL
    // https:// のBase64は aHR0cHM6
    // http:// のBase64は aHR0cDov
    // スキーム省略のBase64にも対応

    let decoded = null;

    try {
      const candidate = decodeBase64(pathPart);

      const normalized = normalizeURL(candidate);

      // Base64がURLとして成立する場合
      if (normalized.hostname) {
        decoded = normalized;
      }
    } catch {
      // 通常のパスとして処理
    }

    if (decoded) {
      // Base64の後ろのクエリを転送
      if (urlObj.search) {
        const extra = new URLSearchParams(urlObj.search);

        for (const [key, value] of extra) {
          decoded.searchParams.append(key, value);
        }
      }

      targetUrl = decoded.href;

      lastBaseUrl = decoded.origin;

      log(
        "BASE",
        `Base64からドメインを記憶: ${lastBaseUrl}`
      );
    }

    // 普通のパス
    else if (lastBaseUrl) {
      targetUrl =
        lastBaseUrl +
        urlObj.pathname +
        urlObj.search;

      log(
        "PATH",
        `記憶したベースから転送: ${targetUrl}`
      );
    }

    else {
      res.writeHead(400, {
        "content-type": "text/plain; charset=utf-8"
      });

      res.end(
        "最初にBase64化したURLでアクセスしてください。"
      );

      return;
    }

    const target = normalizeURL(targetUrl);

    validateHostname(target.hostname);

    targetUrl = target.href;

  } catch (error) {
    res.writeHead(400);
    res.end("Invalid URL: " + error.message);
    return;
  }

  // =========================================
  // REQUEST LIMIT
  // =========================================

  if (activeRequests >= MAX_REQUESTS) {
    res.writeHead(503);
    res.end("Too many requests");
    return;
  }

  activeRequests++;

  let finished = false;

  function finish() {
    if (finished) return;

    finished = true;
    activeRequests--;
  }

  res.once("close", finish);

  const id = ++httpCount;

  log(
    "HTTP",
    `#${id} ${req.method} ${targetUrl}`
  );

  // =========================================
  // UPSTREAM HTTP
  // =========================================

  const target = new URL(targetUrl);

  const client =
    target.protocol === "https:"
      ? https
      : http;

  const headers = { ...req.headers };

  // 元の方式に近いヘッダー処理
  delete headers.host;
  delete headers.referer;

  // 中継用ヘッダーは上流に送らない
  delete headers.connection;
  delete headers["proxy-connection"];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];

  headers["accept-encoding"] = "identity";

  // Originが送られてきた場合のみ補正
  if (headers.origin) {
    headers.origin = target.origin;
  }

  const upstream = client.request(
    target,
    {
      method: req.method,
      headers,
      agent:
        target.protocol === "https:"
          ? httpsAgent
          : httpAgent,
      timeout: 30000
    },
    targetRes => {

      // =====================================
      // RESPONSE HEADERS
      // =====================================

      const responseHeaders = {
        ...targetRes.headers
      };

      delete responseHeaders["x-frame-options"];
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["content-security-policy-report-only"];

      // 元のコードと同じ
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];

      const contentType =
        responseHeaders["content-type"] || "";

      const status = targetRes.statusCode || 200;

      log(
        "RESPONSE",
        `#${id} ${status} ${contentType}`
      );

      // リダイレクト先はBase64化
      if (
        status >= 300 &&
        status < 400 &&
        targetRes.headers.location
      ) {
        try {
          const redirect = new URL(
            targetRes.headers.location,
            target
          );

          normalizeURL(redirect.href);
          validateHostname(redirect.hostname);

          responseHeaders.location =
            "/" +
            Buffer.from(
              redirect.href,
              "utf8"
            ).toString("base64url");

        } catch (error) {
          delete responseHeaders.location;

          log(
            "REDIRECT ERROR",
            error.message
          );
        }
      }

      // =====================================
      // NON-HTML
      // =====================================

      if (
        !contentType.toLowerCase().includes("text/html")
      ) {
        res.writeHead(
          status,
          responseHeaders
        );

        targetRes.pipe(res);

        return;
      }

      // =====================================
      // HTML
      // =====================================

      const chunks = [];
      let size = 0;
      let exceeded = false;

      targetRes.on("data", chunk => {
        size += chunk.length;

        if (size > MAX_HTML) {
          exceeded = true;

          targetRes.destroy(
            new Error("HTML too large")
          );

          return;
        }

        chunks.push(chunk);
      });

      targetRes.on("end", () => {
        if (exceeded) return;

        try {
          let html = Buffer.concat(chunks)
            .toString("utf8");

          // 元のHTMLをできるだけ維持
          html = modifyHTML(
            html,
            req,
            targetUrl
          );

          // 元のiframe対応
          responseHeaders["x-frame-options"] =
            "ALLOWALL";

          responseHeaders["content-security-policy"] =
            "frame-ancestors *";

          responseHeaders["content-type"] =
            "text/html; charset=utf-8";

          delete responseHeaders["etag"];
          delete responseHeaders["content-md5"];

          const body = Buffer.from(
            html,
            "utf8"
          );

          res.writeHead(
            status,
            responseHeaders
          );

          res.end(body);

          log(
            "HTML",
            `#${id} ${body.length} bytes`
          );

        } catch (error) {
          log(
            "HTML ERROR",
            error.message
          );

          if (!res.headersSent) {
            res.writeHead(500);
          }

          res.end("HTML processing failed");
        }
      });

      targetRes.on("error", error => {
        log(
          "UPSTREAM ERROR",
          error.message
        );

        if (!res.headersSent) {
          res.writeHead(502);
        }

        res.end();
      });

      targetRes.on("close", () => {
        if (
          !targetRes.complete &&
          !res.writableEnded
        ) {
          if (!res.headersSent) {
            res.writeHead(502);
          }

          res.end("Upstream interrupted");
        }
      });
    }
  );

  upstream.on("timeout", () => {
    upstream.destroy(
      new Error("Request timeout")
    );
  });

  upstream.on("error", error => {
    log(
      "HTTP ERROR",
      `#${id} ${error.message}`
    );

    if (!res.headersSent) {
      res.writeHead(502);
    }

    res.end("Bad Gateway");
  });

  req.on("error", error => {
    upstream.destroy(error);
  });

  res.on("close", () => {
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  });

  req.pipe(upstream);
});

// =============================================
// WEBSOCKET SERVER
// =============================================

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_MESSAGE,
  perMessageDeflate: false
});

// =============================================
// WEBSOCKET UPGRADE
// =============================================

server.on("upgrade", (req, socket, head) => {
  try {
    const requestURL = new URL(
      req.url,
      "http://localhost"
    );

    if (
      !requestURL.pathname.startsWith(
        "/__proxy_ws/"
      )
    ) {
      socket.destroy();
      return;
    }

    if (activeWebSockets >= MAX_WEBSOCKETS) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
        "Connection: close\r\n\r\n"
      );

      socket.destroy();
      return;
    }

    const encoded =
      requestURL.pathname.slice(
        "/__proxy_ws/".length
      );

    const target = new URL(
      decodeBase64(encoded)
    );

    if (
      target.protocol !== "ws:" &&
      target.protocol !== "wss:"
    ) {
      throw new Error(
        "Invalid WebSocket protocol"
      );
    }

    validateHostname(target.hostname);

    wss.handleUpgrade(
      req,
      socket,
      head,
      clientWS => {
        wss.emit(
          "connection",
          clientWS,
          req,
          target.href
        );
      }
    );

  } catch (error) {
    log(
      "WS ERROR",
      error.message
    );

    socket.destroy();
  }
});

// =============================================
// WEBSOCKET RELAY
// =============================================

wss.on("connection", (clientWS, req, targetURL) => {
  const id = ++wsCount;

  activeWebSockets++;

  log(
    "WS OPEN",
    `#${id} ${targetURL}`
  );

  const target = new URL(targetURL);

  const origin =
    (target.protocol === "wss:"
      ? "https://"
      : "http://") +
    target.host;

  const protocolsHeader =
    req.headers["sec-websocket-protocol"];

  const protocols = protocolsHeader
    ? protocolsHeader
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
    : [];

  const upstreamWS = new WebSocket(
    targetURL,
    protocols,
    {
      headers: {
        Origin: origin
      },
      lookup: safeLookup,
      handshakeTimeout: 15000,
      maxPayload: MAX_WS_MESSAGE,
      perMessageDeflate: false
    }
  );

  let uploaded = 0;
  let downloaded = 0;

  let messagesUp = 0;
  let messagesDown = 0;

  let closed = false;

  const pending = [];
  let pendingBytes = 0;

  // =========================================
  // CLIENT -> UPSTREAM
  // =========================================

  clientWS.on("message", (data, isBinary) => {
    uploaded += data.length;
    messagesUp++;

    if (upstreamWS.readyState === WebSocket.OPEN) {
      if (
        upstreamWS.bufferedAmount > MAX_WS_BUFFER
      ) {
        clientWS.close(
          1013,
          "Backpressure"
        );

        return;
      }

      upstreamWS.send(
        data,
        {
          binary: isBinary
        }
      );

      return;
    }

    if (
      upstreamWS.readyState === WebSocket.CONNECTING
    ) {
      pendingBytes += data.length;

      if (pendingBytes > MAX_WS_BUFFER) {
        clientWS.close(
          1013,
          "Buffer full"
        );

        return;
      }

      pending.push({
        data,
        isBinary
      });
    }
  });

  // =========================================
  // UPSTREAM CONNECTED
  // =========================================

  upstreamWS.on("open", () => {
    log(
      "WS CONNECTED",
      `#${id} ${targetURL}`
    );

    for (const item of pending) {
      if (
        upstreamWS.readyState !== WebSocket.OPEN
      ) {
        break;
      }

      upstreamWS.send(
        item.data,
        {
          binary: item.isBinary
        }
      );
    }

    pending.length = 0;
    pendingBytes = 0;
  });

  // =========================================
  // UPSTREAM -> CLIENT
  // =========================================

  upstreamWS.on("message", (data, isBinary) => {
    downloaded += data.length;
    messagesDown++;

    if (
      clientWS.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (
      clientWS.bufferedAmount > MAX_WS_BUFFER
    ) {
      upstreamWS.close(
        1013,
        "Backpressure"
      );

      return;
    }

    clientWS.send(
      data,
      {
        binary: isBinary
      }
    );
  });

  // =========================================
  // ERRORS
  // =========================================

  upstreamWS.on("error", error => {
    log(
      "WS ERROR",
      `#${id} upstream: ${error.message}`
    );

    if (
      clientWS.readyState === WebSocket.OPEN
    ) {
      clientWS.close(
        1011,
        "Upstream error"
      );
    }
  });

  clientWS.on("error", error => {
    log(
      "WS ERROR",
      `#${id} client: ${error.message}`
    );
  });

  // =========================================
  // STATS
  // =========================================

  const statsTimer = setInterval(() => {
    log(
      "WS STATS",
      `#${id} ` +
      `UP=${(uploaded / 1024).toFixed(1)}KB ` +
      `DOWN=${(downloaded / 1024).toFixed(1)}KB ` +
      `MSG=${messagesUp}/${messagesDown}`
    );
  }, 5000);

  statsTimer.unref();

  function cleanup() {
    if (closed) return;

    closed = true;
    activeWebSockets--;

    clearInterval(statsTimer);
  }

  // =========================================
  // CLIENT CLOSE
  // =========================================

  clientWS.on("close", code => {
    cleanup();

    log(
      "WS CLOSE",
      `#${id} client (${code})`
    );

    if (
      upstreamWS.readyState === WebSocket.OPEN
    ) {
      upstreamWS.close();

    } else if (
      upstreamWS.readyState === WebSocket.CONNECTING
    ) {
      upstreamWS.terminate();
    }
  });

  // =========================================
  // UPSTREAM CLOSE
  // =========================================

  upstreamWS.on("close", code => {
    log(
      "WS CLOSE",
      `#${id} upstream (${code})`
    );

    if (
      clientWS.readyState === WebSocket.OPEN
    ) {
      clientWS.close();
    }
  });
});

// =============================================
// START
// =============================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log("====================================");
    console.log(" Render Base64 Proxy v4.0");
    console.log("====================================");
    console.log("");
    console.log("PORT:", PORT);
    console.log("HTTP/HTTPS: ENABLED");
    console.log("WS/WSS: ENABLED");
    console.log("WebSocket Host Fix: ENABLED");
    console.log("Legacy Base64: ENABLED");
    console.log("Query Parameters: ENABLED");
    console.log("HTTPS Auto Prefix: ENABLED");
    console.log("URL Input Homepage: ENABLED");
    console.log("Original HTTP Mode: ENABLED");
    console.log("HTML URL Rewriting: DISABLED");
    console.log("Last Base URL Memory: ENABLED");
    console.log("PROXY_TOKEN: NOT REQUIRED");
    console.log("");
    console.log("Server running!");
    console.log("");
  }
);

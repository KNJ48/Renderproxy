import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const VERSION = "3.4.0";

const MAX_HTML = 8 * 1024 * 1024;
const MAX_WS_MESSAGE = 2 * 1024 * 1024;
const MAX_WS_BUFFER = 4 * 1024 * 1024;

const MAX_REQUESTS = 40;
const MAX_WEBSOCKETS = 15;

let httpCount = 0;
let wsCount = 0;
let activeRequests = 0;
let activeWebSockets = 0;

// =====================================================
// LOG
// =====================================================

function log(type, message) {
  console.log(
    `[${new Date().toISOString()}] [${type}] ${message}`
  );
}

// =====================================================
// BASE64
// =====================================================

function encodeURL(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeURL(value) {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) {
    throw new Error("Invalid Base64");
  }

  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  return Buffer.from(normalized, "base64").toString("utf8");
}

function normalizeTargetURL(value) {
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

function proxyPath(url) {
  return "/" + encodeURL(url);
}

function getTarget(req) {
  const requestURL = new URL(req.url, "http://localhost");
  const encoded = requestURL.pathname.slice(1);

  if (!encoded) return null;

  const decoded = decodeURL(encoded);
  const target = normalizeTargetURL(decoded);

  // Base64の後ろに付いたクエリも転送
  if (requestURL.search) {
    const extra = new URLSearchParams(requestURL.search);

    for (const [key, value] of extra) {
      target.searchParams.append(key, value);
    }
  }

  return target;
}

// =====================================================
// NETWORK SAFETY
// =====================================================

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

    dns.lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }

      if (
        !addresses.length ||
        addresses.some(item => !isPublicIPv4(item.address))
      ) {
        callback(new Error("Unsafe DNS result"));
        return;
      }

      if (options?.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, 4);
      }
    });

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

// =====================================================
// BROWSER RUNTIME
// =====================================================

function createRuntime(targetURL) {
  const source = String.raw`
(function () {
  "use strict";

  if (window.__B64_PROXY_INSTALLED__) return;
  window.__B64_PROXY_INSTALLED__ = true;

  const TARGET_URL = __TARGET_URL__;
  const ORIGINAL = new URL(TARGET_URL);
  const PROXY_ORIGIN = location.origin;

  const NativeWebSocket = window.WebSocket;
  const NativeFetch = window.fetch;
  const NativeXHROpen = XMLHttpRequest.prototype.open;

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

  function isAlreadyProxied(url) {
    return (
      url.origin === PROXY_ORIGIN &&
      /^\/[A-Za-z0-9_-]+={0,2}$/.test(url.pathname)
    );
  }

  function convertURL(input) {
    const value = String(input);

    if (
      value.startsWith("#") ||
      /^(data:|blob:|javascript:|mailto:|tel:)/i.test(value)
    ) {
      return value;
    }

    try {
      const url = new URL(value, TARGET_URL);

      if (isAlreadyProxied(url)) {
        return url.href;
      }

      if (url.origin === PROXY_ORIGIN) {
        url.protocol = ORIGINAL.protocol;
        url.host = ORIGINAL.host;
      }

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        return value;
      }

      return "/" + encodeURL(url.href);

    } catch (error) {
      console.warn("[PROXY URL ERROR]", error);
      return value;
    }
  }

  function convertWebSocketURL(input) {
    const value = String(input);

    try {
      const url = new URL(value, TARGET_URL);

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
        scheme + "//" + location.host +
        "/__proxy_ws/" + encodeURL(url.href);

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
      console.warn("[PROXY WS ERROR]", error);
      return value;
    }
  }

  // WebSocket
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

  // Fetch
  if (NativeFetch) {
    window.fetch = function(input, init) {
      if (
        typeof input === "string" ||
        input instanceof URL
      ) {
        return NativeFetch.call(
          this,
          convertURL(input),
          init
        );
      }

      if (input instanceof Request) {
        return NativeFetch.call(
          this,
          new Request(convertURL(input.url), input),
          init
        );
      }

      return NativeFetch.call(this, input, init);
    };
  }

  // XHR
  XMLHttpRequest.prototype.open = function(
    method,
    url,
    ...rest
  ) {
    return NativeXHROpen.call(
      this,
      method,
      convertURL(url),
      ...rest
    );
  };

  console.log("[PROXY] Runtime v3.4 installed");
})();
`;

  return source.replace(
    "__TARGET_URL__",
    JSON.stringify(targetURL)
  );
}

// =====================================================
// HTML REWRITING
// =====================================================

function rewriteHTML(html, targetURL) {
  const target = new URL(targetURL);

  function convert(value) {
    const text = value.trim();

    if (
      !text ||
      text.startsWith("#") ||
      /^(data:|blob:|javascript:|mailto:|tel:)/i.test(text)
    ) {
      return value;
    }

    try {
      const url = new URL(text, target);

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        return value;
      }

      return proxyPath(url.href);

    } catch {
      return value;
    }
  }

  html = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*(?:content-security-policy|x-frame-options)[^>]*>/gi,
    ""
  );

  html = html.replace(/<base\b[^>]*>/gi, "");

  html = html.replace(
    /\b(href|src|action|poster|data-src)\s*=\s*(["'])(.*?)\2/gi,
    (match, attr, quote, value) =>
      attr + "=" + quote + convert(value) + quote
  );

  html = html.replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (match, quote, value) => {
      return "srcset=" + quote +
        value.split(",").map(item => {
          const parts = item.trim().match(/^(\S+)(\s+.*)?$/);
          if (!parts) return item;
          return convert(parts[1]) + (parts[2] || "");
        }).join(", ") +
        quote;
    }
  );

  const runtime = createRuntime(targetURL)
    .replace(/<\/script/gi, "<\\/script");

  const script = "<script>" + runtime + "</script>";

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(
      /<head\b[^>]*>/i,
      match => match + script
    );
  }

  return script + html;
}

// =====================================================
// RESPONSE HEADERS
// =====================================================

function cleanHeaders(headers) {
  const result = { ...headers };

  for (const key of [
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "strict-transport-security",
    "transfer-encoding"
  ]) {
    delete result[key];
  }

  return result;
}

// =====================================================
// NEW: HOME PAGE WITH URL INPUT
// =====================================================

const homeHTML = String.raw`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Render Base64 Proxy</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #101218;
  color: #f5f5f5;
  font-family: Arial, sans-serif;
  display: flex;
  justify-content: center;
  align-items: center;
}

.container {
  width: min(90%, 650px);
  text-align: center;
}

h1 {
  margin-bottom: 12px;
  font-size: 30px;
}

.description {
  color: #aeb5c5;
  margin-bottom: 28px;
}

.form {
  display: flex;
  gap: 10px;
}

input {
  flex: 1;
  min-width: 0;
  padding: 15px;
  background: #1c202b;
  color: white;
  border: 1px solid #343b4b;
  border-radius: 8px;
  outline: none;
  font-size: 16px;
}

input:focus {
  border-color: #5f8cff;
}

button {
  padding: 15px 25px;
  background: #426bdf;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 16px;
  font-weight: bold;
}

button:hover {
  background: #557ff3;
}

.info {
  margin-top: 24px;
  font-size: 13px;
  color: #7e879a;
}

@media (max-width: 500px) {
  .form {
    flex-direction: column;
  }
}
</style>
</head>

<body>

<div class="container">

  <h1>Render Base64 Proxy</h1>

  <p class="description">
    URLを入力するとプロキシ経由で開きます。
  </p>

  <form class="form" id="proxyForm">

    <input
      id="url"
      type="text"
      placeholder="example.com"
      autocomplete="url"
      required
    >

    <button type="submit">
      OPEN
    </button>

  </form>

  <div class="info">
    HTTP / HTTPS / WebSocket 対応
    <br>
    Base64 URL方式
  </div>

</div>

<script>
document.getElementById("proxyForm").addEventListener(
  "submit",
  function(event) {
    event.preventDefault();

    try {
      let input = document.getElementById("url").value.trim();

      if (!/^https?:\/\//i.test(input)) {
        input = "https://" + input;
      }

      const url = new URL(input);

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        throw new Error("HTTP/HTTPS以外のURLは指定できません");
      }

      const bytes = new TextEncoder().encode(url.href);

      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      const encoded = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");

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

// =====================================================
// HTTP SERVER
// =====================================================

const server = http.createServer((req, res) => {
  let requestURL;

  try {
    requestURL = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (requestURL.pathname === "/__health") {
    res.writeHead(200, {
      "content-type": "application/json"
    });

    res.end(JSON.stringify({
      version: VERSION,
      status: "ok",
      activeRequests,
      activeWebSockets
    }));

    return;
  }

  // HOME PAGE
  if (requestURL.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });

    res.end(homeHTML);
    return;
  }

  let target;

  try {
    target = getTarget(req);

    if (!target) {
      throw new Error("Target missing");
    }

    validateHostname(target.hostname);

  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8"
    });

    res.end("Invalid URL: " + error.message);
    return;
  }

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

  log("HTTP", `#${id} ${req.method} ${target.href}`);

  const client =
    target.protocol === "https:" ? https : http;

  const headers = { ...req.headers };

  for (const key of [
    "host",
    "connection",
    "proxy-connection",
    "accept-encoding",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto"
  ]) {
    delete headers[key];
  }

  headers["accept-encoding"] = "identity";

  if (headers.origin) {
    headers.origin = target.origin;
  }

  if (headers.referer) {
    headers.referer = target.href;
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
    upstreamRes => {
      const status = upstreamRes.statusCode || 200;

      const contentType =
        upstreamRes.headers["content-type"] || "";

      const isHTML =
        contentType.toLowerCase().includes("text/html");

      const responseHeaders = cleanHeaders(
        upstreamRes.headers
      );

      log(
        "RESPONSE",
        `#${id} ${status} ${contentType}`
      );

      // Redirect
      if (
        status >= 300 &&
        status < 400 &&
        upstreamRes.headers.location
      ) {
        try {
          const redirect = new URL(
            upstreamRes.headers.location,
            target
          );

          normalizeTargetURL(redirect.href);
          validateHostname(redirect.hostname);

          responseHeaders.location =
            proxyPath(redirect.href);

        } catch {
          delete responseHeaders.location;
        }
      }

      // NON-HTML
      if (!isHTML) {
        res.writeHead(status, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }

      // HTML
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];
      delete responseHeaders["etag"];

      const chunks = [];
      let size = 0;
      let exceeded = false;

      upstreamRes.on("data", chunk => {
        size += chunk.length;

        if (size > MAX_HTML) {
          exceeded = true;
          upstreamRes.destroy(
            new Error("HTML too large")
          );
          return;
        }

        chunks.push(chunk);
      });

      upstreamRes.on("end", () => {
        if (exceeded) return;

        try {
          const html = Buffer.concat(chunks).toString("utf8");
          const modified = rewriteHTML(html, target.href);

          responseHeaders["content-type"] =
            "text/html; charset=utf-8";

          res.writeHead(status, responseHeaders);
          res.end(modified);

          log(
            "HTML",
            `#${id} ${Buffer.byteLength(modified)} bytes`
          );

        } catch (error) {
          log("HTML ERROR", error.message);

          if (!res.headersSent) {
            res.writeHead(500);
          }

          res.end("HTML processing failed");
        }
      });

      upstreamRes.on("error", error => {
        log("UPSTREAM ERROR", error.message);

        if (!res.headersSent) {
          res.writeHead(502);
        }

        res.end();
      });

      upstreamRes.on("close", () => {
        if (!upstreamRes.complete && !res.writableEnded) {
          if (!res.headersSent) {
            res.writeHead(502);
          }

          res.end("Upstream interrupted");
        }
      });
    }
  );

  upstream.on("timeout", () => {
    upstream.destroy(new Error("Timeout"));
  });

  upstream.on("error", error => {
    log("HTTP ERROR", `#${id} ${error.message}`);

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

// =====================================================
// WEBSOCKET
// =====================================================

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_MESSAGE,
  perMessageDeflate: false
});

server.on("upgrade", (req, socket, head) => {
  try {
    const requestURL = new URL(req.url, "http://localhost");

    if (!requestURL.pathname.startsWith("/__proxy_ws/")) {
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
      requestURL.pathname.slice("/__proxy_ws/".length);

    const target = new URL(decodeURL(encoded));

    if (
      target.protocol !== "ws:" &&
      target.protocol !== "wss:"
    ) {
      throw new Error("Invalid WS URL");
    }

    validateHostname(target.hostname);

    wss.handleUpgrade(req, socket, head, clientWS => {
      wss.emit("connection", clientWS, req, target.href);
    });

  } catch (error) {
    log("WS ERROR", error.message);
    socket.destroy();
  }
});

wss.on("connection", (clientWS, req, targetURL) => {
  const id = ++wsCount;
  activeWebSockets++;

  log("WS OPEN", `#${id} ${targetURL}`);

  const target = new URL(targetURL);

  const origin =
    (target.protocol === "wss:" ? "https://" : "http://") +
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

  clientWS.on("message", (data, isBinary) => {
    uploaded += data.length;
    messagesUp++;

    if (upstreamWS.readyState === WebSocket.OPEN) {
      if (upstreamWS.bufferedAmount > MAX_WS_BUFFER) {
        clientWS.close(1013, "Backpressure");
        return;
      }

      upstreamWS.send(data, { binary: isBinary });
      return;
    }

    if (upstreamWS.readyState === WebSocket.CONNECTING) {
      pendingBytes += data.length;

      if (pendingBytes > MAX_WS_BUFFER) {
        clientWS.close(1013, "Buffer full");
        return;
      }

      pending.push({ data, isBinary });
    }
  });

  upstreamWS.on("open", () => {
    log("WS CONNECTED", `#${id} ${targetURL}`);

    for (const item of pending) {
      if (upstreamWS.readyState !== WebSocket.OPEN) break;

      upstreamWS.send(item.data, { binary: item.isBinary });
    }

    pending.length = 0;
    pendingBytes = 0;
  });

  upstreamWS.on("message", (data, isBinary) => {
    downloaded += data.length;
    messagesDown++;

    if (clientWS.readyState !== WebSocket.OPEN) return;

    if (clientWS.bufferedAmount > MAX_WS_BUFFER) {
      upstreamWS.close(1013, "Backpressure");
      return;
    }

    clientWS.send(data, { binary: isBinary });
  });

  upstreamWS.on("error", error => {
    log("WS ERROR", `#${id} upstream: ${error.message}`);

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.close(1011, "Upstream error");
    }
  });

  clientWS.on("error", error => {
    log("WS ERROR", `#${id} client: ${error.message}`);
  });

  const statsTimer = setInterval(() => {
    log(
      "WS STATS",
      `#${id} UP=${(uploaded / 1024).toFixed(1)}KB ` +
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

  clientWS.on("close", code => {
    cleanup();
    log("WS CLOSE", `#${id} client (${code})`);

    if (upstreamWS.readyState === WebSocket.OPEN) {
      upstreamWS.close();
    } else if (
      upstreamWS.readyState === WebSocket.CONNECTING
    ) {
      upstreamWS.terminate();
    }
  });

  upstreamWS.on("close", code => {
    log("WS CLOSE", `#${id} upstream (${code})`);

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.close();
    }
  });
});

// =====================================================
// START
// =====================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("====================================");
  console.log(" Render Base64 Proxy v3.4");
  console.log("====================================");
  console.log("");
  console.log("PORT:", PORT);
  console.log("HTTP/HTTPS: ENABLED");
  console.log("WS/WSS: ENABLED");
  console.log("WebSocket Host Fix: ENABLED");
  console.log("Legacy /Base64 URLs: ENABLED");
  console.log("Query Parameters: ENABLED");
  console.log("HTTPS Auto Prefix: ENABLED");
  console.log("URL Input Homepage: ENABLED");
  console.log("Previous-site memory: DISABLED");
  console.log("PROXY_TOKEN: NOT REQUIRED");
  console.log("");
  console.log("Server running!");
  console.log("");
});

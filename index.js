import http from "http";
import https from "https";
import { WebSocket, WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

// ==================================================
// 設定
// ==================================================

let lastBaseUrl = "";

const WS_ENDPOINT = "/__proxy_ws";

let httpCount = 0;
let wsCount = 0;

// ==================================================
// ログ
// ==================================================

function log(type, message) {
  const time = new Date().toLocaleTimeString();

  console.log(`[${time}] [${type}] ${message}`);
}

// ==================================================
// Base64デコード
// ==================================================

function decodeBase64(value) {
  let text = value;

  while (text.length % 4 !== 0) {
    text += "=";
  }

  return Buffer.from(text, "base64").toString("utf8");
}

// ==================================================
// URL取得
// ==================================================

function resolveTarget(req) {
  const urlObj = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  const pathPart = urlObj.pathname.slice(1);

  let targetUrl = "";

  if (pathPart.startsWith("aHR0c")) {
    targetUrl = decodeBase64(pathPart);

    const parsed = new URL(targetUrl);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      throw new Error("Unsupported protocol");
    }

    lastBaseUrl = parsed.origin;

    log("BASE", lastBaseUrl);
  }

  else if (lastBaseUrl) {
    targetUrl =
      lastBaseUrl +
      urlObj.pathname +
      urlObj.search;
  }

  else {
    return null;
  }

  return targetUrl;
}

// ==================================================
// WebSocket書き換え用JavaScript
// ==================================================

const websocketRuntime = `

(function() {

  if (window.__PROXY_WEBSOCKET_INSTALLED__) {
    return;
  }

  window.__PROXY_WEBSOCKET_INSTALLED__ = true;

  const NativeWebSocket = window.WebSocket;

  if (!NativeWebSocket) {
    return;
  }

  const proxyEndpoint = ${JSON.stringify(WS_ENDPOINT)};

  const targetBase = ${JSON.stringify("__TARGET_BASE__")};

  function convertWebSocketURL(input) {

    let target;

    try {

      const text = String(input);

      // 通常のWebSocket URL
      if (
        text.startsWith("ws://") ||
        text.startsWith("wss://")
      ) {
        target = new URL(text);
      }

      // HTTP URLが渡された場合
      else if (
        text.startsWith("http://") ||
        text.startsWith("https://")
      ) {
        target = new URL(text);

        target.protocol =
          target.protocol === "https:"
            ? "wss:"
            : "ws:";
      }

      // 相対URL
      else {

        const base = new URL(targetBase);

        const resolved = new URL(text, base);

        resolved.protocol =
          resolved.protocol === "https:"
            ? "wss:"
            : "ws:";

        target = resolved;
      }

      const protocol =
        location.protocol === "https:"
          ? "wss:"
          : "ws:";

      return (
        protocol +
        "//" +
        location.host +
        proxyEndpoint +
        "?url=" +
        encodeURIComponent(target.href)
      );

    } catch (error) {

      console.error(
        "[PROXY WS] URL conversion failed:",
        error
      );

      return input;
    }
  }

  class ProxyWebSocket extends NativeWebSocket {

    constructor(url, protocols) {

      const converted = convertWebSocketURL(url);

      console.log(
        "[PROXY WS]",
        String(url),
        "=>",
        converted
      );

      if (protocols === undefined) {
        super(converted);
      } else {
        super(converted, protocols);
      }

    }

  }

  Object.defineProperty(
    ProxyWebSocket,
    "CONNECTING",
    { value: 0 }
  );

  Object.defineProperty(
    ProxyWebSocket,
    "OPEN",
    { value: 1 }
  );

  Object.defineProperty(
    ProxyWebSocket,
    "CLOSING",
    { value: 2 }
  );

  Object.defineProperty(
    ProxyWebSocket,
    "CLOSED",
    { value: 3 }
  );

  window.WebSocket = ProxyWebSocket;

  console.log(
    "[PROXY] WebSocket interception enabled"
  );

})();

`;

// ==================================================
// HTML加工
// ==================================================

function modifyHTML(html, req, targetUrl) {

  // CSPのmetaタグを削除
  html = html.replace(
    /<meta\\b[^>]*http-equiv\\s*=\\s*["']?\\s*(?:content-security-policy|x-frame-options)[^>]*>/gi,
    ""
  );

  // プロキシのOrigin
  const forwardedProto =
    req.headers["x-forwarded-proto"] ||
    (req.socket.encrypted ? "https" : "http");

  const proxyOrigin =
    forwardedProto +
    "://" +
    req.headers.host +
    "/";

  // baseタグ
  const hasBaseTag = /<base\\b[^>]*>/i.test(html);

  if (!hasBaseTag) {

    const baseTag =
      `<base href="${proxyOrigin}">`;

    if (/<head\\b[^>]*>/i.test(html)) {

      html = html.replace(
        /<head\\b[^>]*>/i,
        match => match + "\\n" + baseTag
      );

    } else {

      html = baseTag + html;
    }
  }

  // WebSocket書き換えコード
  const runtime = websocketRuntime.replace(
    "__TARGET_BASE__",
    targetUrl.replace(/\\/[^/]*$/, "/")
  );

  const script =
    "<script>\\n" +
    runtime.replace(/<\\/script/gi, "<\\\\/script") +
    "\\n</script>";

  // できるだけ早く挿入
  if (/<head\\b[^>]*>/i.test(html)) {

    html = html.replace(
      /<head\\b[^>]*>/i,
      match => match + "\\n" + script
    );

  } else {

    html = script + html;
  }

  return html;
}

// ==================================================
// HTTPプロキシ
// ==================================================

const server = http.createServer((req, res) => {

  if (req.url.startsWith(WS_ENDPOINT)) {

    res.writeHead(426, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("WebSocket upgrade required");
    return;
  }

  let targetUrl;

  try {

    targetUrl = resolveTarget(req);

  } catch (error) {

    res.writeHead(400);
    res.end("Invalid target URL");
    return;
  }

  if (!targetUrl) {

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    res.end(
      "最初にURLをBase64にしてアクセスしてください。"
    );

    return;
  }

  httpCount++;

  log(
    "HTTP",
    `#${httpCount} ${req.method} ${targetUrl}`
  );

  let parsedTarget;

  try {

    parsedTarget = new URL(targetUrl);

    if (
      parsedTarget.protocol !== "http:" &&
      parsedTarget.protocol !== "https:"
    ) {
      throw new Error("Invalid protocol");
    }

  } catch {

    res.writeHead(400);
    res.end("Invalid URL");
    return;
  }

  const client =
    parsedTarget.protocol === "https:"
      ? https
      : http;

  // ==================================================
  // リクエストヘッダー
  // ==================================================

  const headers = { ...req.headers };

  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];

  headers["accept-encoding"] = "identity";

  // 対象サイトのOriginに合わせる
  if (headers.origin) {
    headers.origin = parsedTarget.origin;
  }

  if (headers.referer) {
    headers.referer = targetUrl;
  }

  // ==================================================
  // 上流HTTP通信
  // ==================================================

  const upstream = client.request(
    parsedTarget,
    {
      method: req.method,
      headers
    },
    targetRes => {

      const responseHeaders = {
        ...targetRes.headers
      };

      delete responseHeaders["x-frame-options"];
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["content-security-policy-report-only"];
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];

      const contentType =
        responseHeaders["content-type"] || "";

      // ==================================================
      // HTML以外
      // ==================================================

      if (!contentType.toLowerCase().includes("text/html")) {

        res.writeHead(
          targetRes.statusCode || 200,
          responseHeaders
        );

        targetRes.pipe(res);

        return;
      }

      // ==================================================
      // HTML
      // ==================================================

      const chunks = [];

      targetRes.on("data", chunk => {
        chunks.push(chunk);
      });

      targetRes.on("end", () => {

        try {

          let html = Buffer.concat(chunks).toString("utf8");

          html = modifyHTML(
            html,
            req,
            targetUrl
          );

          responseHeaders["content-type"] =
            "text/html; charset=utf-8";

          responseHeaders["x-frame-options"] =
            "ALLOWALL";

          responseHeaders["content-security-policy"] =
            "frame-ancestors *";

          const body = Buffer.from(
            html,
            "utf8"
          );

          res.writeHead(
            targetRes.statusCode || 200,
            responseHeaders
          );

          res.end(body);

          log(
            "HTML",
            `${body.length} bytes`
          );

        } catch (error) {

          log(
            "ERROR",
            error.message
          );

          if (!res.headersSent) {
            res.writeHead(500);
          }

          res.end("HTML processing failed");
        }
      });

    }
  );

  upstream.on("error", error => {

    log(
      "HTTP ERROR",
      error.message
    );

    if (!res.headersSent) {
      res.writeHead(502);
    }

    res.end("Upstream connection failed");
  });

  req.pipe(upstream);

});

// ==================================================
// WebSocketサーバー
// ==================================================

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false
});

// ==================================================
// WebSocket Upgrade
// ==================================================

server.on("upgrade", (req, socket, head) => {

  try {

    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    if (requestUrl.pathname !== WS_ENDPOINT) {

      socket.destroy();
      return;
    }

    const targetUrl =
      requestUrl.searchParams.get("url");

    if (!targetUrl) {

      log(
        "WS ERROR",
        "Missing target URL"
      );

      socket.destroy();
      return;
    }

    const target = new URL(targetUrl);

    if (
      target.protocol !== "ws:" &&
      target.protocol !== "wss:"
    ) {
      throw new Error(
        "Invalid WebSocket protocol"
      );
    }

    // 1人用プロキシとして、現在設定中の
    // 対象サイトと同じホストへの接続に制限する。
    if (!lastBaseUrl) {
      throw new Error("Base URL not set");
    }

    const allowed = new URL(lastBaseUrl);

    if (target.hostname !== allowed.hostname) {
      throw new Error(
        "WebSocket host is not allowed: " +
        target.hostname
      );
    }

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

// ==================================================
// WebSocket双方向転送
// ==================================================

wss.on(
  "connection",
  (clientWS, req, targetUrl) => {

    wsCount++;

    const id = wsCount;

    log(
      "WS OPEN",
      `#${id} ${targetUrl}`
    );

    // 元サイトにOriginを合わせる
    const target = new URL(targetUrl);

    const origin =
      (target.protocol === "wss:"
        ? "https://"
        : "http://") +
      target.host;

    const headers = {
      Origin: origin
    };

    // Cookieを転送
    if (req.headers.cookie) {
      headers.Cookie = req.headers.cookie;
    }

    // WebSocketサブプロトコル
    const protocolHeader =
      req.headers["sec-websocket-protocol"];

    const protocols = protocolHeader
      ? protocolHeader
          .split(",")
          .map(p => p.trim())
          .filter(Boolean)
      : [];

    const upstreamWS = new WebSocket(
      targetUrl,
      protocols,
      {
        headers,
        perMessageDeflate: false,
        handshakeTimeout: 15000
      }
    );

    let upstreamReady = false;

    let sentBytes = 0;
    let receivedBytes = 0;

    let sentMessages = 0;
    let receivedMessages = 0;

    // ==================================================
    // 接続成功
    // ==================================================

    upstreamWS.on("open", () => {

      upstreamReady = true;

      log(
        "WS CONNECTED",
        `#${id} upstream connected`
      );

    });

    // ==================================================
    // ブラウザ → 対象サイト
    // ==================================================

    clientWS.on(
      "message",
      (data, isBinary) => {

        if (
          !upstreamReady ||
          upstreamWS.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        sentMessages++;
        sentBytes += data.length;

        upstreamWS.send(
          data,
          {
            binary: isBinary
          }
        );

      }
    );

    // ==================================================
    // 対象サイト → ブラウザ
    // ==================================================

    upstreamWS.on(
      "message",
      (data, isBinary) => {

        if (
          clientWS.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        receivedMessages++;
        receivedBytes += data.length;

        clientWS.send(
          data,
          {
            binary: isBinary
          }
        );

      }
    );

    // ==================================================
    // エラー
    // ==================================================

    upstreamWS.on("error", error => {

      log(
        "WS ERROR",
        `#${id} upstream: ${error.message}`
      );

      if (
        clientWS.readyState === WebSocket.OPEN
      ) {
        clientWS.close(1011, "Upstream error");
      }

    });

    clientWS.on("error", error => {

      log(
        "WS ERROR",
        `#${id} client: ${error.message}`
      );

    });

    // ==================================================
    // 切断
    // ==================================================

    clientWS.on("close", () => {

      log(
        "WS CLOSE",
        `#${id} client disconnected`
      );

      if (
        upstreamWS.readyState === WebSocket.OPEN
      ) {
        upstreamWS.close();
      }

      else if (
        upstreamWS.readyState === WebSocket.CONNECTING
      ) {
        upstreamWS.terminate();
      }

    });

    upstreamWS.on("close", (code) => {

      log(
        "WS CLOSE",
        `#${id} upstream closed (${code})`
      );

      if (
        clientWS.readyState === WebSocket.OPEN
      ) {
        clientWS.close();
      }

    });

    // ==================================================
    // 通信量ログ
    // ==================================================

    const timer = setInterval(() => {

      if (
        clientWS.readyState === WebSocket.CLOSED &&
        upstreamWS.readyState === WebSocket.CLOSED
      ) {
        clearInterval(timer);
        return;
      }

      log(
        "WS STATS",
        `#${id} ` +
        `UP=${(sentBytes / 1024).toFixed(1)}KB ` +
        `DOWN=${(receivedBytes / 1024).toFixed(1)}KB ` +
        `MSG=${sentMessages}/${receivedMessages}`
      );

    }, 5000);

    timer.unref();

  }
);

// ==================================================
// 起動
// ==================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log("====================================");
    console.log(" HTTP + WebSocket Proxy");
    console.log("====================================");
    console.log("");

    console.log(`PORT: ${PORT}`);

    console.log("HTTP Proxy: ENABLED");
    console.log("WebSocket Proxy: ENABLED");

    console.log("Binary Messages: ENABLED");
    console.log("Text Messages: ENABLED");

    console.log("");
    console.log("Server running!");
    console.log("");

  }
);

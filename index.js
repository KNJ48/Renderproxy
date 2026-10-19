import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const MAX_HTML = 8 * 1024 * 1024;
const MAX_WS_MESSAGE = 2 * 1024 * 1024;
const MAX_WS_BUFFER = 4 * 1024 * 1024;

let httpCount = 0;
let wsCount = 0;

// ========================================
// Logging
// ========================================

function log(type, message) {
  console.log(
    `[${new Date().toISOString()}] [${type}] ${message}`
  );
}

// ========================================
// Base64
// ========================================

function encodeURL(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeURL(value) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error("Invalid Base64");
  }

  return Buffer.from(value, "base64url").toString("utf8");
}

// ========================================
// URL
// ========================================

function validateURL(value, websocket = false) {
  const url = new URL(value);

  const protocols = websocket
    ? ["ws:", "wss:"]
    : ["http:", "https:"];

  if (!protocols.includes(url.protocol)) {
    throw new Error("Unsupported protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }

  if (!url.hostname) {
    throw new Error("Invalid hostname");
  }

  return url;
}

function proxyPath(url) {
  return "/" + encodeURL(url);
}

function getTarget(req) {
  const requestURL = new URL(req.url, "http://localhost");

  const encoded = requestURL.pathname.slice(1);

  if (!encoded) {
    return null;
  }

  const target = validateURL(decodeURL(encoded));

  // プロキシURL自体のクエリは対象URLへ追加しない。
  // 対象のクエリはBase64内に含まれる。

  return target;
}

// ========================================
// SSRF protection
// ========================================

function isPublicIP(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b, c] = parts;

    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 192 && b === 0 && c === 0 ||
      a === 192 && b === 0 && c === 2 ||
      a === 198 && (b === 18 || b === 19) ||
      a === 198 && b === 51 && c === 100 ||
      a === 203 && b === 0 && c === 113
    ) {
      return false;
    }

    return true;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();

    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    ) {
      return false;
    }

    // IPv4 mapped IPv6も含め、公開用IPv6アドレスは
    // この実験版では許可しない。
    return false;
  }

  return false;
}

function validateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    !host.includes(".")
  ) {
    throw new Error("Forbidden hostname");
  }
}

function safeLookup(hostname, options, callback) {
  try {
    validateHostname(hostname);

    if (net.isIP(hostname)) {
      if (!isPublicIP(hostname)) {
        throw new Error("Private IP blocked");
      }

      if (options?.all) {
        callback(null, [{
          address: hostname,
          family: net.isIP(hostname)
        }]);
      } else {
        callback(null, hostname, net.isIP(hostname));
      }

      return;
    }

    dns.lookup(hostname, {
      all: true,
      family: 4,
      verbatim: true
    }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }

      const safe = addresses.filter(
        item => isPublicIP(item.address)
      );

      // DNS応答にプライベートIPが混ざる場合も拒否
      if (
        safe.length === 0 ||
        safe.length !== addresses.length
      ) {
        callback(new Error("Unsafe DNS result"));
        return;
      }

      if (options?.all) {
        callback(null, safe);
      } else {
        callback(null, safe[0].address, safe[0].family);
      }
    });

  } catch (error) {
    callback(error);
  }
}

const httpAgent = new http.Agent({
  keepAlive: true,
  lookup: safeLookup
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  lookup: safeLookup
});

// ========================================
// Browser Runtime
// ========================================

function createRuntime(targetURL) {
  return `
(() => {
  if (window.__B64_PROXY_RUNTIME__) return;

  window.__B64_PROXY_RUNTIME__ = true;

  const TARGET = ${JSON.stringify(targetURL)};
  const NATIVE_WS = window.WebSocket;
  const NATIVE_FETCH = window.fetch;
  const NATIVE_XHR_OPEN = XMLHttpRequest.prototype.open;

  function encode(value) {
    const bytes = new TextEncoder().encode(value);

    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary)
      .replace(/\\\\+/g, "-")
      .replace(/\\\\//g, "_")
      .replace(/=+$/g, "");
  }

  function convert(input) {
    const value = String(input);

    if (
      value.startsWith("data:") ||
      value.startsWith("blob:") ||
      value.startsWith("javascript:") ||
      value.startsWith("#")
    ) {
      return value;
    }

    try {
      const url = new URL(value, TARGET);

      if (
        url.origin === location.origin &&
        /^\\\\/[A-Za-z0-9_-]+={0,2}$/.test(url.pathname)
      ) {
        return url.href;
      }

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        return value;
      }

      return "/" + encode(url.href);

    } catch {
      return value;
    }
  }

  function convertWS(input) {
    try {
      const url = new URL(String(input), TARGET);

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
        return input;
      }

      const scheme =
        location.protocol === "https:" ? "wss:" : "ws:";

      return scheme + "//" + location.host +
        "/__proxy_ws/" + encode(url.href);

    } catch {
      return input;
    }
  }

  // =====================================
  // WebSocket
  // =====================================

  if (NATIVE_WS) {
    class ProxyWebSocket extends NATIVE_WS {
      constructor(url, protocols) {
        const converted = convertWS(url);

        console.log(
          "[PROXY WS]",
          url,
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

    window.WebSocket = ProxyWebSocket;
  }

  // =====================================
  // Fetch
  // =====================================

  window.fetch = function(input, init) {
    if (
      typeof input === "string" ||
      input instanceof URL
    ) {
      return NATIVE_FETCH.call(
        this,
        convert(input),
        init
      );
    }

    if (input instanceof Request) {
      const request = new Request(
        convert(input.url),
        input
      );

      return NATIVE_FETCH.call(this, request, init);
    }

    return NATIVE_FETCH.call(this, input, init);
  };

  // =====================================
  // XMLHttpRequest
  // =====================================

  XMLHttpRequest.prototype.open = function(
    method,
    url,
    ...rest
  ) {
    return NATIVE_XHR_OPEN.call(
      this,
      method,
      convert(url),
      ...rest
    );
  };

  console.log("[PROXY] Runtime loaded");
})();
`;
}

// ========================================
// HTML rewriting
// ========================================

function rewriteHTML(html, targetURL) {
  const target = new URL(targetURL);

  const convert = value => {
    try {
      const text = value.trim();

      if (
        !text ||
        text.startsWith("#") ||
        /^(data:|blob:|javascript:|mailto:|tel:)/i.test(text)
      ) {
        return value;
      }

      const absolute = new URL(text, target);

      if (
        absolute.protocol !== "http:" &&
        absolute.protocol !== "https:"
      ) {
        return value;
      }

      return proxyPath(absolute.href);

    } catch {
      return value;
    }
  };

  // CSP metaを削除
  html = html.replace(
    /<meta\\b[^>]*http-equiv\\s*=\\s*["']?\\s*(?:content-security-policy|x-frame-options)[^>]*>/gi,
    ""
  );

  // 元サイトのbaseを削除
  html = html.replace(/<base\\b[^>]*>/gi, "");

  // HTML属性のURLを書き換え
  html = html.replace(
    /\\b(href|src|action|poster|data-src)\\s*=\\s*(["'])(.*?)\\2/gi,
    (match, attr, quote, value) => {
      return attr + "=" + quote +
        convert(value) + quote;
    }
  );

  // srcset
  html = html.replace(
    /\\bsrcset\\s*=\\s*(["'])(.*?)\\1/gi,
    (match, quote, value) => {
      const converted = value.split(",").map(item => {
        const trimmed = item.trim();

        const parts = trimmed.match(/^(\\S+)(\\s+.*)?$/);

        if (!parts) return trimmed;

        return convert(parts[1]) + (parts[2] || "");
      }).join(", ");

      return "srcset=" + quote + converted + quote;
    }
  );

  const runtime = createRuntime(targetURL)
    .replace(/<\\/script/gi, "<\\\\/script");

  const injection =
    "<script>" + runtime + "</script>";

  if (/<head\\b[^>]*>/i.test(html)) {
    html = html.replace(
      /<head\\b[^>]*>/i,
      match => match + injection
    );
  } else {
    html = injection + html;
  }

  return html;
}

// ========================================
// HTTP headers
// ========================================

function cleanHeaders(headers) {
  const result = { ...headers };

  for (const key of [
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "strict-transport-security"
  ]) {
    delete result[key];
  }

  return result;
}

// ========================================
// HTTP Server
// ========================================

const server = http.createServer((req, res) => {
  let target;

  try {
    target = getTarget(req);

    if (target) {
      validateHostname(target.hostname);
    }

  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8"
    });

    res.end("Invalid URL: " + error.message);
    return;
  }

  if (!target) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });

    res.end(`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>Render Base64 Proxy</title>
</head>
<body>
<h2>Render Base64 Proxy</h2>
<p>URLをBase64にして、ドメインの後ろに付けてください。</p>
<p>HTTP / HTTPS / WebSocket対応</p>
</body>
</html>
    `);

    return;
  }

  httpCount++;

  const id = httpCount;

  log(
    "HTTP",
    "#" + id + " " + req.method + " " + target.href
  );

  const client =
    target.protocol === "https:" ? https : http;

  const headers = { ...req.headers };

  for (const key of [
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "proxy-connection",
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
      agent: target.protocol === "https:"
        ? httpsAgent
        : httpAgent,
      timeout: 30000
    },
    upstreamRes => {
      const status = upstreamRes.statusCode || 200;

      const type =
        upstreamRes.headers["content-type"] || "";

      const isHTML = type.toLowerCase().includes("text/html");

      const responseHeaders = cleanHeaders(
        upstreamRes.headers
      );

      // リダイレクト
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

          validateURL(redirect.href);
          validateHostname(redirect.hostname);

          responseHeaders.location = proxyPath(
            redirect.href
          );

        } catch {
          delete responseHeaders.location;
        }
      }

      // HTML以外
      if (!isHTML) {
        // バイナリやJS/CSSのContent-Lengthは
        // 元の値を維持して転送する
        if (upstreamRes.headers["content-length"]) {
          responseHeaders["content-length"] =
            upstreamRes.headers["content-length"];
        }

        if (upstreamRes.headers["content-encoding"]) {
          responseHeaders["content-encoding"] =
            upstreamRes.headers["content-encoding"];
        }

        res.writeHead(status, responseHeaders);

        upstreamRes.pipe(res);

        log(
          "HTTP RESPONSE",
          "#" + id + " " + status + " " + type
        );

        return;
      }

      // HTML加工
      const chunks = [];
      let size = 0;

      upstreamRes.on("data", chunk => {
        size += chunk.length;

        if (size > MAX_HTML) {
          upstreamRes.destroy(
            new Error("HTML too large")
          );
          return;
        }

        chunks.push(chunk);
      });

      upstreamRes.on("end", () => {
        try {
          let html = Buffer.concat(chunks)
            .toString("utf8");

          html = rewriteHTML(
            html,
            target.href
          );

          responseHeaders["content-type"] =
            "text/html; charset=utf-8";

          res.writeHead(status, responseHeaders);

          res.end(html);

          log(
            "HTML",
            "#" + id + " " + Buffer.byteLength(html) + " bytes"
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
    }
  );

  upstream.on("timeout", () => {
    upstream.destroy(new Error("Timeout"));
  });

  upstream.on("error", error => {
    log("HTTP ERROR", error.message);

    if (!res.headersSent) {
      res.writeHead(502);
    }

    res.end("Bad Gateway");
  });

  req.on("error", error => {
    upstream.destroy(error);
  });

  req.pipe(upstream);
});

// ========================================
// WebSocket
// ========================================

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_MESSAGE,
  perMessageDeflate: false
});

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

    const encoded = requestURL.pathname.slice(
      "/__proxy_ws/".length
    );

    const target = validateURL(
      decodeURL(encoded),
      true
    );

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
    log("WS ERROR", error.message);
    socket.destroy();
  }
});

wss.on("connection", (clientWS, req, targetURL) => {
  const id = ++wsCount;

  log("WS OPEN", "#" + id + " " + targetURL);

  const target = new URL(targetURL);

  const origin =
    (target.protocol === "wss:" ? "https://" : "http://") +
    target.host;

  const protocolsHeader =
    req.headers["sec-websocket-protocol"];

  const protocols = protocolsHeader
    ? protocolsHeader
        .split(",")
        .map(x => x.trim())
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

  // Browser -> Target
  clientWS.on("message", (data, isBinary) => {
    if (
      upstreamWS.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (
      upstreamWS.bufferedAmount > MAX_WS_BUFFER
    ) {
      clientWS.close(1013, "Backpressure");
      return;
    }

    uploaded += data.length;
    messagesUp++;

    upstreamWS.send(data, {
      binary: isBinary
    });
  });

  // Target -> Browser
  upstreamWS.on("message", (data, isBinary) => {
    if (
      clientWS.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (
      clientWS.bufferedAmount > MAX_WS_BUFFER
    ) {
      upstreamWS.close(1013, "Backpressure");
      return;
    }

    downloaded += data.length;
    messagesDown++;

    clientWS.send(data, {
      binary: isBinary
    });
  });

  upstreamWS.on("open", () => {
    log(
      "WS CONNECTED",
      "#" + id + " " + targetURL
    );
  });

  upstreamWS.on("error", error => {
    log(
      "WS ERROR",
      "#" + id + " " + error.message
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
      "#" + id + " client: " + error.message
    );
  });

  const timer = setInterval(() => {
    log(
      "WS STATS",
      "#" + id +
      " UP=" + (uploaded / 1024).toFixed(1) + "KB" +
      " DOWN=" + (downloaded / 1024).toFixed(1) + "KB" +
      " MSG=" + messagesUp + "/" + messagesDown
    );
  }, 5000);

  timer.unref();

  function cleanup() {
    clearInterval(timer);
  }

  clientWS.on("close", () => {
    cleanup();

    if (
      upstreamWS.readyState === WebSocket.OPEN
    ) {
      upstreamWS.close();
    } else if (
      upstreamWS.readyState === WebSocket.CONNECTING
    ) {
      upstreamWS.terminate();
    }

    log("WS CLOSE", "#" + id + " client");
  });

  upstreamWS.on("close", code => {
    cleanup();

    if (
      clientWS.readyState === WebSocket.OPEN
    ) {
      clientWS.close();
    }

    log(
      "WS CLOSE",
      "#" + id + " upstream (" + code + ")"
    );
  });
});

// ========================================
// Start
// ========================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("==================================");
  console.log(" Render Base64 Proxy v3");
  console.log("==================================");
  console.log("");
  console.log("PORT:", PORT);
  console.log("HTTP/HTTPS: ENABLED");
  console.log("WebSocket: ENABLED");
  console.log("Base64 URLs: ENABLED");
  console.log("Previous-site memory: DISABLED");
  console.log("PROXY_TOKEN: NOT REQUIRED");
  console.log("");
  console.log("Server running!");
  console.log("");
});

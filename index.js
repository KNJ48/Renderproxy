import http from "node:http";
import https from "node:https";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);

const WS_PATH = "/__proxy_ws";

// 公開時はRenderのEnvironmentにPROXY_TOKENを設定する。
// 未設定の場合は起動を拒否する。
const TOKEN = process.env.PROXY_TOKEN;

if (!TOKEN) {
  console.error("PROXY_TOKEN is required");
  process.exit(1);
}

const sessions = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false
});

function log(type, message) {
  console.log(
    `[${new Date().toISOString()}] [${type}] ${message}`
  );
}

function encodeURL(url) {
  return Buffer.from(url, "utf8").toString("base64url");
}

function decodeURL(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid Base64");
  }

  return Buffer.from(value, "base64url").toString("utf8");
}

function validateURL(value, websocket = false) {
  const url = new URL(value);

  const allowed = websocket
    ? ["ws:", "wss:"]
    : ["http:", "https:"];

  if (!allowed.includes(url.protocol)) {
    throw new Error("Unsupported protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }

  return url;
}

function authorize(req) {
  const url = new URL(req.url, "http://localhost");

  const supplied =
    url.searchParams.get("token") ||
    req.headers["x-proxy-token"];

  return supplied === TOKEN;
}

// 外部公開プロキシによる内部ネットワークへのアクセスを防ぐ。
// DNSリバインディング対策には追加のIP検証が必要。
function forbiddenHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  if (
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1"
  ) {
    return true;
  }

  return false;
}

function getTarget(req) {
  const requestURL = new URL(req.url, "http://localhost");
  const match = requestURL.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);

  if (!match) return null;

  const original = validateURL(decodeURL(match[1]));

  if (forbiddenHostname(original.hostname)) {
    throw new Error("Forbidden hostname");
  }

  const suffix = match[2];

  if (suffix) {
    return validateURL(
      new URL(suffix + requestURL.search, original.origin).href
    );
  }

  return original;
}

function runtimeScript(targetURL) {
  return `
(() => {
  const NativeWebSocket = window.WebSocket;
  const nativeFetch = window.fetch;

  const targetBase = ${JSON.stringify(targetURL.href)};
  const targetOrigin = new URL(targetBase).origin;

  const encode = text => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\\+/g, "-")
      .replace(/\\//g, "_")
      .replace(/=+$/g, "");
  };

  function proxyURL(value) {
    const url = new URL(String(value), targetBase);

    if (url.origin === location.origin &&
        url.pathname.startsWith("/p/")) {
      return url.href;
    }

    return location.origin + "/p/" + encode(url.href);
  }

  function proxyWS(value) {
    const url = new URL(String(value), targetBase);

    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";

    const protocol = location.protocol === "https:"
      ? "wss:"
      : "ws:";

    return protocol + "//" + location.host +
      "/__proxy_ws?target=" + encode(url.href) +
      "&token=" + encodeURIComponent(
        new URL(location.href).searchParams.get("token") || ""
      );
  }

  if (NativeWebSocket) {
    class ProxyWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        const converted = proxyWS(url);

        if (protocols === undefined) {
          super(converted);
        } else {
          super(converted, protocols);
        }
      }
    }

    window.WebSocket = ProxyWebSocket;
  }

  window.fetch = function(input, init) {
    if (typeof input === "string" || input instanceof URL) {
      return nativeFetch.call(this, proxyURL(input), init);
    }

    if (input instanceof Request) {
      return nativeFetch.call(
        this,
        new Request(proxyURL(input.url), input),
        init
      );
    }

    return nativeFetch.call(this, input, init);
  };

  console.log("[PROXY] Runtime installed");
})();
`;
}

function modifyHTML(html, targetURL, req) {
  const proxyBase =
    "/p/" + encodeURL(targetURL.origin) + "/";

  html = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*(content-security-policy|x-frame-options)[^>]*>/gi,
    ""
  );

  html = html.replace(/<base\b[^>]*>/gi, "");

  const base = `<base href="${proxyBase}">`;

  const script =
    `<script>${runtimeScript(targetURL).replace(/<\/script/gi, "<\\/script")}</script>`;

  const injection = base + script;

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(
      /<head\b[^>]*>/i,
      match => match + injection
    );
  }

  return injection + html;
}

function cleanResponseHeaders(headers, html = false) {
  const result = { ...headers };

  delete result["content-security-policy"];
  delete result["content-security-policy-report-only"];
  delete result["x-frame-options"];
  delete result["content-length"];
  delete result["content-encoding"];
  delete result["transfer-encoding"];

  if (html) {
    result["content-type"] = "text/html; charset=utf-8";
  }

  return result;
}

const server = http.createServer((req, res) => {
  if (!authorize(req)) {
    res.writeHead(401, {
      "content-type": "text/plain; charset=utf-8"
    });
    res.end("Unauthorized");
    return;
  }

  let target;

  try {
    target = getTarget(req);
  } catch (error) {
    res.writeHead(400);
    res.end(error.message);
    return;
  }

  if (!target) {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8"
    });

    res.end(
      "Use /p/<Base64URL of target URL>?token=<PROXY_TOKEN>"
    );
    return;
  }

  log("HTTP", `${req.method} ${target.href}`);

  const client =
    target.protocol === "https:" ? https : http;

  const headers = { ...req.headers };

  for (const name of [
    "host",
    "connection",
    "content-length",
    "x-proxy-token",
    "accept-encoding"
  ]) {
    delete headers[name];
  }

  headers["accept-encoding"] = "identity";

  if (headers.origin) {
    headers.origin = target.origin;
  }

  if (headers.referer) {
    headers.referer = target.href;
  }

  const upstream = client.request(target, {
    method: req.method,
    headers,
    timeout: 30000
  }, upstreamRes => {
    const type = upstreamRes.headers["content-type"] || "";
    const isHTML = type.toLowerCase().includes("text/html");

    const responseHeaders =
      cleanResponseHeaders(upstreamRes.headers, isHTML);

    if (!isHTML) {
      res.writeHead(
        upstreamRes.statusCode || 200,
        responseHeaders
      );

      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];

    upstreamRes.on("data", chunk => chunks.push(chunk));

    upstreamRes.on("end", () => {
      try {
        let html = Buffer.concat(chunks).toString("utf8");

        html = modifyHTML(html, target, req);

        res.writeHead(
          upstreamRes.statusCode || 200,
          responseHeaders
        );

        res.end(html);
      } catch (error) {
        log("HTML ERROR", error.message);

        if (!res.headersSent) {
          res.writeHead(500);
        }

        res.end("HTML processing failed");
      }
    });
  });

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

  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  try {
    const requestURL = new URL(req.url, "http://localhost");

    if (requestURL.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    if (!authorize(req)) {
      socket.destroy();
      return;
    }

    const encoded = requestURL.searchParams.get("target");

    if (!encoded) {
      throw new Error("Missing target");
    }

    const target = validateURL(decodeURL(encoded), true);

    if (forbiddenHostname(target.hostname)) {
      throw new Error("Forbidden hostname");
    }

    sessions.handleUpgrade(req, socket, head, ws => {
      sessions.emit("connection", ws, req, target.href);
    });
  } catch (error) {
    log("WS ERROR", error.message);
    socket.destroy();
  }
});

let websocketID = 0;

sessions.on("connection", (clientWS, req, targetURL) => {
  const id = ++websocketID;
  const target = new URL(targetURL);

  log("WS OPEN", `#${id} ${targetURL}`);

  const protocolsHeader =
    req.headers["sec-websocket-protocol"];

  const protocols = protocolsHeader
    ? protocolsHeader.split(",").map(x => x.trim()).filter(Boolean)
    : [];

  const origin =
    (target.protocol === "wss:" ? "https:" : "http:") +
    "//" + target.host;

  const upstreamWS = new WebSocket(
    targetURL,
    protocols,
    {
      headers: {
        Origin: origin,
        ...(req.headers.cookie
          ? { Cookie: req.headers.cookie }
          : {})
      },
      handshakeTimeout: 15000,
      perMessageDeflate: false
    }
  );

  const pending = [];
  let upload = 0;
  let download = 0;
  let messagesUp = 0;
  let messagesDown = 0;

  upstreamWS.on("open", () => {
    log("WS CONNECTED", `#${id}`);

    for (const item of pending) {
      if (upstreamWS.readyState === WebSocket.OPEN) {
        upstreamWS.send(item.data, {
          binary: item.isBinary
        });
      }
    }

    pending.length = 0;
  });

  clientWS.on("message", (data, isBinary) => {
    upload += data.length;
    messagesUp++;

    if (upstreamWS.readyState === WebSocket.OPEN) {
      upstreamWS.send(data, { binary: isBinary });
    } else if (upstreamWS.readyState === WebSocket.CONNECTING) {
      if (pending.length < 100) {
        pending.push({ data, isBinary });
      } else {
        clientWS.close(1013, "Buffer full");
      }
    }
  });

  upstreamWS.on("message", (data, isBinary) => {
    download += data.length;
    messagesDown++;

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.send(data, { binary: isBinary });
    }
  });

  const stats = setInterval(() => {
    log(
      "WS STATS",
      `#${id} UP=${(upload / 1024).toFixed(1)}KB ` +
      `DOWN=${(download / 1024).toFixed(1)}KB ` +
      `MSG=${messagesUp}/${messagesDown}`
    );
  }, 5000);

  stats.unref();

  function cleanup() {
    clearInterval(stats);
  }

  clientWS.on("close", () => {
    cleanup();

    if (upstreamWS.readyState === WebSocket.OPEN) {
      upstreamWS.close();
    } else if (upstreamWS.readyState === WebSocket.CONNECTING) {
      upstreamWS.terminate();
    }

    log("WS CLOSE", `#${id} client`);
  });

  upstreamWS.on("close", code => {
    cleanup();

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.close();
    }

    log("WS CLOSE", `#${id} upstream (${code})`);
  });

  upstreamWS.on("error", error => {
    log("WS ERROR", `#${id} ${error.message}`);

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.close(1011, "Upstream error");
    }
  });

  clientWS.on("error", error => {
    log("WS ERROR", `#${id} client: ${error.message}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(" Render Base64 HTTP + WS Proxy");
  console.log("==================================");
  console.log(`PORT: ${PORT}`);
  console.log("HTTP: ENABLED");
  console.log("WebSocket: ENABLED");
  console.log("Previous-site memory: DISABLED");
});

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const VERSION = "4.2.0-test";

const MAX_HTML = 8 * 1024 * 1024;
const MAX_REQUESTS = 40;
const MAX_WEBSOCKETS = 15;
const MAX_WS_MESSAGE = 2 * 1024 * 1024;
const MAX_WS_BUFFER = 4 * 1024 * 1024;

let lastBaseUrl = "";

let httpCount = 0;
let wsCount = 0;
let activeRequests = 0;
let activeWebSockets = 0;

// ==================================================
// LOG
// ==================================================

function log(type, message) {
  console.log(
    `[${new Date().toISOString()}] [${type}] ${message}`
  );
}

// ==================================================
// BASE64
// ==================================================

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

  const decoded = Buffer.from(
    normalized,
    "base64"
  ).toString("utf8");

  if (!decoded) {
    throw new Error("Empty URL");
  }

  return decoded;
}

function normalizeURL(value) {
  let text = String(value).trim();

  if (!/^https?:\/\//i.test(text)) {
    text = "https://" + text;
  }

  const url = new URL(text);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials forbidden");
  }

  return url;
}

function proxyPath(value) {
  return "/" + encodeURL(value);
}

// ==================================================
// NETWORK SAFETY
// ==================================================

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

  options ||= {};

  try {
    validateHostname(hostname);

    if (net.isIP(hostname) === 4) {
      if (options.all) {
        callback(null, [{ address: hostname, family: 4 }]);
      } else {
        callback(null, hostname, 4);
      }

      return;
    }

    dns.lookup(
      hostname,
      { all: true, family: 4 },
      (error, addresses) => {
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

        if (options.all) {
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

// ==================================================
// BROWSER RUNTIME v4.2
// ==================================================

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
  const nativeOpen = window.open;

  const nativeAnchorClick =
    HTMLAnchorElement.prototype.click;

  const nativeFormSubmit =
    HTMLFormElement.prototype.submit;

  const nativeFormRequestSubmit =
    HTMLFormElement.prototype.requestSubmit;

  // ==========================================
  // BASE64
  // ==========================================

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

  function decodeURL(value) {
    const normalized = value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    return atob(
      normalized.padEnd(
        Math.ceil(normalized.length / 4) * 4,
        "="
      )
    );
  }

  // ==========================================
  // URL DETECTION
  // ==========================================

  function isProxyPath(url) {
    if (url.origin !== PROXY_ORIGIN) {
      return false;
    }

    const match = url.pathname.match(
      /^\/([A-Za-z0-9+/_-]+={0,2})$/
    );

    if (!match) return false;

    try {
      const decoded = decodeURL(match[1]);

      return /^https?:\/\//i.test(decoded);

    } catch {
      return false;
    }
  }

  function resolveOriginal(input) {
    const value = String(input);

    const url = new URL(value, TARGET_URL);

    if (isProxyPath(url)) {
      return null;
    }

    // Renderドメインを元サイトのドメインに補正
    if (url.origin === PROXY_ORIGIN) {
      url.protocol = ORIGINAL.protocol;
      url.host = ORIGINAL.host;
    }

    return url;
  }

  // ==========================================
  // NAVIGATION CONVERSION
  // ==========================================

  function convertNavigation(input) {
    const value = String(input);

    if (
      !value ||
      value.startsWith("#") ||
      /^(javascript:|data:|blob:|mailto:|tel:|about:)/i.test(value)
    ) {
      return value;
    }

    try {
      const target = resolveOriginal(value);

      if (!target) return value;

      if (
        target.protocol !== "http:" &&
        target.protocol !== "https:"
      ) {
        return value;
      }

      const converted =
        PROXY_ORIGIN + "/" + encodeURL(target.href);

      return converted;

    } catch (error) {
      console.warn("[PROXY NAV ERROR]", error);
      return value;
    }
  }

  // ==========================================
  // NAVIGATION LOG
  // ==========================================

  function logNavigation(type, original, converted) {
    if (original === converted) return;

    console.log(
      "[PROXY NAV " + type + "]",
      original,
      "=>",
      converted
    );
  }

  // ==========================================
  // LINK FIX
  // ==========================================

  function fixLink(link) {
    if (!link) return;

    const original = link.getAttribute("href");

    if (!original) return;

    const converted = convertNavigation(original);

    if (converted === original) return;

    link.setAttribute("href", converted);

    logNavigation("LINK", original, converted);
  }

  // 通常のリンククリック
  document.addEventListener(
    "click",
    function(event) {
      const element = event.target;

      if (!(element instanceof Element)) return;

      const link = element.closest(
        "a[href], area[href]"
      );

      if (!link) return;

      fixLink(link);
    },
    true
  );

  // JavaScriptによる a.click()
  HTMLAnchorElement.prototype.click = function() {
    fixLink(this);

    return nativeAnchorClick.call(this);
  };

  // ==========================================
  // WINDOW.OPEN
  // ==========================================

  window.open = function(url, target, features) {
    if (url === undefined || url === "") {
      return nativeOpen.call(
        window,
        url,
        target,
        features
      );
    }

    const converted = convertNavigation(url);

    logNavigation("OPEN", url, converted);

    return nativeOpen.call(
      window,
      converted,
      target,
      features
    );
  };

  // ==========================================
  // FORM FIX
  // ==========================================

  function fixForm(form, submitter) {
    if (!(form instanceof HTMLFormElement)) return;

    let original =
      form.getAttribute("action") || TARGET_URL;

    // submitボタンにformactionがある場合
    if (
      submitter &&
      submitter.hasAttribute &&
      submitter.hasAttribute("formaction")
    ) {
      const submitAction =
        submitter.getAttribute("formaction");

      const convertedSubmitAction =
        convertNavigation(submitAction);

      if (convertedSubmitAction !== submitAction) {
        submitter.setAttribute(
          "formaction",
          convertedSubmitAction
        );

        logNavigation(
          "FORMACTION",
          submitAction,
          convertedSubmitAction
        );
      }
    }

    const converted = convertNavigation(original);

    if (converted === original) return;

    form.setAttribute("action", converted);

    logNavigation("FORM", original, converted);
  }

  // 通常のフォーム送信
  document.addEventListener(
    "submit",
    function(event) {
      const form = event.target;

      if (!(form instanceof HTMLFormElement)) return;

      fixForm(form, event.submitter);
    },
    true
  );

  // JavaScriptによる form.submit()
  HTMLFormElement.prototype.submit = function() {
    fixForm(this);

    return nativeFormSubmit.call(this);
  };

  // JavaScriptによる form.requestSubmit()
  if (nativeFormRequestSubmit) {
    HTMLFormElement.prototype.requestSubmit =
      function(submitter) {
        fixForm(this, submitter);

        if (submitter === undefined) {
          return nativeFormRequestSubmit.call(this);
        }

        return nativeFormRequestSubmit.call(
          this,
          submitter
        );
      };
  }

  // ==========================================
  // META REFRESH
  // ==========================================

  function fixMetaRefresh() {
    const metas = document.querySelectorAll(
      'meta[http-equiv="refresh" i]'
    );

    for (const meta of metas) {
      const content = meta.getAttribute("content");

      if (!content) continue;

      const match = content.match(
        /^(\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*)(.*)$/i
      );

      if (!match) continue;

      const original = match[2]
        .trim()
        .replace(/^["']|["']$/g, "");

      const converted = convertNavigation(original);

      if (converted === original) continue;

      meta.setAttribute(
        "content",
        match[1] + converted
      );

      logNavigation("META", original, converted);
    }
  }

  // ==========================================
  // IFRAME NAVIGATION
  // ==========================================

  function fixIframe(frame) {
    if (!(frame instanceof HTMLIFrameElement)) {
      return;
    }

    const original = frame.getAttribute("src");

    if (!original) return;

    const converted = convertNavigation(original);

    if (converted === original) return;

    frame.setAttribute("src", converted);

    logNavigation("IFRAME", original, converted);
  }

  // ==========================================
  // DYNAMIC NAVIGATION ELEMENTS
  // ==========================================

  function fixNavigationElements(root) {
    if (!root || !root.querySelectorAll) return;

    // meta refresh
    fixMetaRefresh();

    // iframeのみ先行補正
    // a[href]を一括変更するとサイトのJSに影響するため、
    // 通常リンクはクリック時に変換する。
    const frames = root.querySelectorAll("iframe[src]");

    for (const frame of frames) {
      fixIframe(frame);
    }
  }

  function initializeNavigation() {
    fixNavigationElements(document);

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const element = mutation.target;

          if (
            element instanceof HTMLIFrameElement &&
            mutation.attributeName === "src"
          ) {
            fixIframe(element);
          }

          if (
            element instanceof HTMLMetaElement &&
            (
              mutation.attributeName === "content" ||
              mutation.attributeName === "http-equiv"
            )
          ) {
            fixMetaRefresh();
          }

          continue;
        }

        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;

          if (node instanceof HTMLIFrameElement) {
            fixIframe(node);
          }

          if (node instanceof HTMLMetaElement) {
            fixMetaRefresh();
          }

          fixNavigationElements(node);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "src",
        "content",
        "http-equiv"
      ]
    });
  }

  // ==========================================
  // WEBSOCKET
  // ==========================================

  function convertWebSocketURL(input) {
    try {
      const url = new URL(String(input), TARGET_URL);

      // location.host由来の接続先を補正
      if (url.host === location.host) {
        url.host = ORIGINAL.host;
      }

      if (url.protocol === "https:") {
        url.protocol = "wss:";
      }

      if (url.protocol === "http:") {
        url.protocol = "ws:";
      }

      if (!["ws:", "wss:"].includes(url.protocol)) {
        return input;
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
        url.href,
        "=>",
        converted
      );

      return converted;

    } catch (error) {
      console.warn("[PROXY WS ERROR]", error);
      return input;
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

  // ==========================================
  // INITIALIZATION
  // ==========================================

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initializeNavigation,
      { once: true }
    );
  } else {
    initializeNavigation();
  }

  console.log(
    "[PROXY] Runtime v4.2 TEST installed"
  );

})();
`;

  return source.replace(
    "__TARGET_URL__",
    JSON.stringify(targetURL)
  );
}

// ==================================================
// MINIMAL HTML PROCESSING
// ==================================================

function modifyHTML(html, req, targetURL) {
  // CSP meta削除
  html = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*(?:content-security-policy|x-frame-options)\s*["']?[^>]*>/gi,
    ""
  );

  // 元のbaseタグ方式を維持
  const hasBaseTag = /<base\b[^>]*>/i.test(html);

  if (!hasBaseTag) {
    const protocol =
      req.headers["x-forwarded-proto"] ||
      (req.socket.encrypted ? "https" : "http");

    const proxyOrigin =
      `${protocol}://${req.headers.host}/`;

    html = html.replace(
      /<head\b[^>]*>/i,
      match =>
        match + `\n<base href="${proxyOrigin}">\n`
    );
  }

  // meta refreshをHTML段階で補正
  html = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*(["']?)refresh\1[^>]*>/gi,
    tag => {
      return tag.replace(
        /\bcontent\s*=\s*(["'])(.*?)\1/i,
        (attribute, quote, content) => {
          const match = content.match(
            /^(\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*)(.*)$/i
          );

          if (!match) return attribute;

          const destination = match[2]
            .trim()
            .replace(/^["']|["']$/g, "");

          try {
            const absolute = new URL(
              destination,
              targetURL
            );

            if (
              !["http:", "https:"].includes(
                absolute.protocol
              )
            ) {
              return attribute;
            }

            return (
              "content=" +
              quote +
              match[1] +
              proxyPath(absolute.href) +
              quote
            );

          } catch {
            return attribute;
          }
        }
      );
    }
  );

  // Runtime
  const runtime = createRuntime(targetURL)
    .replace(/<\/script/gi, "<\\/script");

  const script =
    "<script>" + runtime + "</script>";

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

// ==================================================
// HOME PAGE
// ==================================================

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
  min-height: 100vh;
  background: #101218;
  color: white;
  font-family: Arial, sans-serif;
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
  padding: 15px;
  border: 1px solid #343b4b;
  border-radius: 8px;
  font-size: 16px;
}

button {
  padding: 15px 25px;
  border: none;
  border-radius: 8px;
  background: #426bdf;
  color: white;
  font-size: 16px;
  cursor: pointer;
}

button:hover {
  background: #557ff3;
}

.info {
  margin-top: 25px;
  color: #7e879a;
  font-size: 13px;
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
Navigation Protection v4.2 TEST
</div>

</div>

<script>
document.getElementById("form").addEventListener(
  "submit",
  function(event) {
    event.preventDefault();

    try {
      let value = document.getElementById("url").value.trim();

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

// ==================================================
// HTTP SERVER
// ==================================================

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

  // Health check
  if (urlObj.pathname === "/__health") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });

    res.end(JSON.stringify({
      version: VERSION,
      status: "ok",
      activeRequests,
      activeWebSockets
    }));

    return;
  }

  const pathPart = urlObj.pathname.slice(1);

  // ================================================
  // HOME
  // ================================================

  if (!pathPart) {
    log(
      "HOME",
      `${req.method} ${req.url}`
    );

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "pragma": "no-cache",
      "expires": "0"
    });

    res.end(homeHTML);
    return;
  }

  // ================================================
  // TARGET RESOLUTION
  // ================================================

  let targetUrl = "";

  try {
    let decoded = null;

    try {
      const candidate = decodeURL(pathPart);
      const parsed = normalizeURL(candidate);

      if (parsed.hostname) {
        decoded = parsed;
      }
    } catch {
      // 通常パス
    }

    if (decoded) {
      if (urlObj.search) {
        const extra = new URLSearchParams(urlObj.search);

        for (const [key, value] of extra) {
          decoded.searchParams.append(key, value);
        }
      }

      targetUrl = decoded.href;
      lastBaseUrl = decoded.origin;

      log("BASE", lastBaseUrl);

    } else if (lastBaseUrl) {
      targetUrl =
        lastBaseUrl +
        urlObj.pathname +
        urlObj.search;

      log("PATH", targetUrl);

    } else {
      res.writeHead(400);
      res.end("Target not configured");
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

  // ================================================
  // REQUEST LIMIT
  // ================================================

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
  const target = new URL(targetUrl);

  log(
    "HTTP",
    `#${id} ${req.method} ${targetUrl}`
  );

  const client =
    target.protocol === "https:" ? https : http;

  const headers = { ...req.headers };

  delete headers.host;
  delete headers.referer;
  delete headers.connection;
  delete headers["proxy-connection"];

  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];

  headers["accept-encoding"] = "identity";

  if (headers.origin) {
    headers.origin = target.origin;
  }

  // ================================================
  // UPSTREAM REQUEST
  // ================================================

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
      const status = targetRes.statusCode || 200;

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

      log(
        "RESPONSE",
        `#${id} ${status} ${contentType}`
      );

      // ==========================================
      // HTTP REDIRECT
      // ==========================================

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

          if (
            !["http:", "https:"].includes(
              redirect.protocol
            )
          ) {
            throw new Error("Unsupported redirect");
          }

          validateHostname(redirect.hostname);

          responseHeaders.location =
            proxyPath(redirect.href);

          log(
            "REDIRECT",
            `#${id} ${target.href} => ${redirect.href}`
          );

        } catch (error) {
          delete responseHeaders.location;

          log(
            "REDIRECT ERROR",
            error.message
          );
        }
      }

      // ==========================================
      // NON-HTML
      // ==========================================

      if (
        !contentType.toLowerCase().includes("text/html")
      ) {
        res.writeHead(status, responseHeaders);
        targetRes.pipe(res);
        return;
      }

      // ==========================================
      // HTML
      // ==========================================

      delete responseHeaders["etag"];
      delete responseHeaders["content-md5"];

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
          const originalHTML =
            Buffer.concat(chunks).toString("utf8");

          const modifiedHTML = modifyHTML(
            originalHTML,
            req,
            target.href
          );

          responseHeaders["x-frame-options"] =
            "ALLOWALL";

          responseHeaders["content-security-policy"] =
            "frame-ancestors *";

          responseHeaders["content-type"] =
            "text/html; charset=utf-8";

          res.writeHead(status, responseHeaders);

          res.end(modifiedHTML);

          log(
            "HTML",
            `#${id} ${Buffer.byteLength(modifiedHTML)} bytes`
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
    upstream.destroy(new Error("Timeout"));
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

// ==================================================
// WEBSOCKET SERVER
// ==================================================

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
      !requestURL.pathname.startsWith("/__proxy_ws/")
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

    const target = new URL(decodeURL(encoded));

    if (
      target.protocol !== "ws:" &&
      target.protocol !== "wss:"
    ) {
      throw new Error("Invalid WS URL");
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
    log("WS ERROR", error.message);
    socket.destroy();
  }
});

// ==================================================
// WEBSOCKET RELAY
// ==================================================

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

  // ==========================================
  // BROWSER -> UPSTREAM
  // ==========================================

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

  // ==========================================
  // UPSTREAM CONNECTED
  // ==========================================

  upstreamWS.on("open", () => {
    log(
      "WS CONNECTED",
      `#${id} ${targetURL}`
    );

    for (const item of pending) {
      if (upstreamWS.readyState !== WebSocket.OPEN) break;

      upstreamWS.send(
        item.data,
        { binary: item.isBinary }
      );
    }

    pending.length = 0;
    pendingBytes = 0;
  });

  // ==========================================
  // UPSTREAM -> BROWSER
  // ==========================================

  upstreamWS.on("message", (data, isBinary) => {
    downloaded += data.length;
    messagesDown++;

    if (clientWS.readyState !== WebSocket.OPEN) return;

    if (clientWS.bufferedAmount > MAX_WS_BUFFER) {
      upstreamWS.close(1013, "Backpressure");
      return;
    }

    clientWS.send(
      data,
      { binary: isBinary }
    );
  });

  // ==========================================
  // ERRORS
  // ==========================================

  upstreamWS.on("error", error => {
    log(
      "WS ERROR",
      `#${id} upstream: ${error.message}`
    );

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.close(1011, "Upstream error");
    }
  });

  clientWS.on("error", error => {
    log(
      "WS ERROR",
      `#${id} client: ${error.message}`
    );
  });

  // ==========================================
  // STATS
  // ==========================================

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

  clientWS.on("close", code => {
    cleanup();

    log(
      "WS CLOSE",
      `#${id} client (${code})`
    );

    if (upstreamWS.readyState === WebSocket.OPEN) {
      upstreamWS.close();
    } else if (
      upstreamWS.readyState === WebSocket.CONNECTING
    ) {
      upstreamWS.terminate();
    }
  });

  upstreamWS.on("close", code => {
    log(
      "WS CLOSE",
      `#${id} upstream (${code})`
    );

    if (clientWS.readyState === WebSocket.OPEN) {
      clientWS.close();
    }
  });
});

// ==================================================
// START
// ==================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("====================================");
  console.log(" Render Base64 Proxy v4.2 TEST");
  console.log("====================================");
  console.log("");
  console.log("PORT:", PORT);
  console.log("HTTP/HTTPS: ENABLED");
  console.log("WS/WSS: ENABLED");
  console.log("Legacy Base64 URLs: ENABLED");
  console.log("Query Parameters: ENABLED");
  console.log("HTTPS Auto Prefix: ENABLED");
  console.log("URL Input Homepage: ENABLED");
  console.log("");
  console.log("Navigation Protection:");
  console.log("  HTTP Redirect: ENABLED");
  console.log("  Link Click: ENABLED");
  console.log("  Programmatic Link Click: ENABLED");
  console.log("  Form Submit: ENABLED");
  console.log("  Programmatic Form Submit: ENABLED");
  console.log("  Window Open: ENABLED");
  console.log("  Meta Refresh: ENABLED");
  console.log("  Iframe Navigation: PARTIAL");
  console.log("  Direct JS Location Redirect: NOT SUPPORTED");
  console.log("");
  console.log("HTML Bulk Rewriting: DISABLED");
  console.log("WebSocket Host Fix: ENABLED");
  console.log("Homepage Cache Control: ENABLED");
  console.log("");
  console.log("Server running!");
  console.log("");
});

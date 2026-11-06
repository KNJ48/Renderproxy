import http from "node:http";
import https from "node:https";
import { load } from "cheerio";
import archiver from "archiver";

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS = 30;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;

function log(type, message) {
  console.log(
    `[${new Date().toISOString()}] [CODE ${type}] ${message}`
  );
}

function safeFilename(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "file";
}

function filenameFor(urlText, index, type) {
  const url = new URL(urlText);

  let name = url.pathname
    .split("/")
    .filter(Boolean)
    .pop() || type;

  try {
    name = decodeURIComponent(name);
  } catch {
    // 不正なエンコードなら元の名前を使用
  }

  name = safeFilename(name);

  const extension = type === "css" ? ".css" : ".js";

  if (!name.toLowerCase().endsWith(extension)) {
    name += extension;
  }

  return (
    (type === "css" ? "css/" : "js/") +
    String(index).padStart(3, "0") +
    "_" +
    name
  );
}

function validateTarget(url, validateHostname) {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("HTTP/HTTPS以外には対応していません");
  }

  if (url.username || url.password) {
    throw new Error("URL内の認証情報は使用できません");
  }

  validateHostname(url.hostname);
}

function fetchOnce(url, options) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;

    const request = client.request(
      url,
      {
        method: "GET",
        agent:
          url.protocol === "https:"
            ? options.httpsAgent
            : options.httpAgent,
        headers: {
          "user-agent": options.userAgent,
          "accept": options.accept,
          "accept-encoding": "identity"
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      response => {
        resolve({ request, response });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("取得タイムアウト"));
    });

    request.on("error", reject);
    request.end();
  });
}

async function fetchBuffer(startURL, options) {
  let current = new URL(startURL);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    validateTarget(current, options.validateHostname);

    const { request, response } = await fetchOnce(
      current,
      options
    );

    const status = response.statusCode || 0;

    if (
      [301, 302, 303, 307, 308].includes(status) &&
      response.headers.location
    ) {
      response.resume();

      if (redirects === MAX_REDIRECTS) {
        throw new Error("リダイレクト回数が上限を超えました");
      }

      current = new URL(response.headers.location, current);
      continue;
    }

    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`HTTP ${status}`);
    }

    const encoding = String(
      response.headers["content-encoding"] || "identity"
    ).toLowerCase();

    if (encoding !== "identity") {
      response.resume();
      throw new Error(
        `未対応のContent-Encoding: ${encoding}`
      );
    }

    const chunks = [];
    let size = 0;

    const buffer = await new Promise((resolve, reject) => {
      let settled = false;

      function fail(error) {
        if (settled) return;

        settled = true;
        response.destroy();
        request.destroy();
        reject(error);
      }

      response.on("data", chunk => {
        size += chunk.length;

        if (size > options.maxBytes) {
          fail(new Error("ファイルサイズが上限を超えました"));
          return;
        }

        chunks.push(chunk);
      });

      response.on("end", () => {
        if (settled) return;

        settled = true;
        resolve(Buffer.concat(chunks));
      });

      response.on("aborted", () => {
        fail(new Error("取得が途中で中断されました"));
      });

      response.on("error", fail);
      request.on("error", fail);
    });

    return {
      url: current.href,
      status,
      contentType: response.headers["content-type"] || "",
      buffer
    };
  }

  throw new Error("取得できませんでした");
}

function collectAssets(html, documentURL) {
  const $ = load(html);
  const found = [];
  const seen = new Set();

  // HTML内のbase hrefがある場合は、そこを基準に相対URLを解決
  let baseURL = documentURL;

  const baseHref = $("base[href]").first().attr("href");

  if (baseHref) {
    try {
      const base = new URL(baseHref, documentURL);

      if (["http:", "https:"].includes(base.protocol)) {
        baseURL = base.href;
      }
    } catch {
      // 不正なbaseは無視
    }
  }

  function add(rawURL, type) {
    if (!rawURL) return;

    try {
      const url = new URL(rawURL, baseURL);

      if (!["http:", "https:"].includes(url.protocol)) {
        return;
      }

      // フラグメントはHTTPリクエストには送られない
      url.hash = "";

      const key = `${type}:${url.href}`;

      if (seen.has(key)) return;

      seen.add(key);

      found.push({
        url: url.href,
        type
      });

    } catch {
      // 不正なURLは無視
    }
  }

  $("script[src]").each((_, element) => {
    add($(element).attr("src"), "js");
  });

  $("link[href]").each((_, element) => {
    const rel = String($(element).attr("rel") || "")
      .toLowerCase()
      .split(/\s+/);

    if (rel.includes("stylesheet")) {
      add($(element).attr("href"), "css");
    }
  });

  return found;
}

/**
 * /<Base64>/code の処理。
 *
 * 既存サーバーのURLデコード、ホスト検証、安全なAgentを
 * 引数として受け取る。
 */
export async function handleCodeDownload(
  req,
  res,
  urlObj,
  dependencies
) {
  const {
    decodeURL,
    validateHostname,
    httpAgent,
    httpsAgent
  } = dependencies;

  if (req.method !== "GET") {
    res.writeHead(405, {
      "content-type": "text/plain; charset=utf-8",
      "allow": "GET",
      "cache-control": "no-store"
    });

    res.end("GETのみ対応しています");
    return;
  }

  let target;

  try {
    const suffix = "/code";

    const encoded = urlObj.pathname
      .slice(1, -suffix.length);

    if (!encoded) {
      throw new Error("Base64 URLがありません");
    }

    const decoded = decodeURL(encoded);

    // 通常のページ表示と混同しないよう、
    // ダウンロード用URLは明示的なHTTP/HTTPSを要求
    if (!/^https?:\/\//i.test(decoded)) {
      throw new Error("Base64内にHTTP/HTTPS URLが必要です");
    }

    target = new URL(decoded);
    validateTarget(target, validateHostname);

    // 通常のBase64ルートと同じように追加クエリを渡す
    for (const [key, value] of urlObj.searchParams) {
      target.searchParams.append(key, value);
    }

  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });

    res.end("URLエラー: " + error.message);
    return;
  }

  const userAgent = String(
    req.headers["user-agent"] ||
    "Render-Base64-Proxy-Code-Downloader/1.0"
  );

  const commonOptions = {
    validateHostname,
    httpAgent,
    httpsAgent,
    userAgent
  };

  let page;

  try {
    log("START", target.href);

    page = await fetchBuffer(target.href, {
      ...commonOptions,
      accept: "text/html,*/*;q=0.8",
      maxBytes: MAX_HTML_BYTES
    });

    if (
      page.contentType &&
      !page.contentType.toLowerCase().includes("text/html")
    ) {
      throw new Error(
        "取得先がHTMLではありません: " + page.contentType
      );
    }

  } catch (error) {
    log("ERROR", error.message);

    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });

      res.end("HTMLの取得に失敗: " + error.message);
    }

    return;
  }

  if (res.destroyed) return;

  const htmlText = page.buffer.toString("utf8");
  const allAssets = collectAssets(htmlText, page.url);
  const assets = allAssets.slice(0, MAX_ASSETS);

  const manifest = {
    requestedURL: target.href,
    finalURL: page.url,
    downloadedAt: new Date().toISOString(),
    html: {
      file: "index.html",
      bytes: page.buffer.length,
      contentType: page.contentType
    },
    limits: {
      maxAssets: MAX_ASSETS,
      maxAssetBytes: MAX_ASSET_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES
    },
    totalAssetsFound: allAssets.length,
    omittedByCountLimit: Math.max(
      0,
      allAssets.length - assets.length
    ),
    assets: []
  };

  const files = [
    {
      name: "index.html",
      buffer: page.buffer
    }
  ];

  let totalBytes = page.buffer.length;

  for (let i = 0; i < assets.length; i++) {
    if (res.destroyed) {
      log("CANCEL", target.href);
      return;
    }

    const asset = assets[i];
    const filename = filenameFor(
      asset.url,
      i + 1,
      asset.type
    );

    if (totalBytes >= MAX_TOTAL_BYTES) {
      manifest.assets.push({
        url: asset.url,
        type: asset.type,
        status: "skipped",
        error: "合計サイズの上限に到達"
      });

      continue;
    }

    try {
      const remaining = MAX_TOTAL_BYTES - totalBytes;

      const result = await fetchBuffer(asset.url, {
        ...commonOptions,
        accept: "*/*",
        maxBytes: Math.min(
          MAX_ASSET_BYTES,
          remaining
        )
      });

      totalBytes += result.buffer.length;

      files.push({
        name: filename,
        buffer: result.buffer
      });

      manifest.assets.push({
        url: asset.url,
        finalURL: result.url,
        type: asset.type,
        file: filename,
        status: "ok",
        bytes: result.buffer.length,
        contentType: result.contentType
      });

      log("FILE", `${filename} ${result.buffer.length} bytes`);

    } catch (error) {
      manifest.assets.push({
        url: asset.url,
        type: asset.type,
        status: "failed",
        error: error.message
      });

      log("FILE ERROR", `${asset.url}: ${error.message}`);
    }
  }

  if (res.destroyed) return;

  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition":
      'attachment; filename="site-code.zip"',
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });

  const archive = archiver("zip", {
    zlib: { level: 6 }
  });

  archive.on("warning", error => {
    log("ZIP WARNING", error.message);
  });

  archive.on("error", error => {
    log("ZIP ERROR", error.message);
    res.destroy(error);
  });

  res.on("close", () => {
    if (!res.writableFinished) {
      archive.abort();
    }
  });

  archive.pipe(res);

  for (const file of files) {
    archive.append(file.buffer, {
      name: file.name
    });
  }

  archive.append(
    JSON.stringify(manifest, null, 2),
    { name: "manifest.json" }
  );

  archive.append(
    [
      "Render Base64 Proxy - Code Download",
      "",
      "index.html: 元サイトから取得したHTML",
      "js/: HTMLから参照された外部JavaScript",
      "css/: HTMLから参照された外部CSS",
      "manifest.json: 取得結果と失敗したURL",
      "",
      "HTML内の参照先は書き換えていません。",
      "JavaScript実行後に動的取得されるファイルは対象外です。",
      "取得にCookieや認証が必要なファイルは失敗する場合があります。",
      ""
    ].join("\n"),
    { name: "README.txt" }
  );

  await archive.finalize();

  log(
    "DONE",
    `${target.href} files=${files.length} bytes=${totalBytes}`
  );
}

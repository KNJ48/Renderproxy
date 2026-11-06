import fs from "node:fs";

const indexPath = "index.js";
const backupPath = "index.js.before-code";

if (!fs.existsSync(indexPath)) {
  console.error("index.js が見つかりません。");
  process.exit(1);
}

if (!fs.existsSync("code-download.mjs")) {
  console.error("code-download.mjs が見つかりません。");
  process.exit(1);
}

let source = fs.readFileSync(indexPath, "utf8");

const marker = "// CODE DOWNLOAD ROUTE";

if (source.includes(marker)) {
  console.log("ダウンロード機能は既に追加済みです。");
  process.exit(0);
}

const importAnchor =
  'import { WebSocket, WebSocketServer } from "ws";';

const routeAnchor = "  // Health check";

if (!source.includes(importAnchor)) {
  console.error(
    "想定したimport行が見つかりません。index.jsは変更していません。"
  );
  process.exit(1);
}

if (!source.includes(routeAnchor)) {
  console.error(
    "想定したHealth checkの位置が見つかりません。index.jsは変更していません。"
  );
  process.exit(1);
}

if (fs.existsSync(backupPath)) {
  console.error(
    `${backupPath} が既にあります。上書きを避けるため停止しました。`
  );
  console.error(
    "必要ならバックアップを別名にしてから再実行してください。"
  );
  process.exit(1);
}

const newImport =
  importAnchor +
  '\nimport { handleCodeDownload } from "./code-download.mjs";';

const route = `  ${marker}
  if (
    urlObj.pathname.length > "/code".length + 1 &&
    urlObj.pathname.endsWith("/code")
  ) {
    handleCodeDownload(req, res, urlObj, {
      decodeURL,
      validateHostname,
      httpAgent,
      httpsAgent
    }).catch(error => {
      log("CODE ERROR", error.stack || error.message);

      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });

        res.end("ZIP作成エラー: " + error.message);
      } else if (!res.destroyed) {
        res.destroy(error);
      }
    });

    return;
  }

`;

const updated = source
  .replace(importAnchor, newImport)
  .replace(routeAnchor, route + routeAnchor);

fs.writeFileSync(backupPath, source, {
  flag: "wx"
});

fs.writeFileSync(indexPath, updated, "utf8");

console.log("ダウンロード機能を追加しました。");
console.log("バックアップ:", backupPath);
console.log("次に npm run check を実行してください。");

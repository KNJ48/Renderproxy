import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

// ステートレス：ユーザーごとのURLをサーバー側に記憶しない。
// URL情報は /p/<Base64URL>/... の中に含める。

function decodeBase64Url(encoded) {
  let value = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  while (value.length % 4 !== 0) {
    value += '=';
  }

  return Buffer.from(value, 'base64').toString('utf8');
}

function encodeBase64Url(text) {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function viewerHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy Viewer</title>

<style>
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

#bar {
  height: 44px;
  display: flex;
  gap: 8px;
  padding: 6px;
  background: #222;
}

#url {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #555;
  border-radius: 4px;
}

button {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

#open {
  background: #4caf50;
  color: white;
}

#reload {
  background: #666;
  color: white;
}

#frame {
  width: 100%;
  height: calc(100% - 44px);
  border: 0;
}
</style>
</head>

<body>

<div id="bar">
  <input
    id="url"
    placeholder="https://example.com"
  >

  <button id="open">
    開く
  </button>

  <button id="reload">
    再読み込み
  </button>
</div>

<iframe
  id="frame"
  title="Proxy Viewer"
>
</iframe>

<script>
const input = document.getElementById('url');
const frame = document.getElementById('frame');

function encodeBase64Url(text) {
  const bytes = new TextEncoder().encode(text);

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\\\\+/g, '-')
    .replace(/\\\\//g, '_')
    .replace(/=+$/, '');
}

function openUrl() {
  let value = input.value.trim();

  if (!value) {
    return;
  }

  if (!/^https?:\\\\/\\\\//i.test(value)) {
    value = 'https://' + value;
    input.value = value;
  }

  try {
    const url = new URL(value);

    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) {
      alert(
        'http:// または https:// のURLを指定してください。'
      );
      return;
    }

    frame.src =
      '/p/' +
      encodeBase64Url(url.href);

  } catch {
    alert('URLが正しくありません。');
  }
}

document
  .getElementById('open')
  .addEventListener('click', openUrl);

document
  .getElementById('reload')
  .addEventListener('click', () => {
    if (frame.src) {
      frame.src = frame.src;
    }
  });

input.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    openUrl();
  }
});
</script>

</body>
</html>`;
}

http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  const pathname = requestUrl.pathname;

  // トップページ
  if (pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8'
    });

    res.end(viewerHtml());
    return;
  }

  // /p/ 以外は404
  if (!pathname.startsWith('/p/')) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // /p/<Base64URL>/path
  const parts = pathname
    .slice(3)
    .split('/');

  const encodedTarget = parts.shift();

  if (!encodedTarget) {
    res.writeHead(400);
    res.end('Target URL is missing.');
    return;
  }

  // Base64URL → 元URL
  let baseUrl;

  try {
    baseUrl = decodeBase64Url(encodedTarget);
  } catch {
    res.writeHead(400);
    res.end('Base64のデコードに失敗しました。');
    return;
  }

  // URLとして解釈
  let parsedBase;

  try {
    parsedBase = new URL(baseUrl);
  } catch {
    res.writeHead(400);
    res.end('Target URL is invalid.');
    return;
  }

  // http / https のみ許可
  if (
    parsedBase.protocol !== 'http:' &&
    parsedBase.protocol !== 'https:'
  ) {
    res.writeHead(400);
    res.end(
      'http:// または https:// のURLのみ利用できます。'
    );
    return;
  }

  // ターゲットURLを作成
  let targetUrl;

  try {
    targetUrl = new URL(
      '/' + parts.join('/') + requestUrl.search,
      parsedBase.origin
    );
  } catch {
    res.writeHead(400);
    res.end('Target path is invalid.');
    return;
  }

  try {
    const client =
      targetUrl.protocol === 'https:'
        ? https
        : http;

    // リクエストヘッダーをコピー
    const headers = {
      ...req.headers
    };

    // プロキシ側では不要
    delete headers.host;
    delete headers.referer;

    client
      .get(
        targetUrl.href,
        { headers },
        targetRes => {

          const responseHeaders = {
            ...targetRes.headers
          };

          // iframeを拒否するヘッダーを削除
          delete responseHeaders['x-frame-options'];

          // CSPの frame-ancestors を削除
          if (
            responseHeaders['content-security-policy']
          ) {
            responseHeaders['content-security-policy'] =
              responseHeaders['content-security-policy']
                .split(';')
                .filter(
                  rule =>
                    !rule
                      .trim()
                      .toLowerCase()
                      .startsWith('frame-ancestors')
                )
                .join(';');
          }

          // リダイレクト先もプロキシURLへ変換
          if (responseHeaders.location) {
            try {
              const redirected = new URL(
                responseHeaders.location,
                targetUrl.href
              );

              responseHeaders.location =
                '/p/' +
                encodeBase64Url(redirected.origin) +
                redirected.pathname +
                redirected.search;

            } catch {
              // URLとして解釈できない場合はそのまま
            }
          }

          res.writeHead(
            targetRes.statusCode || 200,
            responseHeaders
          );

          targetRes.pipe(res);
        }
      )
      .on('error', error => {
        console.error(
          'Target request error:',
          error
        );

        if (!res.headersSent) {
          res.writeHead(502);
          res.end(
            'ターゲットサイトとの通信に失敗しました。'
          );
        }
      });

  } catch (error) {
    console.error(
      'Proxy error:',
      error
    );

    if (!res.headersSent) {
      res.writeHead(500);
      res.end(
        'プロキシでエラーが発生しました。'
      );
    }
  }

}).listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
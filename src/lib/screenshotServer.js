const fs = require('fs');
const http = require('http');
const path = require('path');

function isInside(parent, child) {
  const normalizedParent = path.resolve(parent).toLowerCase();
  const normalizedChild = path.resolve(child).toLowerCase();
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function serveScreenshot(root, req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const file = url.searchParams.get('file');
  if (!file) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('file is required');
    return;
  }

  const resolved = path.resolve(file);
  const screenshotRoot = path.resolve(root, 'data', 'screenshots');
  if (!isInside(screenshotRoot, resolved) || !fs.existsSync(resolved)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  res.writeHead(200, { 'content-type': 'image/png' });
  fs.createReadStream(resolved).pipe(res);
}

function startScreenshotServer(root, options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || 18789);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === 'GET' && url.pathname === '/api/screenshot') {
      serveScreenshot(root, req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        server,
        baseUrl: `http://${host}:${server.address().port}`
      });
    });
  });
}

module.exports = { serveScreenshot, startScreenshotServer };

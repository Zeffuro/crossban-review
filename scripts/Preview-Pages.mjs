import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('dist/pages');
const base = '/crossban-review';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === base) { res.writeHead(302, { Location: `${base}/` }); res.end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(base.length)).replace(/^\//, '');
    const file = resolve(root, relative + (url.pathname.endsWith('/') ? 'index.html' : ''));
    if (!url.pathname.startsWith(`${base}/`) || !file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
    try { res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end('Not found'); }
}).listen(4392, '127.0.0.1', () => console.log(`Pages preview: http://localhost:4392${base}/`));

import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist/pages');
await mkdir(resolve(output, 'app'), { recursive: true });
await build({ entryPoints: [resolve(root, 'src/browser-runtime.ts')], outfile: resolve(output, 'app/runtime.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, legalComments: 'none' });
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: https://static-cdn.jtvnw.net; connect-src 'self' https://id.twitch.tv https://api.twitch.tv https://cdn.discordapp.com https://media.discordapp.net; object-src 'none'; base-uri 'none'; form-action 'none'";
const html = (await readFile(resolve(root, 'public/index.html'), 'utf8'))
    .replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${csp}">\n    <title>`)
    .replace('<script src="./i18n.js"', '<script src="./runtime.js" defer></script>\n    <script src="./i18n.js"');
await writeFile(resolve(output, 'app/index.html'), html);
for (const name of ['app.js', 'i18n.js', 'device-login.js', 'browser-ui.js', 'styles.css']) await copyFile(resolve(root, 'public', name), resolve(output, 'app', name));
for (const name of ['index.html', 'landing.css', 'landing.js']) await copyFile(resolve(root, 'site', name), resolve(output, name));
await copyFile(resolve(root, 'public/i18n.js'), resolve(output, 'i18n.js'));
await writeFile(resolve(output, '.nojekyll'), '');
console.log('Pages build: dist/pages');

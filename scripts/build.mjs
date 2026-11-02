import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
async function walk(folder) {
  const paths = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths.sort();
}
const sources = new Map();
for (const directory of ['public', 'src']) {
  for (const path of await walk(resolve(root, directory))) sources.set(relative(resolve(root, directory), path), await readFile(path));
}
sources.set('LICENSE.txt', await readFile(resolve(root, 'LICENSE')));
for (const required of ['index.html', 'app.js', 'styles.css', 'forecast.js', 'ranking.js', 'pwa.js']) {
  if (!sources.has(required)) throw new Error(`Missing required file: ${required}`);
}
const workerTemplate = await readFile(resolve(root, 'scripts/sw-template.js'), 'utf8');
const hash = createHash('sha256').update(workerTemplate);
for (const [name, content] of [...sources].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(content);
const release = hash.digest('hex').slice(0, 12);
const names = new Map([...sources.keys()].map(name => [name, /\.(?:js|css)$/.test(name) ? name.replace(/(\.[^.]+)$/, `.${release}$1`) : name]));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const [name, buffer] of sources) {
  let content = buffer;
  if (['.html', '.js', '.css', '.webmanifest'].includes(extname(name))) {
    content = buffer.toString('utf8').replaceAll('__APP_VERSION__', release);
    for (const [source, target] of names) {
      if (source !== target) content = content.replaceAll(`./${source}`, `./${target}`);
    }
  }
  const target = resolve(dist, names.get(name));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
const precache = [...names.values()].filter(name => name !== 'update.html').sort();
await writeFile(resolve(dist, 'sw.js'), workerTemplate.replace('__RELEASE__', release).replace('__PRECACHE__', JSON.stringify(precache)));
await writeFile(resolve(dist, 'release.json'), JSON.stringify({ version: release }) + '\n');
console.log(`Built Walk Window ${release} in dist/`);

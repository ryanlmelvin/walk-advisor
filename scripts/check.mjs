import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const folder of ['src', 'public', 'scripts', 'tests']) {
  for (const name of await readdir(folder)) {
    if (!/\.(?:js|mjs)$/.test(name) || name === 'sw-template.js') continue;
    const result = spawnSync(process.execPath, ['--check', `${folder}/${name}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
console.log('JavaScript syntax checks passed.');

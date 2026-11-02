import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, cp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const template = await readFile(new URL('../scripts/sw-template.js', import.meta.url), 'utf8');
const controllerSource = await readFile(new URL('../public/pwa.js', import.meta.url), 'utf8');
const recoverySource = (await readFile(new URL('../public/update.html', import.meta.url), 'utf8')).match(/<script>([\s\S]+)<\/script>/)[1];

function recovery(serviceWorker) {
  let click;
  const timers = [];
  const navigations = [];
  const status = { textContent: '' };
  const button = { disabled: false, addEventListener(name, callback) { if (name === 'click') click = callback; } };
  vm.runInNewContext(recoverySource, {
    AbortController,
    navigator: { serviceWorker },
    window: { isSecureContext: true },
    document: { querySelector: selector => selector === '#update' ? button : status },
    location: { replace: path => navigations.push(path) },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => {}
  });
  return { click: () => click(), timers, navigations, status, button };
}

test('recovery applies an already downloaded update without needing the network', async () => {
  const listeners = new Set();
  const worker = {
    state: 'installed',
    addEventListener: (name, callback) => listeners.add(callback),
    removeEventListener: (name, callback) => listeners.delete(callback),
    postMessage() { this.state = 'activated'; for (const listener of listeners) listener(); }
  };
  const app = recovery({
    getRegistration: async () => ({ waiting: worker }),
    register: async () => { throw new Error('Network should not be needed'); }
  });
  await app.click();
  assert.deepEqual(app.navigations, ['./']);
  assert.equal(listeners.size, 0);
});

test('a timed-out recovery attempt cannot navigate later when a request finally completes', async () => {
  let complete;
  const app = recovery({ getRegistration: () => new Promise(resolve => { complete = resolve; }) });
  const attempt = app.click();
  app.timers[0]();
  await attempt;
  assert.equal(app.button.disabled, false);
  assert.match(app.status.textContent, /timed out/);
  complete({ waiting: { postMessage() { throw new Error('Should never activate'); } } });
  await Promise.resolve();
  assert.deepEqual(app.navigations, []);
});

function controller({ waiting = true, controlled = true, beforeUpdate } = {}) {
  const events = new Map();
  const timers = [];
  const updates = [];
  const messages = [];
  let reloads = 0;
  let activated = 0;
  const register = {
    waiting: waiting ? { postMessage() { activated += 1; } } : null,
    active: {},
    update: async () => {},
    addEventListener: (name, callback) => events.set(`registration:${name}`, callback)
  };
  const container = {
    controller: controlled ? {} : null,
    register: async () => register,
    addEventListener: (name, callback) => events.set(`sw:${name}`, callback)
  };
  const context = {
    navigator: { serviceWorker: container },
    window: { isSecureContext: true, addEventListener: (name, callback) => events.set(`window:${name}`, callback), location: { reload() { reloads += 1; } } },
    document: { visibilityState: 'visible', addEventListener: () => {} },
    setInterval: () => 0,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    Date,
    options: { beforeUpdate, onUpdate: value => updates.push(value), onStatus: value => messages.push(value) }
  };
  vm.createContext(context);
  vm.runInContext(controllerSource.replace('export function', 'function') + '\nglobalThis.api = initPwa(options);', context);
  return { api: context.api, events, timers, updates, messages, register, get reloads() { return reloads; }, get activated() { return activated; } };
}

test('update controller detects an already waiting worker and only reloads after consent', async () => {
  const app = controller();
  await Promise.resolve();
  assert.equal(app.updates.at(-1), true);
  assert.equal(app.reloads, 0);
  await app.api.applyUpdate();
  assert.equal(app.activated, 1);
  app.events.get('sw:controllerchange')();
  app.events.get('sw:controllerchange')();
  assert.equal(app.reloads, 1);
});

test('another window activating an update does not reload this window', async () => {
  const app = controller({ waiting: false });
  await Promise.resolve();
  app.events.get('sw:controllerchange')();
  assert.equal(app.reloads, 0);
  assert.equal(app.updates.at(-1), true);
  await app.api.applyUpdate();
  assert.equal(app.reloads, 1);
});

test('first installation does not show an unnecessary update', async () => {
  const app = controller({ waiting: false, controlled: false });
  await Promise.resolve();
  app.events.get('sw:controllerchange')();
  assert.equal(app.updates.at(-1), false);
  assert.equal(app.reloads, 0);
});

test('a briefly waiting worker on first install never becomes an update notice', async () => {
  const app = controller({ waiting: true, controlled: false });
  await Promise.resolve();
  assert.equal(app.updates.at(-1), false);
  app.register.waiting = null;
  app.events.get('sw:controllerchange')();
  assert.equal(app.updates.at(-1), false);
  assert.equal(app.reloads, 0);
});

test('a waiting worker disappearing during activation leaves the update retryable', async () => {
  const app = controller();
  await Promise.resolve();
  app.register.waiting.postMessage = () => { throw new Error('worker became redundant'); };
  assert.equal(await app.api.applyUpdate(), false);
  assert.match(app.messages.at(-1), /could not activate/);
  app.register.waiting.postMessage = () => {};
  assert.equal(await app.api.applyUpdate(), true);
});

test('failed preservation prevents activation and stalled activation allows retry', async () => {
  const unsaved = controller({ beforeUpdate: async () => false });
  await Promise.resolve();
  assert.equal(await unsaved.api.applyUpdate(), false);
  assert.equal(unsaved.activated, 0);
  const stalled = controller();
  await Promise.resolve();
  await stalled.api.applyUpdate();
  stalled.timers[0]();
  assert.match(stalled.messages.at(-1), /taking too long/);
  await stalled.api.applyUpdate();
  assert.equal(stalled.activated, 2);
});

function worker({ brokenAsset, clients = [] } = {}) {
  const listeners = {};
  const stores = new Map([['unrelated-app', new Map([['sentinel', 'preserved']])]]);
  const scope = 'https://example.github.io/walk-advisor/';
  const prefix = `walk-advisor:${scope}:`;
  let activations = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return { async put(url, value) { store.set(String(url), value); }, async match(url) { return store.get(String(url)); } };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  vm.runInNewContext(template.replace('__RELEASE__', 'test-release').replace('__PRECACHE__', JSON.stringify(['index.html', 'app.test-release.js'])), {
    URL, Set, Promise, Error, caches,
    fetch: async url => ({ ok: !String(url).includes(brokenAsset || 'never-fail'), url: String(url), content: 'asset' }),
    self: {
      registration: { scope },
      addEventListener(type, handler) { listeners[type] = handler; },
      skipWaiting() { activations += 1; },
      clients: { matchAll: async () => clients, claim: async () => {} }
    }
  });
  async function lifecycle(type) { let promise; listeners[type]({ waitUntil(value) { promise = value; } }); await promise; }
  function request(path, mode = 'cors') {
    let result;
    listeners.fetch({ request: { url: new URL(path, scope).href, method: 'GET', mode }, respondWith(value) { result = value; } });
    return result;
  }
  return { stores, listeners, prefix, scope, lifecycle, request, get activations() { return activations; } };
}

test('installation is coherent and requires explicit update activation', async () => {
  const app = worker();
  await app.lifecycle('install');
  assert.equal(app.activations, 0);
  assert.equal(app.stores.get(`${app.prefix}test-release`).size, 2);
  app.listeners.message({ data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(app.activations, 1);
});

test('failed required asset prevents installation and removes only its incomplete cache', async () => {
  const app = worker({ brokenAsset: 'app.test-release.js' });
  await assert.rejects(app.lifecycle('install'), /Could not install/);
  assert.equal(app.stores.has(`${app.prefix}test-release`), false);
  assert.equal(app.stores.get('unrelated-app').get('sentinel'), 'preserved');
});

test('offline navigation normalizes query strings; API and recovery bypass cache', async () => {
  const app = worker();
  await app.lifecycle('install');
  const html = await app.request('./?shared=yes', 'navigate');
  assert.equal(html.content, 'asset');
  assert.equal(app.request('https://api.open-meteo.com/v1/forecast'), undefined);
  assert.equal(app.request('./update.html', 'navigate'), undefined);
  assert.equal(app.request('./release.json'), undefined);
  assert.equal(app.request('https://example.github.io/other-app/', 'navigate'), undefined);
});

test('older open windows retain their exact hashed assets', async () => {
  const app = worker({ clients: [{ url: 'https://example.github.io/walk-advisor/' }] });
  const oldUrl = new URL('app.old.js', app.scope).href;
  app.stores.set(`${app.prefix}old`, new Map([[oldUrl, { content: 'old version' }]]));
  await app.lifecycle('install');
  await app.lifecycle('activate');
  assert.equal((await app.request('./app.old.js')).content, 'old version');
  assert.equal(app.stores.has('unrelated-app'), true);
});

test('cache cleanup never removes a sibling app cache', async () => {
  const app = worker();
  app.stores.set(`${app.prefix}old`, new Map());
  await app.lifecycle('install');
  await app.lifecycle('activate');
  assert.equal(app.stores.has(`${app.prefix}old`), false);
  assert.equal(app.stores.has('unrelated-app'), true);
});

test('build hashes module references, includes complete shell, and changes with shipped content', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'walk-advisor-build-'));
  try {
    await mkdir(resolve(root, 'scripts'));
    await mkdir(resolve(root, 'src'));
    await cp(new URL('../public/', import.meta.url), resolve(root, 'public'), { recursive: true });
    await cp(new URL('../scripts/build.mjs', import.meta.url), resolve(root, 'scripts/build.mjs'));
    await cp(new URL('../scripts/sw-template.js', import.meta.url), resolve(root, 'scripts/sw-template.js'));
    await cp(new URL('../LICENSE', import.meta.url), resolve(root, 'LICENSE'));
    const fixture = {
      'index.html': '<link href="./styles.css"><script type="module" src="./app.js"></script>',
      'styles.css': 'body { color: green }',
      'app.js': "import './forecast.js'; import './ranking.js'; import './pwa.js'; const version = '__APP_VERSION__';",
      'forecast.js': 'export const forecast = 1;',
      'ranking.js': 'export const ranking = 1;'
    };
    for (const [name, content] of Object.entries(fixture)) await writeFile(resolve(root, 'src', name), content);
    const build = () => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
    build();
    const version = JSON.parse(await readFile(resolve(root, 'dist/release.json'), 'utf8')).version;
    const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
    assert.ok(html.includes(`./app.${version}.js`));
    const app = await readFile(resolve(root, `dist/app.${version}.js`), 'utf8');
    assert.ok(app.includes(`./forecast.${version}.js`));
    assert.ok(app.includes(`./pwa.${version}.js`));
    assert.ok(!app.includes('__APP_VERSION__'));
    const sw = await readFile(resolve(root, 'dist/sw.js'), 'utf8');
    assert.ok(sw.includes(`app.${version}.js`));
    assert.ok(!sw.includes('"update.html"'));
    assert.ok((await readdir(resolve(root, 'dist/icons'))).includes('icon-512.png'));
    assert.equal(await readFile(resolve(root, 'dist/LICENSE.txt'), 'utf8'), await readFile(resolve(root, 'LICENSE'), 'utf8'));
    build();
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/release.json'), 'utf8')).version, version);
    await writeFile(resolve(root, 'src/styles.css'), 'body { color: blue }');
    build();
    assert.notEqual(JSON.parse(await readFile(resolve(root, 'dist/release.json'), 'utf8')).version, version);
  } finally { await rm(root, { recursive: true, force: true }); }
});

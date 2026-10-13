/* sw.js の動作検証：Cache Storage / fetch をスタブして
   install → activate → 各種fetch（オンライン/圏外/低速） を実際に走らせる。 */
const fs = require('fs');
const vm = require('vm');

const DIR = process.argv[2] || require('path').join(__dirname, '..');
const SCOPE = 'https://shinji-7d.github.io/bench-app/';
const problems = [];
const ok = (m) => console.log('  ✓ ' + m);

/* --- Cache Storage スタブ --- */
const keyOf = (r) => new URL(typeof r === 'string' ? r : r.url, SCOPE).href;
class FakeCache {
  constructor() { this.map = new Map(); }
  async put(req, res) { this.map.set(keyOf(req), res); }
  async add(req) {
    const res = await sandbox.fetch(req);
    if (!res.ok) throw new Error('add failed ' + keyOf(req));
    this.map.set(keyOf(req), res);
  }
  async match(req) { return this.map.get(keyOf(req)); }
}
const caches = {
  store: new Map(),
  async open(n) { if (!this.store.has(n)) this.store.set(n, new FakeCache()); return this.store.get(n); },
  async keys() { return [...this.store.keys()]; },
  async delete(n) { return this.store.delete(n); },
  async match(req) {
    for (const c of this.store.values()) { const h = await c.match(req); if (h) return h; }
    return undefined;
  },
};

/* --- ネットワークスタブ --- */
let NET = 'online'; // online | offline | slow
const SERVED = {};  // path -> body
for (const f of fs.readdirSync(DIR)) {
  if (f.startsWith('.') || fs.statSync(`${DIR}/${f}`).isDirectory()) continue;
  SERVED[f] = fs.readFileSync(`${DIR}/${f}`, 'utf8').slice(0, 80);
}
SERVED[''] = SERVED['index.html'];

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body; this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = init.type ?? 'basic';
    this.headers = { get: (k) => (init.headers || {})[k] || (init.headers || {})[k.toLowerCase()] || null };
    this._tag = init._tag;
  }
  clone() { const r = new FakeResponse(this.body, { status: this.status, type: this.type }); r._tag = this._tag; return r; }
}
let netCalls = 0;
async function fetchStub(req) {
  netCalls++;
  const u = new URL(typeof req === 'string' ? req : req.url, SCOPE);
  if (NET === 'offline') throw new TypeError('Failed to fetch');
  if (NET === 'slow') return new Promise(() => {}); // 永遠に返らない → タイムアウト経路
  const path = u.pathname.replace('/bench-app/', '');
  if (!(path in SERVED)) return new FakeResponse('not found', { status: 404 });
  return new FakeResponse(SERVED[path], { _tag: 'network' });
}

/* --- self スタブ --- */
const handlers = {};
let skipWaitingCalled = false, claimCalled = false;
const sandbox = {
  self: {
    addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); },
    skipWaiting: () => { skipWaitingCalled = true; return Promise.resolve(); },
    clients: { claim: () => { claimCalled = true; return Promise.resolve(); } },
    location: new URL(SCOPE + 'sw.js'),
    registration: { scope: SCOPE },
  },
  caches, fetch: fetchStub, Response: FakeResponse,
  Request: class { constructor(u, init = {}) { this.url = new URL(u, SCOPE).href; this.method = init.method || 'GET'; this.mode = init.mode || 'cors'; this.cache = init.cache; this.headers = { get: () => null }; } },
  URL, setTimeout, clearTimeout, console, Promise, TypeError, Error,
};
sandbox.self.caches = caches; sandbox.self.fetch = fetchStub; sandbox.self.location = sandbox.self.location;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = fs.readFileSync(`${DIR}/sw.js`, 'utf8');
try { new vm.Script(src); } catch (e) { console.error('SYNTAX ERROR in sw.js:', e.message); process.exit(1); }
console.log('✓ sw.js 構文OK');
vm.runInContext(src, sandbox, { filename: 'sw.js' });

/* --- イベント発火ヘルパ --- */
function fire(type, extra = {}) {
  const waits = [];
  const ev = Object.assign({ waitUntil: (p) => waits.push(p), respondWith: (p) => { ev._res = p; } }, extra);
  for (const fn of handlers[type] || []) fn(ev);
  return { ev, done: Promise.all(waits) };
}
const mkReq = (path, init) => new sandbox.Request(SCOPE + path, init);

(async () => {
  /* 1. install */
  const inst = fire('install');
  await inst.done;
  const cacheNames = await caches.keys();
  if (cacheNames.length !== 1) problems.push(`install後のキャッシュ数が ${cacheNames.length}`);
  const c = await caches.open(cacheNames[0]);
  for (const u of ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png']) {
    if (!(await c.match(u))) problems.push(`プリキャッシュ漏れ: ${u}`);
  }
  if (!skipWaitingCalled) problems.push('skipWaiting が呼ばれていない');
  ok(`install: シェル${c.map.size}件をプリキャッシュ / cache名 "${cacheNames[0]}"`);

  /* 2. activate: 自分の旧キャッシュは消す / 同一オリジンの他アプリは消さない */
  caches.store.set('bench13-v0-old', new FakeCache());
  caches.store.set('goals-lp-v3', new FakeCache());      // 同じ *.github.io に同居する別アプリ
  caches.store.set('workbox-precache-x', new FakeCache());
  const act = fire('activate');
  await act.done;
  if (caches.store.has('bench13-v0-old')) problems.push('activate が旧バージョンのキャッシュを削除していない');
  for (const foreign of ['goals-lp-v3', 'workbox-precache-x']) {
    if (!caches.store.has(foreign)) problems.push(`activate が同一オリジンの別アプリのキャッシュ "${foreign}" を削除している`);
  }
  if (!claimCalled) problems.push('clients.claim が呼ばれていない');
  ok('activate: 自分の旧キャッシュのみ削除（他アプリは温存） / clients.claim');

  /* 3. オンラインのナビゲーション → ネットワーク優先 */
  NET = 'online'; netCalls = 0;
  let r = fire('fetch', { request: mkReq('', { mode: 'navigate' }) });
  let res = await r.ev._res;
  if (res._tag !== 'network') problems.push('オンライン時にネットワークから取得していない（stale固定の恐れ）');
  if (netCalls !== 1) problems.push(`オンラインnavigationのfetch回数が ${netCalls}`);
  ok('オンライン: ネットワーク優先で最新HTMLを返す');

  /* 4. 圏外のナビゲーション → キャッシュにフォールバック */
  NET = 'offline';
  r = fire('fetch', { request: mkReq('', { mode: 'navigate' }) });
  res = await r.ev._res;
  if (!res || res.status !== 200) problems.push(`圏外でHTMLが返らない (status=${res && res.status})`);
  if (!String(res.body).includes('<!doctype html')) problems.push('圏外で返ったHTMLが index.html ではない');
  ok('圏外: キャッシュ済みHTMLを返す（オフライン起動できる）');

  /* 5. 低速回線 → タイムアウトしてキャッシュ */
  NET = 'slow';
  const t0 = Date.now();
  r = fire('fetch', { request: mkReq('index.html', { mode: 'navigate' }) });
  res = await r.ev._res;
  const dt = Date.now() - t0;
  if (!res || res.status !== 200) problems.push('低速時にHTMLが返らない');
  if (dt > 5000) problems.push(`タイムアウトが効いていない (${dt}ms)`);
  ok(`低速回線: ${dt}ms でタイムアウト→キャッシュ`);

  /* 6. 圏外のアイコン取得 → キャッシュ */
  NET = 'offline';
  r = fire('fetch', { request: mkReq('icon-192.png') });
  res = await r.ev._res;
  if (!res) problems.push('圏外でアイコンが返らない');
  ok('圏外: アイコンもキャッシュから返る');

  /* 7. 介入しないケース */
  const post = fire('fetch', { request: mkReq('index.html', { method: 'POST' }) });
  if (post.ev._res !== undefined) problems.push('POST を横取りしている');
  const cross = fire('fetch', { request: new sandbox.Request('https://example.com/x.js') });
  if (cross.ev._res !== undefined) problems.push('クロスオリジンを横取りしている');
  ok('POST / クロスオリジンは素通し');

  /* 8. manifest の整合性 */
  const mani = JSON.parse(fs.readFileSync(`${DIR}/manifest.webmanifest`, 'utf8'));
  for (const i of mani.icons) {
    const f = i.src.replace('./', '');
    if (!fs.existsSync(`${DIR}/${f}`)) problems.push(`manifest が存在しないアイコンを参照: ${i.src}`);
  }
  if (!mani.icons.some(i => i.purpose === 'maskable')) problems.push('maskable アイコンが無い');
  if (mani.start_url !== './' || mani.scope !== './') problems.push('start_url/scope が相対パスでない（サブパス配信で壊れる）');
  const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
  if (!html.includes('manifest.webmanifest')) problems.push('index.html が manifest を読み込んでいない');
  if (!html.includes("register('./sw.js')")) problems.push('index.html が sw.js を登録していない');
  if (mani.theme_color !== (html.match(/name="theme-color" content="([^"]+)"/) || [])[1]) problems.push('theme_color が index.html と不一致');
  ok('manifest: アイコン実在・maskable有り・相対パス・HTMLと整合');

  if (problems.length) {
    console.log(`\n✗ 問題 ${problems.length} 件:`);
    problems.forEach(p => console.log('  - ' + p));
    process.exit(1);
  }
  console.log('\n✅ Service Worker 全チェック通過');
})();

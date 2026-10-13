/* bench-app 動作検証ハーネス
   index.html のインラインscriptを取り出し、最小DOMスタブ上で
   全13週 × 全7day を render() まで通す。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

/* --- インラインscriptの抽出 --- */
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1) {
  console.log(`! インラインscriptが ${scripts.length} 個（1個を想定）`);
}
const code = scripts.join('\n;\n');

/* --- 構文チェック --- */
try { new vm.Script(code, { filename: 'index.html(inline)' }); }
catch (e) { console.error('SYNTAX ERROR:', e.message); process.exit(1); }
console.log('✓ 構文OK');

/* --- 最小DOMスタブ --- */
const store = {};
function mkClassList() {
  const set = new Set();
  return { add: c => set.add(c), remove: c => set.delete(c), toggle: (c, on) => on ? set.add(c) : set.delete(c), contains: c => set.has(c) };
}
function mkEl(id) {
  return {
    id, _text: '', _html: '', value: '', dataset: {}, style: {}, classList: mkClassList(),
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); assertHtml(this, v); }, get innerHTML() { return this._html; },
    appendChild() {}, select() {}, focus() {}, blur() {}, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
}
/* 描画結果に壊れた値が出ていないか検査 */
const problems = [];
let ctxLabel = '';
function assertHtml(el, v) {
  const s = String(v);
  for (const bad of ['undefined', 'NaN', 'null', '[object Object]']) {
    // 文字列リテラルとしての出現のみ検出（属性値や本文に出たら描画バグ）
    if (s.includes(bad)) problems.push(`${ctxLabel} #${el.id} に "${bad}" が出力されている`);
  }
}
const document = {
  getElementById: id => (store[id] ||= mkEl(id)),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: tag => mkEl(tag),
  addEventListener() {}, execCommand() {},
  body: mkEl('body'), documentElement: mkEl('html'),
};
const localStorageData = {};
const sandbox = {
  document,
  window: { scrollTo() {}, addEventListener() {}, AudioContext: null, webkitAudioContext: null, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  navigator: { vibrate: () => {}, clipboard: null, serviceWorker: { register: () => Promise.resolve(), addEventListener() {} } },
  localStorage: {
    getItem: k => (k in localStorageData ? localStorageData[k] : null),
    setItem: (k, v) => { localStorageData[k] = String(v); },
    removeItem: k => { delete localStorageData[k]; },
  },
  location: { protocol: 'https:', hostname: 'shinji-7d.github.io', href: 'https://shinji-7d.github.io/bench-app/' },
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  alert: () => {}, confirm: () => true,
};
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.navigator = sandbox.navigator;
sandbox.window.document = document;
sandbox.window.location = sandbox.location;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* --- 読み込み（末尾の render() も走る）
   const/let はサンドボックスのプロパティにならないので、末尾で明示的に取り出す --- */
const EXPORTS = ['DAYS', 'WK', 'TSP', 'RPES', 'buildDay', 'render', 'recKg', 'defaults',
  'progHint', 'dayDone', 'e1rm', 'lastLog', 'save', 'st', 'KEY'];
const exportShim = `\n;globalThis.__exp = { ${EXPORTS.join(', ')} };`;
try { vm.runInContext(code + exportShim, sandbox, { filename: 'index.html(inline)' }); }
catch (e) { console.error('RUNTIME ERROR (初期描画):', e.stack); process.exit(1); }
console.log('✓ 初期描画OK');

const { DAYS, WK, TSP, buildDay, render, recKg, defaults, progHint, dayDone } = sandbox.__exp;
/* st は let 再代入されるため getter 経由で見る */
const ST = () => sandbox.__exp.st;

/* --- 1. 定義の健全性 --- */
const ids = DAYS.map(d => d.id);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
if (dup.length) problems.push(`DAYS に重複id: ${dup.join(',')}`);
for (const d of DAYS) {
  if (!d.id || !d.lb || !d.sub) problems.push(`DAYS[${d.id}] に欠損フィールド`);
}
const weeks = Object.keys(WK).map(Number).sort((a, b) => a - b);
for (const w of weeks) if (!TSP[w]) problems.push(`W${w}: TSP 定義なし`);

/* --- 2. 全週×全day で buildDay を検証 --- */
let exCount = 0;
for (const w of weeks) {
  for (const id of ids) {
    let E;
    try { E = buildDay(w, id); }
    catch (e) { problems.push(`buildDay(${w},${id}) が例外: ${e.message}`); continue; }
    if (!Array.isArray(E)) { problems.push(`buildDay(${w},${id}) が配列を返さない`); continue; }
    if (!E.length) { problems.push(`buildDay(${w},${id}) が空（タブを開いても種目が無い）`); continue; }
    E.forEach((ex, i) => {
      exCount++;
      const tag = `W${w}/${id}[${i}] ${ex.n}`;
      if (!ex.n) problems.push(`${tag}: 種目名なし`);
      if (!Number.isFinite(ex.s) || ex.s < 1) problems.push(`${tag}: セット数が不正 (${ex.s})`);
      if (ex.r != null && !Number.isFinite(ex.r)) problems.push(`${tag}: reps が不正 (${ex.r})`);
      if (ex.rpe != null && !Number.isFinite(ex.rpe)) problems.push(`${tag}: RPE が不正 (${ex.rpe})`);
      if (ex.pct != null && !Number.isFinite(ex.pct)) problems.push(`${tag}: % が不正 (${ex.pct})`);
      if (!Number.isFinite(ex.rest)) problems.push(`${tag}: rest が不正 (${ex.rest})`);
      const kg = recKg(w, ex);
      if (kg !== null && (!Number.isFinite(kg) || kg <= 0)) problems.push(`${tag}: 推奨重量が不正 (${kg})`);
      // 既定値（入力欄の初期値）
      for (let si = 0; si < ex.s; si++) {
        const d = defaults(w, id, ex, si);
        if (d.kg != null && !Number.isFinite(d.kg)) problems.push(`${tag} set${si + 1}: 既定kgが不正 (${d.kg})`);
      }
    });
  }
}
console.log(`✓ buildDay 全走査 (${weeks.length}週 × ${ids.length}day / 種目のべ ${exCount}件)`);

/* --- 3. 全週×全day を実際に render --- */
for (const w of weeks) {
  for (const id of ids) {
    ST().w = w; ST().d = id;
    ctxLabel = `W${w}/${id}`;
    try { render(); }
    catch (e) { problems.push(`render(W${w},${id}) が例外: ${e.message}`); }
  }
}
console.log('✓ 全週×全day の描画');

/* --- 4. 記録→保存→再読込のラウンドトリップ --- */
ST().w = 1; ST().d = 'd1';
const ex1 = buildDay(1, 'd1')[1];
ST().logs[`W1|d1|${ex1.n}`] = [{ kg: 60, reps: 6, rpe: 7 }];
ST().ts[1] = 72.5;
sandbox.__exp.save();
const reread = JSON.parse(localStorageData[Object.keys(localStorageData)[0]]);
if (reread.ts[1] !== 72.5) problems.push('保存→復元で ts が失われる');
if (!reread.logs[`W1|d1|${ex1.n}`]) problems.push('保存→復元で logs が失われる');
// e1RM が TS に追随するか
const before = recKg(1, buildDay(1, 'd1')[1]);
ST().ts[1] = 80;
const after = recKg(1, buildDay(1, 'd1')[1]);
if (!(after > before)) problems.push(`TSを上げても推奨重量が上がらない (${before} → ${after})`);
try { render(); } catch (e) { problems.push(`記録ありの描画で例外: ${e.message}`); }
console.log('✓ 保存/復元・e1RM連動');

/* --- 結果 --- */
if (problems.length) {
  console.log(`\n✗ 問題 ${problems.length} 件:`);
  for (const p of [...new Set(problems)]) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n✅ 全チェック通過');

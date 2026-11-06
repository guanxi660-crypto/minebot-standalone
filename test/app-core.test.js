'use strict';
// 功能索引：HTML 安全、機器人視圖、輸入驗證、記憶體格式、暗色主題契約。
const test = require('node:test');
const assert = require('node:assert');
const A = require('../public/app-core.js');

test('esc: 轉義 HTML 危險字符', () => {
    assert.strictEqual(A.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.strictEqual(A.esc('a"b&c'), 'a&quot;b&amp;c');
});

test('vmBot: note 優先為顯示名，無 note 用 username', () => {
    const b1 = { username: 'Steve', note: '挖礦機', settings: {} };
    const b2 = { username: 'Alex', settings: {} };
    assert.strictEqual(A.vmBot(b1).name, '挖礦機');
    assert.strictEqual(A.vmBot(b2).name, 'Alex');
});

test('vmBot: status 在线 → online=true，其他 false', () => {
    assert.strictEqual(A.vmBot({ status: '在线', settings: {} }).online, true);
    assert.strictEqual(A.vmBot({ status: '离线', settings: {} }).online, false);
    assert.strictEqual(A.vmBot({ status: '连接中', settings: {} }).online, false);
});

test('vmBot: 統計開啟的行為模式（ai/walk/chat/mine）', () => {
    const b = { status: '在线', settings: { ai: true, walk: false, chat: true, mine: true } };
    const vm = A.vmBot(b);
    assert.strictEqual(vm.modes, 3);
    assert.deepStrictEqual(vm.modesList, ['ai', 'chat', 'mine']);
});

test('logLine: msg 轉義 + color 白名單', () => {
    const l = A.logLine({ time: '12:00', msg: '<b>hi</b>', color: 'text-emerald-400' });
    assert.strictEqual(l.html, '&lt;b&gt;hi&lt;/b&gt;');
    assert.strictEqual(l.cls, 'text-emerald-400');
});

test('logLine: 非白名單 color → 安全 fallback', () => {
    const l = A.logLine({ time: '12:00', msg: 'x', color: 'p-2 absolute inset-0' });
    assert.strictEqual(l.cls, 'text-gray-500');
});

test('validatePto: url 須 http 開頭，key/id 必填', () => {
    const r = A.validatePto({ url: 'ftp://x', key: '', id: '', defaultDir: '' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.url && r.errors.key && r.errors.id);
    const ok = A.validatePto({ url: 'https://p.example.com', key: 'ptlc_k', id: 'abc', defaultDir: '/home/container' });
    assert.strictEqual(ok.ok, true);
});

test('validateNewBot: host 必填、username 1-16 字', () => {
    assert.strictEqual(A.validateNewBot({ host: '', username: '' }).ok, false);
    assert.strictEqual(A.validateNewBot({ host: '127.0.0.1', username: 'a'.repeat(17) }).ok, false);
    assert.strictEqual(A.validateNewBot({ host: '127.0.0.1', username: 'Bot1' }).ok, true);
});

test('validateTimer: min/hour 換算為分鐘，0-10080 邊界', () => {
    assert.deepStrictEqual(A.validateTimer('30', 'min'), { ok: true, value: 30 });
    assert.deepStrictEqual(A.validateTimer('2', 'hour'), { ok: true, value: 120 });
    assert.strictEqual(A.validateTimer('0', 'min').ok, false);
    assert.strictEqual(A.validateTimer('abc', 'min').ok, false);
    assert.strictEqual(A.validateTimer('10081', 'min').ok, false);
    assert.strictEqual(A.validateTimer('168', 'hour').ok, true); // 恰為 10080 分鐘上限
    assert.strictEqual(A.validateTimer('169', 'hour').ok, false);
    assert.strictEqual(A.validateTimer('167', 'hour').ok, true);
});

test('fmtMem: percent 字串轉數字 + 條色階', () => {
    assert.strictEqual(A.fmtMem({ used: '1024', total: '4096', percent: '25' }).percentNum, 25);
    assert.strictEqual(A.fmtMem({ percent: '65' }).barCls, 'bg-emerald-500');
    assert.strictEqual(A.fmtMem({ percent: '80' }).barCls, 'bg-amber-500');
    assert.strictEqual(A.fmtMem({ percent: '95' }).barCls, 'bg-red-500');
});

test('console.css: 保留預設暗色，亮色使用獨立主題變數', () => {
    const h = require('fs').readFileSync(require('path').join(__dirname, '../public/console.css'), 'utf8');
    assert.ok(h.includes('color-scheme:dark'), '應宣告 color-scheme:dark');
    assert.ok(h.includes('--bg:#111113'), '暗底變數');
    assert.ok(h.includes('--ink:#e4e4e7'), '亮字變數');
    assert.match(h, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:light/s, '亮色需明確選取才能啟用');
    assert.match(h, /:root\[data-theme="light"\]\s*\{[^}]*--bg:#f5f6f7/s, '亮色背景獨立');
});

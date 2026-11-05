/* 功能索引：loadConsole 測試隔離；session 登出；poll 同步；coreAction 生命週期；機器人網址導覽。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadConsole(api, hash = '') {
    let options;
    const cleared = [];
    const listeners = new Map();
    const browser = { location: { hash }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
    const context = {
        APP: require('../public/app-core.js'),
        Vue: { createApp: value => { options = value; return { mount() {} }; } },
        localStorage: { getItem: () => 'test-token', removeItem() {}, setItem() {} },
        setInterval: () => 10, clearInterval: id => cleared.push(id),
        setTimeout: () => 1, clearTimeout() {}, console, window: browser, confirm: () => true
    };
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const source = fs.existsSync(path.join(__dirname, '../public/console.js'))
        ? fs.readFileSync(path.join(__dirname, '../public/console.js'), 'utf8')
        : [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    vm.runInNewContext(source, context);
    const app = options.data();
    Object.entries(options.methods).forEach(([key, method]) => { app[key] = method.bind(app); });
    Object.entries(options.computed).forEach(([key, getter]) => Object.defineProperty(app, key, { get: () => getter.call(app) }));
    app.$nextTick = fn => fn();
    app.api = api || (async () => ({}));
    return { app, cleared, browser, listeners, options };
}

test('session: 登出清除所有輪詢與上一個帳號的畫面資料', () => {
    const { app, cleared } = loadConsole();
    app._timers = [11, 12]; app.timers = [11, 12];
    app.bots = [{ id: 'private' }]; app.sys = { usedGb: '1' };
    app.logout();
    assert.deepEqual(cleared, [11, 12]);
    assert.equal(app.token, '');
    assert.equal(app.bots.length, 0);
    assert.equal(app.sys, null);
});

test('poll: 更新同一個機器人物件且保留零值草稿與配置錯誤', async () => {
    const { app } = loadConsole(async path => path === '/api/bots'
        ? { bots: [{ id: 'b', status: '在线', settings: { note: 'server' } }] }
        : { used: '1024', total: '4096', percent: '25' });
    const draft = { id: 'b', settings: {}, _tv: 0, _tu: 'hour', _note: '', _p: { url: 'draft' }, _pErr: '網址錯誤', _files: [] };
    app.bots = [draft];
    await app.poll();
    assert.equal(app.bots[0], draft, '進行中的設定操作不能拿到過期物件');
    assert.equal(draft._tv, 0);
    assert.equal(draft._note, '');
    assert.equal(draft._pErr, '網址錯誤');
    assert.equal(draft.status, '在线');
});

test('poll: 失敗有持續錯誤狀態，成功空列表清除錯誤並結束載入', async () => {
    const { app } = loadConsole(async () => { throw new Error('無法連線'); });
    await app.poll();
    assert.equal(app.pollError, '無法連線');
    assert.equal(app.loading, false);
    app.api = async p => p === '/api/bots' ? { bots: [] } : { used: 1, total: 10, percent: 10 };
    await app.poll();
    assert.equal(app.pollError, '');
    assert.equal(app.loaded, true);
    assert.equal(app.bots.length, 0);
});

test('poll: 登出後才抵達的舊請求不能重新填入資料', async () => {
    let resolve;
    const { app } = loadConsole(p => p === '/api/bots' ? new Promise(r => { resolve = r; }) : Promise.resolve({}));
    const pending = app.poll();
    app.logout();
    resolve({ bots: [{ id: 'old-session', settings: {} }] });
    await pending;
    assert.equal(app.bots.length, 0);
});

test('coreAction: 已運行回應缺少 status 時重新取得完整狀態', async () => {
    const actions = [];
    const { app } = loadConsole(async (path, options) => {
        const action = JSON.parse(options.body).action;
        actions.push(action);
        return action === 'status' ? { success: true, status: 'running', autoEnabled: false, detail: '運行中' }
            : { success: true, detail: '已經在運行，無需重複開始' };
    });
    await app.coreAction('start');
    assert.equal(app.core.status, 'running');
    assert.deepEqual(actions, ['start', 'status']);
    assert.equal(app.busy.core, false);
});

test('coreAction: 登出後的啟動回應不能恢復舊狀態或通知', async () => {
    let resolve;
    const { app } = loadConsole(() => new Promise(r => { resolve = r; }));
    const pending = app.coreAction('start');
    app.logout();
    resolve({ success: true, status: 'running', detail: '運行中' });
    await pending;
    assert.equal(app.core.status, 'unknown');
    assert.equal(app.toast.msg, '');
    assert.equal(app.busy.core, false);
});

test('navigation: 直接開啟編碼網址只選出指定機器人，保留原始草稿物件', () => {
    const id = 'bot /中文#';
    const { app } = loadConsole(undefined, '#/bots/' + encodeURIComponent(id));
    const target = { id, username: 'Target', settings: {}, _note: '未儲存' };
    app.bots = [{ id: 'other', username: 'Other', settings: {} }, target];
    assert.equal(app.selectedBotId, id);
    assert.equal(app.detailViews.length, 1);
    assert.equal(app.detailViews[0].raw, target);
});

test('navigation: 不存在或無效編碼的 ID 不會顯示其他機器人', () => {
    for (const hash of ['#/bots/missing', '#/bots/%E0%A4%A']) {
        const { app } = loadConsole(undefined, hash);
        app.bots = [{ id: 'other', username: 'Other', settings: {} }];
        assert.ok(app.selectedBotId);
        assert.equal(app.detailViews.length, 0);
    }
});

test('navigation: 網址變更支援進入與返回，卸載清除監聽', () => {
    const { app, browser, listeners, options } = loadConsole();
    app.startPolling = () => {};
    let focused = 0;
    app.$refs = { workspace: { focus: () => focused++ } };
    options.mounted.call(app);
    assert.equal(typeof listeners.get('hashchange'), 'function');
    browser.location.hash = '#/bots/b'; listeners.get('hashchange')();
    assert.equal(app.selectedBotId, 'b');
    browser.location.hash = '#/'; listeners.get('hashchange')();
    assert.equal(app.selectedBotId, '');
    assert.equal(app.detailViews.length, 0);
    assert.equal(focused, 2);
    options.beforeUnmount.call(app);
    assert.equal(listeners.has('hashchange'), false);
});

test('navigation: 成功移除目前機器人返回總覽，失敗則保留詳情網址', async () => {
    const { app, browser } = loadConsole(async () => ({}), '#/bots/b');
    app.poll = async () => {};
    await app.delBot({ id: 'b', username: 'B' });
    assert.equal(browser.location.hash, '#/');
    browser.location.hash = '#/bots/b';
    app.api = async () => { throw new Error('刪除失敗'); };
    await app.delBot({ id: 'b', username: 'B' });
    assert.equal(browser.location.hash, '#/bots/b');
    assert.equal(app.toast.err, true);
});

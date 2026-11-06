/* 功能索引：瀏覽器啟動；偏好保存與容錯；介面翻譯及動態內容。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot(values = {}, blocked = false) {
    const store = new Map(Object.entries(values));
    const storage = { getItem(key) { if (blocked) throw new Error('blocked'); return store.get(key) ?? null; }, setItem(key, value) { if (blocked) throw new Error('blocked'); store.set(key, value); } };
    const root = { dataset: {}, lang: '' };
    const meta = { setAttribute(name, value) { this[name] = value; } };
    const document = { documentElement: root, querySelector: () => meta, title: '' };
    const context = { document, localStorage: storage };
    const file = path.join(__dirname, '../public/preferences.js');
    vm.runInNewContext(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', context);
    return { prefs: context.UI_PREFS, document, root, meta, storage, store };
}

test('preferences: 首次載入在 Vue 啟動前套用繁中與暗色', () => {
    const { root, meta } = boot();
    assert.equal(root.lang, 'zh-Hant');
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(meta.content, '#111113');
});

test('preferences: 重新載入恢復簡中與亮色並同步瀏覽器色彩', () => {
    const { root, meta } = boot({ mb_locale: 'zh-Hans', mb_theme: 'light' });
    assert.equal(root.lang, 'zh-Hans');
    assert.equal(root.dataset.theme, 'light');
    assert.equal(meta.content, '#f5f6f7');
});

test('preferences: 無效或不可存取的偏好安全退回預設值', () => {
    for (const result of [boot({ mb_locale: 'invalid', mb_theme: 'auto' }), boot({}, true)]) {
        assert.equal(result.root.lang, 'zh-Hant');
        assert.equal(result.root.dataset.theme, 'dark');
    }
});

test('preferences: 兩種偏好獨立保存，不覆寫登入資訊，寫入失敗仍可切換', () => {
    const { prefs, storage, store } = boot({ mb_token: 'kept' });
    let state = prefs.read(storage);
    state = prefs.save(storage, state, 'locale', 'zh-Hans');
    state = prefs.save(storage, state, 'theme', 'light');
    assert.equal(state.locale, 'zh-Hans');
    assert.equal(state.theme, 'light');
    assert.equal(store.get('mb_locale'), 'zh-Hans');
    assert.equal(store.get('mb_theme'), 'light');
    assert.equal(store.get('mb_token'), 'kept');
    assert.equal(prefs.save(storage, state, 'theme', 'invalid').theme, 'light');
    const unavailable = boot({}, true);
    assert.equal(unavailable.prefs.save(unavailable.storage, { locale: 'zh-Hant', theme: 'dark' }, 'theme', 'light').theme, 'light');
});

test('preferences: 翻譯介面詞句及參數，不轉換使用者內容或外部訊息', () => {
    const { prefs } = boot();
    assert.equal(prefs.translate('zh-Hans', '機器人工作區'), '机器人工作区');
    assert.equal(prefs.translate('zh-Hant', '機器人工作區'), '機器人工作區');
    assert.equal(prefs.translate('zh-Hans', '移除機器人 {name}？', { name: '繁體礦場 <script>$&</script>' }), '移除机器人 繁體礦場 <script>$&</script>？');
    assert.equal(prefs.translate('zh-Hans', '遠端自訂訊息'), '遠端自訂訊息');
    assert.equal(prefs.translate('zh-Hans', '最近 {count} 筆', { count: 0 }), '最近 0 条');
    assert.equal(prefs.translate('invalid', '機器人工作區'), '機器人工作區');
});

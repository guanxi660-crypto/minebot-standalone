/* 功能索引：隔離 API 契約；認證與狀態；機器人與設定；翼龍與檔案；響應式及鍵盤回歸。
   透過 Playwright browser_run_code_unsafe filename 執行；所有 /api 請求均攔截，不寫入真實機器人。 */
async (page) => {
    const passed = [], requests = [], errors = [];
    const check = (ok, name) => { if (!ok) throw new Error(name); passed.push(name); };
    const state = { bots: [], core: 'stopped', loginFail: true, addFail: true, fail: '', expired: false, hold: null };
    const fixture = { id: 'ui-bot', username: 'UITester', host: 'play.example.com', port: 25565,
        status: '在线', playerCount: 2, nextRestart: '', logs: [],
        settings: { note: '', ai: false, walk: false, chat: false, mine: false } };
    const onError = error => errors.push(error.message);
    page.on('pageerror', onError);
    await page.unroute('**/api/**');
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        const data = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null;
        requests.push({ p, method: request.method(), data, dir: url.searchParams.get('dir') });
        if (state.expired) return route.fulfill({ status: 401, json: { error: 'expired' } });
        if (state.fail && p.endsWith(state.fail)) return route.fulfill({ status: 503, json: { success: false, error: '測試服務暫時無法連線' } });
        let result = { success: true };
        if (p === '/api/login') {
            if (state.loginFail) return route.fulfill({ status: 401, json: { error: '帳號或密碼錯誤' } });
            result.token = 'isolated-interaction-test';
        } else if (p === '/api/bots') {
            if (request.method() === 'POST') {
                if (state.addFail) return route.fulfill({ status: 400, json: { success: false, error: '測試新增失敗' } });
                state.bots = [structuredClone(fixture)];
            } else {
                if (state.hold) await state.hold;
                result.bots = state.bots;
            }
        } else if (p === '/api/system/status') result = { used: '512', total: '2048', percent: '25' };
        else if (p === '/api/core') {
            if (data.action === 'status') result = { success: true, status: state.core, detail: '', autoEnabled: false };
            else { state.core = data.action === 'start' ? 'running' : 'stopped'; result.detail = '指令已處理'; }
        } else if (request.method() === 'DELETE') state.bots = [];
        else if (p.endsWith('/toggle')) state.bots[0].settings[data.type] = !state.bots[0].settings[data.type];
        else if (p.endsWith('/note')) state.bots[0].settings.note = data.note;
        else if (p.endsWith('/pto-config')) state.bots[0].settings.pterodactyl = data;
        else if (p.endsWith('/test-panel')) result = { success: true, name: '測試伺服器', status: 'running' };
        else if (p.endsWith('/files')) result.files = url.searchParams.get('dir') ? [] : [
            { object: 'file_object', attributes: { name: 'plugins', is_file: false, size: 0 } },
            { object: 'file_object', attributes: { name: 'server.properties', is_file: true, size: 1024 } }
        ];
        else if (p.endsWith('/download')) result.url = 'https://download.example.com/signed-file';
        await route.fulfill({ json: result });
    });
    const act = async (name, operation, suffix, expected) => {
        const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() !== 'GET');
        await operation();
        const r = await response;
        check(r.ok(), name + '：API 成功');
        if (expected) check(Object.entries(expected).every(([k, v]) => r.request().postDataJSON()[k] === v), name + '：請求內容正確');
    };
    try {
        await page.goto('http://127.0.0.1:4681/#/');
        await page.evaluate(() => localStorage.removeItem('mb_token'));
        await page.reload();
        await page.getByRole('heading', { name: '登入工作區' }).waitFor();
        await page.getByRole('button', { name: '登入控制台' }).click();
        check(!requests.some(r => r.p === '/api/login'), '空白登入由必填欄位阻擋');
        await page.getByLabel('使用者名稱', { exact: true }).fill('ui-test');
        await page.getByLabel('密碼', { exact: true }).fill('test-only');
        await page.getByRole('button', { name: '登入控制台' }).click();
        await page.getByText('帳號或密碼錯誤', { exact: true }).waitFor();
        passed.push('登入失敗可見且可重試');
        state.loginFail = false;
        await page.getByRole('button', { name: '登入控制台' }).click();
        await page.getByRole('heading', { name: '準備好第一個機器人' }).waitFor();
        passed.push('登入成功顯示空狀態');
        await page.getByLabel('伺服器位址', { exact: true }).fill('play.example.com');
        await page.getByLabel('玩家名稱', { exact: true }).fill('UITester');
        await page.getByRole('button', { name: '新增機器人', exact: true }).click();
        await page.getByText('測試新增失敗', { exact: true }).waitFor();
        check(await page.getByLabel('玩家名稱', { exact: true }).inputValue() === 'UITester', '新增失敗保留欄位');
        state.addFail = false;
        await act('新增機器人', () => page.getByRole('button', { name: '新增機器人', exact: true }).click(), '/api/bots', { host: 'play.example.com', username: 'UITester', port: 25565 });
        const bot = page.locator('[data-bot-id="ui-bot"]');
        await page.locator('.bot-summary').waitFor();
        await page.evaluate(() => { window.__confirm = true; window.confirm = () => window.__confirm; });
        check(await page.getByLabel('玩家名稱', { exact: true }).inputValue() === '', '新增成功清空表單');
        await page.getByRole('link', { name: 'UITester', exact: true }).click();
        await bot.waitFor();
        await act('重新連線', () => bot.getByRole('button', { name: '重新連線', exact: true }).click(), '/reconnect');
        await act('立即重啟', () => bot.getByRole('button', { name: '立即重啟' }).click(), '/restart-now');
        for (const [id, name] of [['ai', 'AI 視角'], ['walk', '自主行走'], ['chat', '自動聊天'], ['mine', '自動挖礦']]) {
            await act(name, () => bot.getByRole('checkbox', { name: new RegExp(name) }).check(), '/toggle', { type: id });
        }
        state.fail = '/toggle';
        await bot.getByRole('checkbox', { name: /AI 視角/ }).click();
        await page.locator('.toast-error').waitFor();
        check(await bot.getByRole('checkbox', { name: /AI 視角/ }).isChecked(), '開關 API 失敗恢復原狀態');
        state.fail = '';
        const timer = bot.locator('details').filter({ has: page.locator('summary', { hasText: '定時重啟' }) });
        await timer.locator('summary').focus();
        await page.keyboard.press('Enter');
        await timer.getByLabel('重啟間隔').fill('2');
        await timer.getByLabel('時間單位').selectOption('hour');
        await act('儲存兩小時排程', () => timer.getByRole('button', { name: '儲存排程' }).click(), '/set-timer', { value: 120, unit: 'min' });
        await act('停用排程', () => timer.getByRole('button', { name: '停用排程' }).click(), '/set-timer', { value: 0, unit: 'min' });
        await bot.locator('summary').filter({ hasText: '名稱與備註' }).click();
        await bot.getByLabel('顯示名稱').fill('測試工作區');
        await act('儲存備註', () => bot.getByRole('button', { name: '儲存備註' }).click(), '/note', { note: '測試工作區' });
        await bot.getByRole('heading', { name: '測試工作區', exact: true }).waitFor();
        await bot.locator('summary').filter({ hasText: '翼龍面板' }).click();
        await bot.getByRole('button', { name: '儲存設定' }).click();
        check(await bot.locator('.detail-body .error-text').isVisible(), '翼龍設定必填驗證');
        for (const [name, value] of [['面板網址', 'https://panel.example.com'], ['API Key', 'test-key'], ['伺服器 ID', 'test-id'], ['預設目錄', '/home/container']]) await bot.getByLabel(name, { exact: true }).fill(value);
        await act('翼龍設定', () => bot.getByRole('button', { name: '儲存設定' }).click(), '/pto-config', { url: 'https://panel.example.com', key: 'test-key', id: 'test-id', defaultDir: '/home/container' });
        await act('測試面板連線', () => bot.getByRole('button', { name: '測試連線' }).click(), '/test-panel');
        for (const [name, signal] of [['開機', 'start'], ['重啟電源', 'restart'], ['關機', 'stop']]) await act(name, () => bot.getByRole('button', { name, exact: true }).click(), '/power', { signal });
        const beforeKill = requests.filter(r => r.data?.signal === 'kill').length;
        await page.evaluate(() => { window.__confirm = false; });
        await bot.getByRole('button', { name: '強制終止', exact: true }).click();
        check(requests.filter(r => r.data?.signal === 'kill').length === beforeKill, '取消強制終止不送請求');
        await page.evaluate(() => { window.__confirm = true; });
        await act('確認強制終止', () => bot.getByRole('button', { name: '強制終止', exact: true }).click(), '/power', { signal: 'kill' });
        state.fail = '/files';
        await bot.getByRole('button', { name: '載入檔案' }).click();
        await bot.locator('.file-section .error-text').waitFor();
        passed.push('檔案列表錯誤顯示於所屬區域');
        state.fail = '';
        await bot.getByRole('button', { name: '載入檔案' }).click();
        await bot.getByRole('button', { name: 'plugins /', exact: true }).waitFor();
        check(await bot.getByRole('button', { name: '下載', exact: true }).count() === 1, 'file_object 以 is_file 正確分辨檔案與目錄');
        await bot.getByRole('button', { name: 'plugins /', exact: true }).click();
        await bot.getByText('這個目錄還沒有檔案。', { exact: true }).waitFor();
        check(requests.some(r => r.dir === '/home/container/plugins'), '目錄路徑包含已設定的預設目錄');
        await bot.getByRole('button', { name: '回預設目錄' }).click();
        await bot.getByRole('button', { name: '下載', exact: true }).waitFor();
        await page.evaluate(() => { window.__openedDownload = null; window.open = (...args) => { window.__openedDownload = args; }; });
        await act('下載路徑', () => bot.getByRole('button', { name: '下載', exact: true }).click(), '/download', { file: '/home/container/server.properties' });
        await page.waitForFunction(() => window.__openedDownload);
        check(await page.evaluate(() => window.__openedDownload[0] === 'https://download.example.com/signed-file' && window.__openedDownload[2] === 'noopener'), '下載使用後端回傳連結');
        await act('上傳檔案', () => bot.getByLabel('上傳檔案').setInputFiles({ name: 'ui-test.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated UI test') }), '/upload');
        await page.getByText('檔案已上傳', { exact: false }).waitFor();
        await act('刪除檔案', () => bot.locator('.file-row').filter({ hasText: 'server.properties' }).getByRole('button', { name: '刪除' }).click(), '/files/delete', { file: '/home/container/server.properties' });
        await page.getByRole('link', { name: '返回機器人總覽', exact: true }).click();
        await act('啟動核心', () => page.getByRole('button', { name: '啟動核心服務' }).click(), '/api/core', { action: 'start' });
        await page.getByRole('button', { name: '停止核心服務' }).waitFor();
        state.fail = '/api/core';
        await page.getByRole('button', { name: '停止核心服務' }).click();
        await page.locator('.core-section .error-text').waitFor();
        state.fail = '';
        await act('停止核心', () => page.getByRole('button', { name: '停止核心服務' }).click(), '/api/core', { action: 'stop' });
        await page.getByRole('button', { name: '啟動核心服務' }).waitFor();
        await page.getByRole('button', { name: '關閉通知' }).click();
        check(await page.locator('.toast').count() === 0, '通知可關閉');
        await page.getByRole('link', { name: '測試工作區', exact: true }).click();
        await bot.waitFor();
        await bot.locator('details').evaluateAll(nodes => nodes.forEach(n => n.open = true));
        for (const width of [1440, 1024, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 全部設定展開無溢出`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { window.__confirm = false; });
        await bot.getByRole('button', { name: '移除機器人' }).click();
        check(state.bots.length === 1, '取消移除保留機器人');
        await page.evaluate(() => { window.__confirm = true; });
        await act('移除機器人', () => bot.getByRole('button', { name: '移除機器人' }).click(), '/api/bots/ui-bot');
        await page.getByRole('heading', { name: '準備好第一個機器人' }).waitFor();
        state.fail = '/api/bots';
        await page.reload();
        await page.getByText('無法同步機器人', { exact: true }).waitFor();
        state.fail = '';
        await page.getByRole('button', { name: '重新整理', exact: true }).click();
        await page.getByRole('heading', { name: '準備好第一個機器人' }).waitFor();
        check(await page.locator('.error-notice').count() === 0, '同步錯誤可重試恢復');
        let release;
        state.hold = new Promise(resolve => { release = resolve; });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '正在讀取工作區' }).waitFor();
        passed.push('載入狀態可見');
        release(); state.hold = null;
        await page.getByRole('heading', { name: '準備好第一個機器人' }).waitFor();
        state.expired = true;
        await page.reload();
        await page.getByRole('heading', { name: '登入工作區' }).waitFor();
        check(await page.evaluate(() => !localStorage.getItem('mb_token')), '401 清除憑證並返回登入');
        check(errors.length === 0, '無 JavaScript 例外');
        return { pass: true, passed, count: passed.length };
    } finally {
        page.off('pageerror', onError);
        await page.evaluate(() => { document.querySelector('#app').__vue_app__?._instance?.proxy?.logout(); localStorage.removeItem('mb_token'); });
        await page.unroute('**/api/**');
        await page.reload();
    }
}

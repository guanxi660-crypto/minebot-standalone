/* 功能索引：隔離多實例 API；總覽與單機導覽；草稿與網址還原；載入／失效／移除；雙頁響應式。
   使用 Playwright browser_run_code_unsafe filename 執行，所有 API 均為測試資料。 */
async (page) => {
    const passed = [], errors = [], requests = [], cardSizes = [];
    const check = (ok, name) => { if (!ok) throw new Error(name); passed.push(name); };
    const state = { bots: ['alpha', 'beta', 'bot /中文#', 'delta'].map((id, i) => ({ id, username: 'Preview' + i,
        host: 'test.example.com', port: 25565, status: i === 1 ? '离线' : '在线', playerCount: i,
        settings: { note: ['建築工作區', '備援機器人', '特殊 ID', '採集工作區'][i], ai: true },
        logs: [{ time: '12:00:00', msg: '獨立日誌 ' + id, color: 'text-gray-400' }] })), fail: false, hold: null };
    const onError = e => errors.push(e.message);
    page.on('pageerror', onError);
    await page.route('**/api/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        requests.push({ path, method: request.method() });
        if (state.fail && path === '/api/bots') return route.fulfill({ status: 503, json: { error: '測試同步中斷' } });
        if (path === '/api/bots' && state.hold) await state.hold;
        if (request.method() === 'DELETE') state.bots = state.bots.filter(b => b.id !== decodeURIComponent(path.split('/').pop()));
        const body = path === '/api/bots' ? { success: true, bots: state.bots }
            : path === '/api/system/status' ? { used: 256, total: 2048, percent: 12.5 }
            : path === '/api/core' ? { success: true, status: 'stopped' } : { success: true };
        await route.fulfill({ json: body });
    });
    try {
        await page.goto('http://127.0.0.1:4681/#/');
        await page.evaluate(() => localStorage.setItem('mb_token', 'isolated-navigation-test'));
        await page.reload();
        await page.getByRole('heading', { name: '建築工作區', exact: true }).waitFor();
        check(await page.locator('.bot-summary').count() === 4, '總覽顯示四張小卡片');
        check(await page.locator('.bot-card, .log-box, .behavior-switch').count() === 0, '總覽不渲染完整控制卡片');
        check(await page.getByLabel('伺服器位址', { exact: true }).count() === 1, '總覽保留新增入口');
        for (const width of [1440, 1024, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + 'px 總覽無溢出');
            const heights = await page.locator('.bot-summary').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
            const previousHeight = width <= 640 ? 192.6875 : 196.6875;
            cardSizes.push({ width, previousHeight, heights });
            check(heights.every(height => height / previousHeight >= .84 && height / previousHeight <= .86), width + 'px 小卡片高度縮小約 15%');
            check(await page.locator('.bot-summary h3, .bot-summary p, .bot-summary span').evaluateAll(nodes => nodes.every(n => parseFloat(getComputedStyle(n).fontSize) >= 12)), width + 'px 小卡片文字維持至少 12px');
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole('link', { name: '建築工作區', exact: true }).focus();
        await page.keyboard.press('Enter');
        const bot = page.locator('.bot-card[data-bot-id="alpha"]');
        await bot.waitFor();
        check(page.url().endsWith('#/bots/alpha'), '鍵盤開啟可分享的機器人網址');
        check(await page.locator('.bot-card').count() === 1, '詳情只有選定機器人');
        check(await page.locator('aside, .bot-summary, #add-bot').count() === 0, '詳情不顯示其他機器人與全域控制');
        check(await bot.locator('.log-box').textContent().then(t => t.includes('獨立日誌 alpha') && !t.includes('beta')), '日誌屬於選定機器人');
        check(await page.evaluate(() => document.activeElement.id === 'workspace'), '切頁後焦點移至工作區');
        await bot.locator('summary').filter({ hasText: '名稱與備註' }).click();
        await bot.getByLabel('顯示名稱').fill('尚未儲存的草稿');
        await page.getByRole('link', { name: '返回機器人總覽', exact: true }).click();
        await page.locator('.bot-summary').first().waitFor();
        await page.goBack();
        await bot.waitFor();
        await bot.locator('summary').filter({ hasText: '名稱與備註' }).click();
        check(await bot.getByLabel('顯示名稱').inputValue() === '尚未儲存的草稿', '上一頁還原目標並保留未儲存草稿');
        await page.goForward();
        await page.locator('.bot-summary').first().waitFor();
        check(await page.locator('.bot-card').count() === 0, '下一頁回到小卡片總覽');
        await page.getByRole('link', { name: '特殊 ID', exact: true }).click();
        await page.locator('.bot-card').waitFor();
        await page.reload();
        await page.locator('.bot-card').waitFor();
        check(await page.locator('.bot-card').getAttribute('data-bot-id') === 'bot /中文#', '編碼網址重新整理還原相同機器人');
        await page.goto('http://127.0.0.1:4681/#/bots/beta');
        await page.locator('.bot-card[data-bot-id="beta"]').waitFor();
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/bots/beta/reconnect');
        await page.getByRole('button', { name: '重新連線', exact: true }).click();
        check((await response).ok() && !requests.some(r => r.path === '/api/bots/alpha/reconnect'), '詳情操作只送出選定 ID');
        await page.locator('.bot-card details').evaluateAll(nodes => nodes.forEach(n => n.open = true));
        for (const width of [1440, 1024, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + 'px 詳情展開無溢出');
        }
        await page.evaluate(() => { window.confirm = () => true; });
        await page.getByRole('button', { name: '移除機器人', exact: true }).click();
        await page.locator('.bot-summary').first().waitFor();
        check(page.url().endsWith('#/') && await page.locator('.bot-summary').count() === 3, '刪除目前機器人返回總覽並更新卡片數');
        await page.goto('http://127.0.0.1:4681/#/bots/beta');
        await page.getByRole('heading', { name: '找不到這個機器人', exact: true }).waitFor();
        check(await page.locator('.bot-card').count() === 0, '失效連結不顯示其他機器人');
        await page.goto('http://127.0.0.1:4681/#/bots/%E0%A4%A');
        await page.getByRole('heading', { name: '找不到這個機器人', exact: true }).waitFor();
        passed.push('無效網址編碼不造成例外');
        state.fail = true;
        await page.reload();
        await page.getByText('無法同步機器人', { exact: true }).waitFor();
        check(await page.getByRole('heading', { name: '找不到這個機器人', exact: true }).count() === 0, '同步失敗不誤報機器人不存在');
        state.fail = false;
        let release;
        state.hold = new Promise(resolve => { release = resolve; });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '正在讀取工作區', exact: true }).waitFor();
        check(await page.getByRole('heading', { name: '找不到這個機器人', exact: true }).count() === 0, '深連結讀取完成前不誤報不存在');
        release(); state.hold = null;
        await page.getByRole('heading', { name: '找不到這個機器人', exact: true }).waitFor();
        check(errors.length === 0, '導覽沒有 JavaScript 例外');
        return { pass: true, count: passed.length, passed, cardSizes };
    } finally {
        page.off('pageerror', onError);
        await page.unroute('**/api/**');
        await page.evaluate(() => { document.querySelector('#app').__vue_app__?._instance?.proxy?.logout(); });
    }
}

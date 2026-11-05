/* 功能索引：API 隔離 fixture；登入與語意契約；響應式／觸控驗證。使用 Playwright browser_run_code_unsafe filename 執行。 */
async (page) => {
    const failures = [];
    const check = (condition, name) => { if (!condition) failures.push(name); };
    await page.unroute('**/api/**');
    await page.route('**/api/**', async route => {
        const p = new URL(route.request().url()).pathname;
        const body = p === '/api/bots' ? { success: true, bots: [{
            id: 'design-test', username: 'LocalTester', host: '127.0.0.1', port: 25565,
            status: '在线', playerCount: 1, nextRestart: '',
            settings: { note: '生存伺服器', ai: true, walk: false, chat: false, mine: false },
            logs: [{ time: '12:08:32', msg: '機器人已連線，等待伺服器訊息。', color: 'text-emerald-400' },
                { time: '12:08:33', msg: '<img src=x onerror=alert(1)>', color: 'invalid' }]
        }] } : p === '/api/system/status' ? { used: '256', total: '2048', percent: '12.5' }
            : { success: true, status: 'stopped', autoEnabled: false, detail: '' };
        await route.fulfill({ json: body });
    });
    await page.goto('http://127.0.0.1:4681/#/');
    await page.evaluate(() => localStorage.setItem('mb_token', 'isolated-ui-test'));
    await page.reload();
    await page.locator('.bot-summary').waitFor();
    check(await page.getByRole('heading', { name: '機器人工作區', exact: true }).count() === 1, '工作區缺少主要標題');
    check(await page.getByRole('complementary', { name: '工作區設定' }).count() === 1, '缺少獨立系統側欄');
    check(await page.getByLabel('伺服器位址', { exact: true }).count() === 1, '新增位址缺可見標籤');
    await page.getByRole('link', { name: '生存伺服器', exact: true }).click();
    await page.locator('[data-bot-id]').waitFor();
    check(await page.getByRole('checkbox', { name: /AI 視角/ }).count() === 1, '行為開關缺可及名稱');
    check(await page.locator('.log-box img').count() === 0, '日誌 XSS');
    const sizes = [];
    for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const result = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            small: [...document.querySelectorAll('button, summary')].filter(e => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44);
            }).map(e => e.textContent.trim()),
            smallText: [...document.querySelectorAll('body *')].filter(e => e.checkVisibility() &&
                [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) &&
                parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.textContent.trim())
        }));
        check(!result.overflow, `${width}px 頁面橫向溢出`);
        check(!result.small.length, `${width}px 小於44px操作：${result.small.join(',')}`);
        check(!result.smallText.length, `${width}px 小於12px文字：${result.smallText.join(',')}`);
        sizes.push({ width, ...result });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    return { pass: failures.length === 0, failures, sizes };
}

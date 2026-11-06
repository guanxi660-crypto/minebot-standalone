/* 功能索引：隔離十八實例資料；桌機側欄跟隨；短視窗鍵盤可達；手機正常流與詳情隔離。
   使用 Playwright browser_run_code_unsafe filename 執行，僅在隔離瀏覽器 context 使用。 */
async (page) => {
    const passed = [], sizes = [];
    const check = (ok, name) => { if (!ok) throw new Error(name); passed.push(name); };
    const bots = Array.from({ length: 18 }, (_, i) => ({ id: 'sidebar-' + i, username: 'Sidebar' + i,
        host: 'localhost', port: 25565, status: '在线', logs: [], settings: { note: '側欄測試 ' + i, ai: true } }));
    await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        const json = path === '/api/bots' ? { success: true, bots }
            : path === '/api/system/status' ? { used: 256, total: 2048, percent: 12.5 }
            : { success: true, status: 'stopped', detail: '核心服務已停止' };
        return route.fulfill({ json });
    });
    try {
        await page.goto('http://127.0.0.1:4681/#/');
        await page.evaluate(() => localStorage.setItem('mb_token', 'isolated-sidebar-test'));
        await page.reload();
        await page.locator('.bot-summary').nth(17).waitFor();
        for (const [width, height] of [[1440, 1000], [1024, 768], [1440, 600], [961, 600]]) {
            await page.setViewportSize({ width, height });
            const positions = [];
            for (const y of [400, 800]) {
                await page.evaluate(y => { window.scrollTo(0, y); document.querySelector('#workspace-settings').scrollTop = 0; }, y);
                await page.evaluate(() => new Promise(requestAnimationFrame));
                positions.push(await page.locator('#workspace-settings').boundingBox());
            }
            check(positions.every(r => r.y >= 16 && r.y <= 32), width + '×' + height + ' 側欄隨頁面捲動保持可見');
            check(Math.abs(positions[0].y - positions[1].y) <= 1, width + '×' + height + ' 捲動後側欄停留相同高度');
            check(positions.every(r => r.y + r.height <= height - 16), width + '×' + height + ' 側欄不超出視窗底部');
            const sidebar = await page.locator('#workspace-settings').evaluate(n => ({ client: n.clientHeight, scroll: n.scrollHeight }));
            if (height === 600) check(sidebar.scroll > sidebar.client, width + 'px 短視窗可捲動側欄內容');
            await page.locator('#new-user').focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            const keyboard = await page.evaluate(() => {
                const active = document.activeElement, r = active.getBoundingClientRect();
                return { core: !!active.closest('.core-section'), top: r.top, bottom: r.bottom,
                    focusVisible: active.matches(':focus-visible'), overflow: document.documentElement.scrollWidth > innerWidth };
            });
            check(keyboard.core && keyboard.focusVisible && keyboard.top >= 0 && keyboard.bottom <= height, width + '×' + height + ' 鍵盤可到達並看見核心按鈕');
            check(!keyboard.overflow, width + '×' + height + ' 無水平溢出');
            sizes.push({ width, height, positions, sidebar });
        }
        for (const width of [960, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(() => window.scrollTo(0, 0));
            const before = await page.locator('#workspace-settings').boundingBox();
            await page.evaluate(() => window.scrollTo(0, 300));
            const after = await page.locator('#workspace-settings').boundingBox();
            check(Math.abs(before.y - after.y - 300) <= 1, width + 'px 側欄維持正常頁面流');
            check(await page.locator('#workspace-settings').evaluate(n => n.scrollHeight <= n.clientHeight + 1), width + 'px 側欄不截斷內容');
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + 'px 無水平溢出');
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const edge = await page.evaluate(() => ({ sidebar: document.querySelector('#workspace-settings').getBoundingClientRect().bottom,
            footer: document.querySelector('.workspace-footer').getBoundingClientRect().top }));
        check(edge.sidebar <= edge.footer, '頁尾不被側欄遮住');
        await page.goto('http://127.0.0.1:4681/#/bots/sidebar-0');
        await page.locator('.bot-card').waitFor();
        check(await page.locator('#workspace-settings').count() === 0, '單機詳情不出現側欄');
        return { pass: true, count: passed.length, passed, sizes };
    } finally {
        await page.unroute('**/api/**');
        await page.evaluate(() => document.querySelector('#app').__vue_app__?._instance?.proxy?.logout());
    }
}

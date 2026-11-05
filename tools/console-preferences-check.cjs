/* 功能索引：隔離 API；登入偏好；單機切換與資料保留；四組外觀與響應式；清理。 */
async (page) => {
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const fixture = { id: 'prefs-test', username: 'PreferenceTest', note: '繁體礦場', host: 'localhost', port: 25565, status: '在线', logs: [{ time: '12:00', msg: '繁體原始日誌 <img src=x>', color: 'text-emerald-400' }], settings: { note: '繁體礦場', ai: true, walk: false, chat: false, mine: false } };
  const errors = [], writes = [];
  const onError = error => errors.push(error.message);
  const route = async request => {
    const url = new URL(request.request().url());
    const body = request.request().postDataJSON();
    if (request.request().method() !== 'GET') writes.push({ path: url.pathname, body });
    const data = url.pathname === '/api/login' ? { token: 'preference-test' } : url.pathname === '/api/bots' ? { success: true, bots: [fixture] } : url.pathname === '/api/core' ? { success: true, status: 'stopped', detail: '' } : { percent: '12', used: '256', total: '2048' };
    await request.fulfill({ json: data });
  };
  await page.route('**/api/**', route); page.on('pageerror', onError);
  try {
    await page.goto('http://127.0.0.1:4681/#/');
    await page.evaluate(() => { localStorage.removeItem('mb_token'); localStorage.removeItem('mb_locale'); localStorage.removeItem('mb_theme'); });
    await page.reload(); await page.locator('#login-user').waitFor();
    check(await page.locator('[data-preference="locale"]').count() === 1, '登入頁提供語言切換');
    check(await page.locator('[data-preference="theme"]').count() === 1, '登入頁提供主題切換');
    await page.locator('[data-preference="locale"]').selectOption('zh-Hans');
    await page.locator('[data-preference="theme"]').selectOption('light');
    check(await page.getByRole('heading', { name: '登录工作区' }).count() === 1, '登入文字即時切為簡中');
    check(await page.locator('html').getAttribute('lang') === 'zh-Hans', '文件語言同步');
    check(await page.locator('html').getAttribute('data-theme') === 'light', '文件主題同步');
    await page.reload(); await page.locator('#login-user').waitFor();
    check(await page.locator('[data-preference="locale"]').inputValue() === 'zh-Hans', '重新整理保留語言');
    check(await page.locator('[data-preference="theme"]').inputValue() === 'light', '重新整理保留主題');
    await page.locator('#login-user').fill('tester'); await page.locator('#login-password').fill('fixture');
    await page.getByRole('button', { name: '登录控制台' }).click(); await page.locator('.bot-summary').waitFor();
    await page.locator('.bot-summary').click(); await page.locator('.bot-card').waitFor();
    await page.getByText('名称与备注', { exact: true }).click();
    await page.getByLabel('显示名称', { exact: true }).fill('草稿繁體名稱');
    const routeBefore = page.url(), writesBefore = writes.length;
    for (const locale of ['zh-Hant', 'zh-Hans']) {
      for (const theme of ['dark', 'light']) {
        await page.locator('[data-preference="locale"]').selectOption(locale);
        await page.locator('[data-preference="theme"]').selectOption(theme);
        const simplified = locale === 'zh-Hans';
        check(await page.getByRole('heading', { name: simplified ? '机器人详情' : '機器人詳情' }).count() === 1, locale + '/' + theme + ' 詳情文字');
        check(await page.getByLabel(simplified ? '显示名称' : '顯示名稱', { exact: true }).inputValue() === '草稿繁體名稱', locale + '/' + theme + ' 保留草稿');
        check(await page.locator('.bot-title-row h3').textContent() === '繁體礦場', locale + '/' + theme + ' 保留名稱');
        check((await page.locator('.log-box').textContent()).includes('繁體原始日誌 <img src=x>') && await page.locator('.log-box img').count() === 0, locale + '/' + theme + ' 保留日誌與轉義');
        check(page.url() === routeBefore, locale + '/' + theme + ' 不改導覽');
        const colors = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
        check(colors.scheme === theme && colors.background === (theme === 'light' ? 'rgb(245, 246, 247)' : 'rgb(17, 17, 19)'), locale + '/' + theme + ' 套用完整底色與原生控制項主題');
        for (const width of [1440, 1024, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), locale + '/' + theme + '/' + width + ' 無水平溢出');
        }
      }
    }
    check(writes.length === writesBefore, '切換不呼叫機器人寫入 API');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.locator('#login-user').waitFor();
    check(await page.locator('[data-preference="locale"]').inputValue() === 'zh-Hans' && await page.locator('[data-preference="theme"]').inputValue() === 'light', '登出保留外觀偏好');
    check(errors.length === 0, '無 JavaScript 錯誤');
    return { pass: true, checks: checks.length, results: checks };
  } finally {
    page.off('pageerror', onError); await page.unroute('**/api/**', route);
    await page.evaluate(() => { localStorage.removeItem('mb_token'); localStorage.removeItem('mb_locale'); localStorage.removeItem('mb_theme'); });
  }
}

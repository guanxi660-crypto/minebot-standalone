/* 功能索引：隔離資料；四組語言／主題的三種頁面；文字與控制項檢查；通知及確認翻譯；清理。 */
async (page) => {
  const results = [], checks = [], errors = [], requests = [];
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const fixture = { id: 'theme-test', username: 'ThemeTest', host: 'localhost', port: 25565, status: '在线',
    logs: ['emerald', 'red', 'yellow', 'sky', 'gray', 'purple'].map(color => ({ time: '12:00', msg: color + ' 原始日誌', color: 'text-' + color + '-400' })),
    settings: { note: '繁體礦場', ai: true, walk: false, chat: false, mine: false } };
  const onError = error => errors.push(error.message);
  const route = async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method() });
    const result = path === '/api/login' ? { token: 'theme-test' } : path === '/api/bots' ? { success: true, bots: [fixture] }
      : path === '/api/core' ? { success: true, status: 'stopped', detail: '' }
      : path.endsWith('/files') ? { success: true, files: [{ attributes: { name: '繁體設定.txt', size: 128, is_file: true } }] }
      : path === '/api/system/status' ? { percent: '12', used: '256', total: '2048' } : { success: true };
    await route.fulfill({ json: result });
  };
  const audit = async () => page.evaluate(() => {
    const rgb = color => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const failures = []; let texts = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.closest(':disabled')) continue;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      if (el.matches('input,select') && !el.labels?.length && !el.getAttribute('aria-label')) failures.push('unnamed: ' + el.outerHTML.slice(0, 80));
      if (el.matches('button,a[href],summary,select,input:not([type=file]):not([type=checkbox])') && (rect.width < 44 || rect.height < 44)) failures.push('size: ' + el.textContent.trim().slice(0, 40));
      const text = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!text && !el.matches('input,select')) continue;
      let parent = el, background = 'rgb(255,255,255)';
      while (parent) {
        const color = getComputedStyle(parent).backgroundColor;
        if (!color.startsWith('rgba')) { background = color; break; }
        parent = parent.parentElement;
      }
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && +style.fontWeight >= 700);
      for (const color of [style.color, ...(el.matches('input[placeholder]') ? [getComputedStyle(el, '::placeholder').color] : [])]) {
        const a = lum(rgb(color)), b = lum(rgb(background)), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        if (ratio < (large ? 3 : 4.5)) failures.push('contrast ' + ratio.toFixed(2) + ': ' + (el.textContent || el.getAttribute('placeholder') || el.id).slice(0, 50));
        texts++;
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) failures.push('overflow');
    return { texts, failures };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', onError); await page.route('**/api/**', route);
  try {
    await page.goto('http://127.0.0.1:4681/#/');
    await page.evaluate(() => { localStorage.removeItem('mb_token'); localStorage.removeItem('mb_locale'); localStorage.removeItem('mb_theme'); });
    await page.reload(); await page.locator('#login-user').waitFor();
    for (const surface of ['login', 'overview', 'detail']) {
      if (surface === 'overview') {
        await page.locator('#login-user').fill('fixture'); await page.locator('#login-password').fill('fixture');
        await page.locator('.login-card button').click(); await page.locator('.bot-summary').waitFor();
      }
      if (surface === 'detail') {
        await page.locator('.bot-summary').click(); await page.locator('.bot-card').waitFor();
        await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await page.getByRole('button', { name: '加载文件', exact: true }).click();
        await page.locator('.file-row').waitFor();
      }
      for (const locale of ['zh-Hant', 'zh-Hans']) for (const theme of ['dark', 'light']) {
        await page.locator('#ui-locale').selectOption(locale); await page.locator('#ui-theme').selectOption(theme);
        for (const width of [1440, 320]) {
          await page.setViewportSize({ width, height: 900 });
          const result = await audit(); results.push({ surface, locale, theme, width, ...result });
          check(!result.failures.length, [surface, locale, theme, width, ...result.failures].join(' / '));
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '重新连接指令已发送' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '暂停指令已发送' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '恢复指令已发送' }).waitFor({ timeout: 5000 });
    await page.locator('#ui-locale').selectOption('zh-Hant');
    check((await page.locator('.toast').textContent()).includes('重新連線指令已送出'), '已顯示通知即時隨語言切換');
    await page.locator('#ui-locale').selectOption('zh-Hans');
    check((await page.locator('.detail-body .error-text').textContent()) === '网址须以 http(s):// 开头', '既有驗證訊息隨語言切換');
    await page.evaluate(() => { window.__confirmation = ''; window.confirm = message => { window.__confirmation = message; return false; }; });
    await page.getByRole('button', { name: '删除', exact: true }).click();
    check(await page.evaluate(() => window.__confirmation === '删除 繁體設定.txt？'), '刪除確認使用簡中並保留檔名原文');
    await page.getByRole('button', { name: '移除机器人', exact: true }).click();
    check(await page.evaluate(() => window.__confirmation === '移除机器人 ThemeTest？'), '移除確認使用目前語言');
    await page.getByRole('button', { name: '强制终止', exact: true }).click();
    check(await page.evaluate(() => window.__confirmation === '强制终止服务器？未保存的数据可能丢失。'), '強制終止確認使用目前語言');
    check(!requests.some(r => r.method === 'DELETE' || r.path.endsWith('/files/delete') || r.path.endsWith('/power')), '取消確認不送出破壞性操作');
    check(errors.length === 0, '沒有 JavaScript 例外');
    return { pass: true, checks: checks.length, results };
  } finally {
    page.off('pageerror', onError);
    await page.evaluate(() => { document.querySelector('#app').__vue_app__?._instance?.proxy?.logout(); localStorage.removeItem('mb_locale'); localStorage.removeItem('mb_theme'); });
    await page.unroute('**/api/**', route);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
}

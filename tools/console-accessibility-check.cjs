/* 功能索引：可見文字對比；表單名稱與操作尺寸。以 Playwright filename 執行，檢查目前畫面。 */
async (page) => page.evaluate(() => {
    const rgb = color => (color.match(/[\d.]+/g) || []).map(Number);
    const luminance = color => color.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const contrast = [], unnamed = [], undersized = [];
    let textCount = 0;
    for (const el of document.querySelectorAll('body *')) {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.closest(':disabled')) continue;
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) {
            let background = [255, 255, 255], ancestor = el;
            while (ancestor) {
                const color = rgb(getComputedStyle(ancestor).backgroundColor);
                if (color.length === 3 || color[3] === 1) { background = color; break; }
                ancestor = ancestor.parentElement;
            }
            const a = luminance(rgb(style.color)), b = luminance(background), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
            const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && +style.fontWeight >= 700);
            if (ratio < (large ? 3 : 4.5)) contrast.push({ text: el.textContent.trim().slice(0, 70), ratio: +ratio.toFixed(2), color: style.color });
            textCount++;
        }
        if (el.matches('input,select') && !el.labels?.length && !el.getAttribute('aria-label')) unnamed.push(el.outerHTML.slice(0, 100));
        if (el.matches('button,a[href],summary,select,input:not([type=file]):not([type=checkbox])') && rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) undersized.push({ text: el.textContent.trim(), width: rect.width, height: rect.height });
    }
    return { pass: !contrast.length && !unnamed.length && !undersized.length, textCount, contrast, unnamed, undersized };
})

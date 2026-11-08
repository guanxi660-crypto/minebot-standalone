/**
 * app-core.js — 前端純函數核心（UMD：Node 測試 / 瀏覽器 window.APP）
 *
 * 功能位置：
 *  L12  esc            HTML 轉義（XSS 防線）
 *  L20  vmBot          機器人視圖模型（顯示名/在線/模式統計）
 *  L40  logLine        單條日誌渲染數據（轉義 + color 白名單）
 *  L56  validatePto    翼龍面板配置驗證
 *  L72  validateNewBot 新增機器人驗證（host + username 1-16）
 *  L84  validateTimer  重啟定時驗證（min/hour → 分鐘，1-10080）
 *  L102 fmtMem         系統記憶體視圖（percent 數字 + 條色階）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.APP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // L12 — HTML 轉義
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // L20 — 機器人視圖模型
    function vmBot(b) {
        const s = b.settings || {};
        const modesList = ['ai', 'walk', 'chat', 'mine'].filter(k => s[k] === true);
        return {
            id: b.id,
            name: (s.note || b.note || b.username || '').trim() || b.username,
            username: b.username,
            host: b.host,
            port: b.port || 25565,
            statusText: b.status || '未知',
            online: b.status === '在线',
            playerCount: b.playerCount || 0,
            nextRestart: b.nextRestart || '',
            modes: modesList.length,
            modesList,
            logs: (b.logs || []).map(logLine)
        };
    }

    // L40 — 單條日誌（color 白名單，防 class 注入）
    const COLOR_RE = /^text-(emerald|red|yellow|amber|sky|gray|purple|green|orange|blue)-(400|500)$/;
    function logLine(l) {
        l = l || {};
        return {
            time: l.time || '',
            html: esc(l.msg),
            cls: COLOR_RE.test(l.color) ? l.color : 'text-gray-500'
        };
    }

    // L56 — 翼龍配置驗證
    function validatePto(c) {
        c = c || {};
        const errors = {};
        const url = (c.url || '').trim(), key = (c.key || '').trim(),
              id = (c.id || '').trim(), dir = (c.defaultDir || '').trim();
        if (!/^https?:\/\//.test(url)) errors.url = '網址須以 http(s):// 開頭';
        if (!key) errors.key = 'API Key 必填';
        if (!id) errors.id = '伺服器 ID 必填';
        return { ok: Object.keys(errors).length === 0, errors, value: { url, key, id, defaultDir: dir } };
    }

    // L72 — 新增機器人驗證
    function validateNewBot(f) {
        f = f || {};
        const errors = {};
        const host = (f.host || '').trim(), username = (f.username || '').trim();
        if (!host) errors.host = '伺服器位址必填';
        if (!username || username.length > 16) errors.username = '玩家名須 1-16 字';
        return { ok: Object.keys(errors).length === 0, errors, value: { host, username } };
    }

    // L84 — 定時驗證：統一存分鐘，上限 10080（168h）
    function validateTimer(raw, unit) {
        const v = Number(raw);
        if (!Number.isFinite(v) || !Number.isInteger(v)) return { ok: false };
        const min = unit === 'hour' ? v * 60 : v;
        if (min < 1 || min > 10080) return { ok: false };
        return { ok: true, value: min };
    }

    // L102 — 記憶體視圖（含 CPU 占用透傳）
    function fmtMem(m) {
        m = m || {};
        const p = Math.round(parseFloat(m.percent) || 0);
        const barCls = p < 70 ? 'bg-emerald-500' : p < 90 ? 'bg-amber-500' : 'bg-red-500';
        const usedGb = (parseFloat(m.used) / 1024).toFixed(1);
        const totalGb = (parseFloat(m.total) / 1024).toFixed(1);
        const cpuNum = (parseFloat(m.cpu) || 0).toFixed(1);
        return { percentNum: p, barCls, usedGb, totalGb, cpuNum };
    }

    return { esc, vmBot, logLine, validatePto, validateNewBot, validateTimer, fmtMem };
});

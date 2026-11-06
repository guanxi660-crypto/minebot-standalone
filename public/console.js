/* 功能索引：畫面、偏好與網址模型；認證與導覽生命週期；poll 狀態同步；機器人操作；翼龍與檔案操作。 */
const { createApp } = Vue;
createApp({
  data() {
    return {
      token: localStorage.getItem('mb_token') || '', lf: { username: '', password: '' }, af: { host: '', username: '' },
      loginErr: '', afErr: '', bots: [], sys: null, core: { status: 'unknown', detail: '' },
      loading: true, loaded: false, polling: false, pollError: '', systemError: '', coreError: '',
      busy: { login: false, add: false, core: false }, toast: { msg: '', err: false },
      timers: [], toastTimer: null, session: 0, route: window.location.hash, preferences: UI_PREFS.read(localStorage),
      modes: [{ id: 'ai', name: 'AI 視角', detail: '注視附近玩家' }, { id: 'walk', name: '自主行走', detail: '隨機巡邏' }, { id: 'chat', name: '自動聊天', detail: '定時發送訊息' }, { id: 'mine', name: '自動挖礦', detail: '挖掘鄰近方塊' }]
    };
  },
  computed: {
    botViews() { return this.bots.map(raw => ({ raw, view: APP.vmBot(raw) })); },
    selectedBotId() {
      if (!this.route.startsWith('#/bots/')) return '';
      const id = this.route.slice(7);
      try { return decodeURIComponent(id); } catch { return id; }
    },
    detailViews() { return this.selectedBotId ? this.botViews.filter(b => b.raw.id === this.selectedBotId) : []; },
    onlineCount() { return this.botViews.filter(b => b.view.online).length; },
    coreLabel() { return this.t({ running: '運行中', starting: '啟動中', stopped: '已停止', unknown: '尚未取得' }[this.core.status] || this.core.status); }
  },
  methods: {
    t(text, params) { return UI_PREFS.translate(this.preferences.locale, text, params); },
    setPreference(key, value) {
      this.preferences = UI_PREFS.save(localStorage, this.preferences, key, value);
      UI_PREFS.apply(this.preferences, document);
    },
    syncRoute() {
      const previous = this.selectedBotId;
      this.route = window.location.hash;
      if (previous !== this.selectedBotId) this.$nextTick(() => this.$refs?.workspace?.focus());
    },
    statusLabel(value) { return this.t({ '在线': '在線', '离线': '離線', '连接中': '連線中', '重连中': '重新連線中' }[value] || value); },
    say(msg, err, params) {
      this.toast = { msg, err: !!err, params };
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toast.msg = '', 5000);
    },
    async api(path, opts = {}) {
      const token = this.token;
      const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
      if (r.status === 401) { if (this.token === token) this.logout(); throw new Error('登入已過期，請重新登入'); }
      const d = await r.json();
      if (!r.ok || d.success === false) throw new Error(d.error || '請求失敗，請稍後重試');
      return d;
    },
    startPolling() {
      this.timers.forEach(clearInterval);
      this.poll(); this.pollCore();
      this.timers = [setInterval(() => this.poll(), 5000), setInterval(() => this.pollCore(), 30000)];
    },
    async login() {
      this.busy.login = true; this.loginErr = '';
      try {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.lf) });
        const d = await r.json();
        if (!r.ok || !d.token) throw new Error(d.error || '登入失敗，請確認帳號與密碼');
        this.token = d.token; localStorage.setItem('mb_token', d.token); this.lf.password = '';
        this.loading = true; this.startPolling();
      } catch (e) { this.loginErr = e.message; } finally { this.busy.login = false; }
    },
    logout() {
      this.timers.forEach(clearInterval); this.timers = []; clearTimeout(this.toastTimer);
      this.session++; this.token = ''; localStorage.removeItem('mb_token');
      this.bots = []; this.sys = null; this.core = { status: 'unknown', detail: '' };
      this.loaded = false; this.loading = true; this.polling = false;
      this.busy.core = false;
      this.pollError = ''; this.systemError = ''; this.coreError = ''; this.toast.msg = '';
    },
    async poll() {
      if (!this.token || this.polling) return;
      const session = this.session;
      this.polling = true;
      try {
        const d = await this.api('/api/bots');
        if (session !== this.session) return;
        const old = new Map(this.bots.map(b => [b.id, b]));
        this.bots = d.bots.map(b => {
          const current = old.get(b.id);
          if (current) return Object.assign(current, b, { settings: b.settings || {} });
          const settings = b.settings || {};
          return { ...b, settings, _p: { ...(settings.pterodactyl || {}) }, _tv: 30, _tu: 'min', _note: settings.note || '', _pErr: '', _files: null, _fdir: '', _filesError: '', _filesLoading: false };
        });
        this.loaded = true; this.pollError = '';
        try {
          const sys = await this.api('/api/system/status');
          if (session !== this.session) return;
          this.sys = APP.fmtMem(sys); this.systemError = '';
        } catch (e) { if (session === this.session) this.systemError = e.message; }
      } catch (e) { if (session === this.session) this.pollError = e.message; }
      finally { if (session === this.session) { this.loading = false; this.polling = false; } }
    },
    async pollCore() {
      if (!this.token || this.busy.core) return;
      const session = this.session;
      try {
        const core = await this.api('/api/core', { method: 'POST', body: JSON.stringify({ action: 'status' }) });
        if (session === this.session) { this.core = core; this.coreError = ''; }
      } catch (e) { if (session === this.session) this.coreError = e.message; }
    },
    async coreAction(action) {
      if (!this.token || this.busy.core) return;
      const session = this.session;
      this.busy.core = true; this.coreError = '';
      try {
        let core = await this.api('/api/core', { method: 'POST', body: JSON.stringify({ action }) });
        if (session !== this.session) return;
        if (!core.status) core = await this.api('/api/core', { method: 'POST', body: JSON.stringify({ action: 'status' }) });
        if (session !== this.session) return;
        this.core = core;
        this.say(action === 'start' ? '核心服務啟動指令已送出' : '核心服務已停止');
      } catch (e) { if (session === this.session) this.coreError = e.message; }
      finally { if (session === this.session) this.busy.core = false; }
    },
    async addBot() {
      const v = APP.validateNewBot(this.af);
      if (!v.ok) { this.afErr = Object.values(v.errors)[0]; return; }
      this.afErr = ''; this.busy.add = true;
      try {
        await this.api('/api/bots', { method: 'POST', body: JSON.stringify({ ...v.value, port: 25565 }) });
        this.af = { host: '', username: '' }; this.say('機器人已新增'); await this.poll();
      } catch (e) { this.afErr = e.message; } finally { this.busy.add = false; }
    },
    async delBot(b) {
      if (!confirm(this.t('移除機器人 {name}？', { name: b.username }))) return;
      try {
        await this.api('/api/bots/' + b.id, { method: 'DELETE' });
        if (this.selectedBotId === b.id) window.location.hash = '#/';
        await this.poll(); this.say('機器人已移除');
      }
      catch (e) { this.say(e.message, true); }
    },
    async act(b, action) {
      try { await this.api('/api/bots/' + b.id + '/' + action, { method: 'POST' }); this.say(action === 'reconnect' ? '重新連線指令已送出' : '重啟指令已送出'); }
      catch (e) { this.say(e.message, true); }
    },
    async toggle(b, type, event) {
      b._busyMode = type;
      try {
        await this.api('/api/bots/' + b.id + '/toggle', { method: 'POST', body: JSON.stringify({ type }) });
        b.settings[type] = event.target.checked;
      } catch (e) { event.target.checked = !!b.settings[type]; this.say(e.message, true); }
      finally { b._busyMode = ''; }
    },
    async setTimer(b, zero) {
      const v = zero === 0 ? { ok: true, value: 0 } : APP.validateTimer(b._tv, b._tu);
      if (!v.ok) { this.say('間隔須為 1–10080 分鐘（最多 168 小時）', true); return; }
      try {
        await this.api('/api/bots/' + b.id + '/set-timer', { method: 'POST', body: JSON.stringify({ value: v.value, unit: 'min' }) });
        this.say(v.value ? '重啟排程已儲存' : '重啟排程已停用'); this.poll();
      } catch (e) { this.say(e.message, true); }
    },
    async saveNote(b) {
      try { await this.api('/api/bots/' + b.id + '/note', { method: 'POST', body: JSON.stringify({ note: b._note }) }); this.say('備註已儲存'); this.poll(); }
      catch (e) { this.say(e.message, true); }
    },
    async savePto(b) {
      const v = APP.validatePto(b._p);
      if (!v.ok) { b._pErr = Object.values(v.errors)[0]; return; }
      b._pErr = '';
      try { await this.api('/api/bots/' + b.id + '/pto-config', { method: 'POST', body: JSON.stringify(v.value) }); this.say('翼龍設定已儲存'); this.poll(); }
      catch (e) { b._pErr = e.message; }
    },
    async testPanel(b) {
      try { const d = await this.api('/api/bots/' + b.id + '/test-panel', { method: 'POST' }); this.say(d.name + '（' + d.status + '）'); }
      catch (e) { this.say(e.message, true); }
    },
    async power(b, signal) {
      if (signal === 'kill' && !confirm(this.t('強制終止伺服器？未儲存的資料可能遺失。'))) return;
      try { await this.api('/api/bots/' + b.id + '/power', { method: 'POST', body: JSON.stringify({ signal }) }); this.say('電源指令已送出：{signal}', false, { signal }); }
      catch (e) { this.say(e.message, true); }
    },
    filePath(b, f) { return (b._fdir || b.settings.pterodactyl?.defaultDir || '').replace(/\/$/, '') + '/' + f.attributes.name; },
    async loadFiles(b, dir) {
      b._filesLoading = true; b._filesError = '';
      try { const d = await this.api('/api/bots/' + b.id + '/files?dir=' + encodeURIComponent(dir)); b._files = d.files || []; b._fdir = dir; }
      catch (e) { b._filesError = e.message; } finally { b._filesLoading = false; }
    },
    async upload(b, ev) {
      const file = ev.target.files[0]; if (!file) return;
      const fd = new FormData(); fd.append('file', file); fd.append('directory', b._fdir || ''); b._uploading = true;
      try {
        const r = await fetch('/api/bots/' + b.id + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + this.token }, body: fd });
        if (r.status === 401) { this.logout(); throw new Error('登入已過期，請重新登入'); }
        const d = await r.json(); if (!r.ok || d.success === false) throw new Error(d.error || '上傳失敗');
        this.say('檔案已上傳'); await this.loadFiles(b, b._fdir || '');
      } catch (e) { this.say(e.message, true); } finally { ev.target.value = ''; b._uploading = false; }
    },
    async download(b, f) {
      try { const d = await this.api('/api/bots/' + b.id + '/download', { method: 'POST', body: JSON.stringify({ file: this.filePath(b, f) }) }); if (d.url) window.open(d.url, '_blank', 'noopener'); }
      catch (e) { this.say(e.message, true); }
    },
    async delFile(b, f) {
      if (!confirm(this.t('刪除 {name}？', { name: f.attributes.name }))) return;
      try { await this.api('/api/bots/' + b.id + '/files/delete', { method: 'POST', body: JSON.stringify({ file: this.filePath(b, f) }) }); this.loadFiles(b, b._fdir || ''); }
      catch (e) { this.say(e.message, true); }
    },
    fmtSize(n) { return n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  },
  mounted() { window.addEventListener('hashchange', this.syncRoute); if (this.token) this.startPolling(); },
  beforeUnmount() { window.removeEventListener('hashchange', this.syncRoute); this.timers.forEach(clearInterval); clearTimeout(this.toastTimer); }
}).mount('#app');

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUBSCRIPTION_TIMEOUT_MS = 15000;
const SUBSCRIPTION_USER_AGENTS = [
    'Minebot/1.0',
    'v2rayN/7.20.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
];
const DEFAULT_SPEEDTEST_URL = 'https://www.google.com/generate_204';
const SPEEDTEST_TIMEOUT_MS = 10000;

const applyIfPresent = (target, key, value) => {
    if (value !== undefined && value !== null && value !== '') target[key] = value;
};

const toBool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const toInt = (value, fallback = undefined) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const toList = (value) => Array.isArray(value)
    ? value.filter(Boolean)
    : String(value || '').split(',').map(item => item.trim()).filter(Boolean);
const normalizeHost = (value) => String(value || '').trim().replace(/^\[(.*)\]$/, '$1');
const isIpLiteralHost = (value) => net.isIP(normalizeHost(value)) !== 0;
const VMESS_TLS_SECURITY_MODES = new Set(['tls', 'reality']);
const PROXY_LINK_SCHEME_RE = /^(vmess|vless|trojan|ss|shadowsocks|socks|socks5|http|https|tuic|hy2|hysteria2):\/\//i;
const normalizeVmessSecurity = (value, fallback = 'none') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return fallback;
    return VMESS_TLS_SECURITY_MODES.has(normalized) ? fallback : normalized;
};
const normalizeImportedProxyLink = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || PROXY_LINK_SCHEME_RE.test(trimmed) || !/%[0-9A-Fa-f]{2}/.test(trimmed)) return trimmed;
    try {
        const decoded = decodeURIComponent(trimmed);
        return PROXY_LINK_SCHEME_RE.test(decoded) ? decoded : trimmed;
    } catch {
        return trimmed;
    }
};
const nodeUsesReality = (node = {}) => {
    const type = String(node?.type || '').trim().toLowerCase();
    const security = String(node?.security || '').trim().toLowerCase();
    return type === 'vless' && (
        security === 'reality'
        || !!node?.pbk
        || !!node?.tls?.reality?.public_key
        || !!node?.tls?.reality?.enabled
    );
};
const nodeUsesTls = (node = {}) => {
    if (nodeUsesReality(node)) return true;

    const type = String(node?.type || '').trim().toLowerCase();
    const security = String(node?.security || '').trim().toLowerCase();
    if (type !== 'vmess' && security === 'none') return false;
    if (node?.tls === true) return true;
    if (type === 'vmess') return security === 'tls';
    return security === 'tls' || security === 'reality';
};
const normalizeHysteria2Obfs = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'none' || raw === 'false' || raw === '0') return '';
    return raw;
};
const parsePluginString = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return {};
    const [plugin, ...rest] = raw.split(';');
    return {
        plugin: plugin || undefined,
        plugin_opts: rest.length ? rest.join(';') : undefined
    };
};
const normalizeWsHeaders = (node, wsHost) => {
    if (!wsHost) return;
    if (!node.headers || typeof node.headers !== 'object' || Array.isArray(node.headers)) {
        node.headers = {};
    }
    delete node.headers.Host;
    delete node.headers.host;
    node.headers.Host = wsHost;
};
const trimBase64Padding = (value) => value.replace(/=+$/, '');
const looksLikeBase64Payload = (value) => {
    const normalized = String(value || '').trim().replace(/\s+/g, '');
    if (!normalized || normalized.length < 16 || /[^A-Za-z0-9+/=_-]/.test(normalized)) return false;
    const sanitized = trimBase64Padding(normalized).replace(/-/g, '+').replace(/_/g, '/');
    if (!sanitized || sanitized.length % 4 === 1) return false;
    try {
        const decoded = Buffer.from(sanitized, 'base64').toString('utf8').trim();
        return decoded.includes('://') || decoded.startsWith('{') || decoded.startsWith('[') || decoded.includes('outbounds') || decoded.includes('proxies:');
    } catch {
        return false;
    }
};
const decodeBase64Payload = (value) => Buffer.from(
    trimBase64Padding(String(value || '').trim().replace(/\s+/g, '')).replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
).toString('utf8');
const isPrivateSubscriptionHost = (hostname) => {
    const host = normalizeHost(hostname).toLowerCase();
    return host === 'localhost'
        || host === '::'
        || host === '::1'
        || host.startsWith('127.')
        || host.startsWith('10.')
        || host.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || host.startsWith('fc')
        || host.startsWith('fd')
        || host.startsWith('fe80:');
};

export class ProxyService {
    constructor() {
        this.proxyProcess = null;
        this.nodes = [];
        // Use process.cwd() for definitive root on Windows
        this.projectRoot = process.cwd();
        // Fix: Use __dirname to find data dir relative to this service file, strictly safe for Docker
        // __dirname is server/services/, so ../data resolves to server/data/
        this.configPath = path.join(__dirname, '../data/proxy_config.json');
        console.log('[ProxyService] Initialized. CWD:', this.projectRoot, 'Config:', this.configPath);
        this.binPath = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
        this.basePort = 20000;
        this.nodePortMap = new Map(); // nodeId -> localPort
    }

    setNodes(nodes) {
        this.nodes = nodes || [];
        this.updatePortMap();
    }

    updatePortMap() {
        this.nodePortMap.clear();
        this.nodes.forEach((node, index) => {
            this.nodePortMap.set(node.id, this.basePort + index);
        });
    }

    getLocalPort(nodeId) {
        return this.nodePortMap.get(nodeId);
    }

    generateConfig() {
        const inbounds = this.nodes.map((node, index) => ({
            type: 'socks',
            tag: `in-${node.id}`,
            listen: '127.0.0.1',
            listen_port: this.basePort + index
        }));

        const outbounds = this.nodes.map(node => {
            const serverHost = normalizeHost(node.server);
            const outbound = {
                type: node.type,
                tag: `out-${node.id}`,
                server: serverHost,
                server_port: node.port
            };

            if (node.type === 'socks' || node.type === 'http') {
                applyIfPresent(outbound, 'username', node.username);
                applyIfPresent(outbound, 'password', node.password);
                if (node.type === 'socks') outbound.version = node.version || '5';
            } else if (node.password) {
                outbound.password = node.password;
            }

            if (node.uuid) {
                let uuid = node.uuid;
                if (uuid.includes('%3A') || uuid.includes(':')) uuid = decodeURIComponent(uuid).split(':')[0];
                outbound.uuid = uuid;
            }

            if (node.type === 'vmess') {
                outbound.security = normalizeVmessSecurity(node.security, 'none');
                outbound.alter_id = parseInt(node.alterId || 0, 10);
                outbound.packet_encoding = node.packet_encoding || 'packetaddr';
            } else if (node.type === 'shadowsocks') {
                outbound.method = node.method || 'aes-256-gcm';
                applyIfPresent(outbound, 'plugin', node.plugin);
                applyIfPresent(outbound, 'plugin_opts', node.plugin_opts);
            } else if (node.type === 'vless') {
                outbound.packet_encoding = node.packet_encoding || 'xudp';
            }

            applyIfPresent(outbound, 'network', node.network);
            applyIfPresent(outbound, 'ip', node.ip);

            const isTls = nodeUsesTls(node);
            const tlsExplicitlyDisabled = node.type !== 'vmess' && String(node.security || '').trim().toLowerCase() === 'none';

            if (isTls || (node.sni && !tlsExplicitlyDisabled)) {
                outbound.tls = {
                    enabled: true,
                    server_name: normalizeHost(node.sni) || node.wsHost || serverHost,
                    insecure: !!node.insecure,
                    utls: {
                        enabled: true,
                        fingerprint: node.fp || 'chrome'
                    }
                };

                if (node.record_fragment !== undefined) outbound.tls.record_fragment = !!node.record_fragment;
                const tlsAlpn = toList(node.alpn);
                if (tlsAlpn.length) outbound.tls.alpn = tlsAlpn;
                applyIfPresent(outbound.tls, 'min_version', node.tls_min_version);
                applyIfPresent(outbound.tls, 'max_version', node.tls_max_version);
                if (node.tls_cipher_suites) outbound.tls.cipher_suites = toList(node.tls_cipher_suites);
                if (node.certificate_public_key_sha256) outbound.tls.certificate_public_key_sha256 = toList(node.certificate_public_key_sha256);

                if (nodeUsesReality(node)) {
                    outbound.tls.reality = {
                        enabled: true,
                        public_key: node.pbk,
                        short_id: node.sid
                    };
                    if (node.spx) outbound.tls.reality.spider_x = node.spx;
                    if (node.reality_next_protocol) outbound.tls.reality.next_protocol = toList(node.reality_next_protocol);
                }
            }

            if (node.transport === 'ws') {
                let cleanPath = node.wsPath || '/';
                let maxEarlyData = node.max_early_data;

                if (cleanPath.includes('ed=')) {
                    const match = cleanPath.match(/[?&]ed=(\d+)/);
                    if (match && match[1]) {
                        if (maxEarlyData === undefined) maxEarlyData = parseInt(match[1], 10);
                        cleanPath = cleanPath.replace(/[?&]ed=\d+/, '').replace(/\?$/, '').replace(/&$/, '');
                        if (!cleanPath) cleanPath = '/';
                    }
                }

                outbound.transport = {
                    type: 'ws',
                    path: cleanPath,
                    headers: {}
                };

                const hostHeader = node.wsHost || normalizeHost(node.sni) || serverHost;
                if (hostHeader && !isIpLiteralHost(hostHeader)) {
                    outbound.transport.headers.Host = hostHeader;
                    if (outbound.tls && !outbound.tls.server_name) outbound.tls.server_name = hostHeader;
                }

                if (maxEarlyData !== undefined) {
                    outbound.transport.max_early_data = parseInt(maxEarlyData, 10);
                    outbound.transport.early_data_header_name = node.early_data_header_name || 'Sec-WebSocket-Protocol';
                }
                if (node.headers && typeof node.headers === 'object' && !Array.isArray(node.headers)) {
                    outbound.transport.headers = { ...outbound.transport.headers, ...node.headers };
                }
            } else if (node.transport === 'grpc') {
                outbound.transport = {
                    type: 'grpc',
                    service_name: node.serviceName || ''
                };
                if (node.grpc_idle_timeout !== undefined) outbound.transport.idle_timeout = `${node.grpc_idle_timeout}s`;
                if (node.grpc_ping_timeout !== undefined) outbound.transport.ping_timeout = `${node.grpc_ping_timeout}s`;
                if (node.grpc_permit_without_stream !== undefined) outbound.transport.permit_without_stream = !!node.grpc_permit_without_stream;
            }

            if (node.type === 'vless' && node.flow) outbound.flow = node.flow;

            if (node.type === 'hysteria2') {
                outbound.password = node.password;
                const hysteria2Obfs = normalizeHysteria2Obfs(node.obfs);
                if (hysteria2Obfs) {
                    outbound.obfs = {
                        type: hysteria2Obfs,
                        password: node.obfs_password || ''
                    };
                }
                applyIfPresent(outbound, 'up_mbps', node.up_mbps);
                applyIfPresent(outbound, 'down_mbps', node.down_mbps);
                applyIfPresent(outbound, 'heartbeat', node.heartbeat);
                applyIfPresent(outbound, 'udp_over_stream', node.udp_over_stream);
                applyIfPresent(outbound, 'zero_rtt_handshake', node.zero_rtt_handshake);
                if (outbound.tls && (!Array.isArray(outbound.tls.alpn) || !outbound.tls.alpn.length)) outbound.tls.alpn = ['h3'];
                if (outbound.tls?.utls) delete outbound.tls.utls;
            }

            if (node.type === 'tuic') {
                outbound.uuid = node.uuid;
                outbound.password = node.password;
                outbound.congestion_control = node.congestion_control || 'bbr';
                outbound.udp_relay_mode = node.udp_relay_mode || 'quic-rfc';
                applyIfPresent(outbound, 'ip', node.ip);
                applyIfPresent(outbound, 'heartbeat', node.heartbeat);
                applyIfPresent(outbound, 'udp_over_stream', node.udp_over_stream);
                applyIfPresent(outbound, 'zero_rtt_handshake', node.zero_rtt_handshake);

                if (!outbound.tls) {
                    outbound.tls = {
                        enabled: true,
                        server_name: normalizeHost(node.sni) || serverHost,
                        insecure: !!node.insecure
                    };
                }
                const tuicAlpn = toList(node.alpn);
                outbound.tls.alpn = tuicAlpn.length ? tuicAlpn : ['h3'];
                if (outbound.tls.utls) delete outbound.tls.utls;
            }

            return outbound;
        });

        const routes = {
            rules: [
                {
                    ip_is_private: true,
                    outbound: 'direct'
                },
                ...this.nodes.map(node => ({
                    inbound: [`in-${node.id}`],
                    outbound: `out-${node.id}`
                }))
            ],
            auto_detect_interface: true,
            final: 'direct'
        };

        return {
            log: { level: 'info' },
            inbounds,
            outbounds: [...outbounds, { type: 'direct', tag: 'direct' }],
            route: routes
        };
    }

    resolveExecutablePath() {
        const projectRootParent = path.dirname(this.projectRoot);
        const possiblePaths = [
            path.join(this.projectRoot, 'bin', this.binPath),
            path.join(this.projectRoot, 'server/bin', this.binPath),
            path.join(projectRootParent, 'bin', this.binPath),
            '/usr/bin/' + this.binPath,
            '/usr/local/bin/' + this.binPath,
            this.binPath
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) return p;
        }
        return this.binPath;
    }

    async runSingBoxCheck(execPath, configPath) {
        await new Promise((resolve, reject) => {
            const stdoutChunks = [];
            const stderrChunks = [];
            let settled = false;
            const finish = (error = null) => {
                if (settled) return;
                settled = true;
                error ? reject(error) : resolve();
            };
            const processRef = spawn(execPath, ['check', '-c', configPath]);
            processRef.stdout.on('data', data => stdoutChunks.push(data.toString()));
            processRef.stderr.on('data', data => stderrChunks.push(data.toString()));
            processRef.once('error', finish);
            processRef.once('close', (code, signal) => {
                if (code === 0) return finish();
                const detail = stderrChunks.join('\n').trim() || stdoutChunks.join('\n').trim();
                finish(new Error(detail || `sing-box check failed: ${signal || code}`));
            });
        });
    }

    waitForPortReady(port, host = '127.0.0.1', timeoutMs = 15000, processRef = this.proxyProcess) {
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                if (processRef) {
                    processRef.off('error', onProcessError);
                    processRef.off('exit', onProcessExit);
                }
                callback(value);
            };
            const onProcessError = error => finish(reject, error);
            const onProcessExit = (code, signal) => finish(reject, new Error(`sing-box exited before listening on ${host}:${port} (${signal || code})`));
            if (processRef) {
                processRef.once('error', onProcessError);
                processRef.once('exit', onProcessExit);
            }
            const attempt = () => {
                if (settled) return;
                const socket = new net.Socket();
                socket.once('connect', () => {
                    socket.destroy();
                    finish(resolve);
                });
                socket.once('error', () => {
                    socket.destroy();
                    if (Date.now() - startedAt >= timeoutMs) {
                        finish(reject, new Error(`Timed out waiting for sing-box to listen on ${host}:${port}`));
                        return;
                    }
                    setTimeout(attempt, 200);
                });
                socket.connect(port, host);
            };
            attempt();
        });
    }

    async waitForRuntimeReady() {
        const ports = this.nodes.map(node => this.getLocalPort(node.id)).filter(Boolean);
        await Promise.all(ports.map(port => this.waitForPortReady(port)));
    }

    async start() {
        if (this.nodes.length === 0) {
            console.log('[ProxyService] No proxy nodes configured, skipping start.');
            return;
        }

        try {
            const config = this.generateConfig();
            const dataDir = path.dirname(this.configPath);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

            const maskedConfig = JSON.parse(JSON.stringify(config));
            maskedConfig.outbounds?.forEach(o => {
                if (o.password) o.password = '***';
                if (o.uuid) o.uuid = '***';
                if (o.tls?.reality?.public_key) o.tls.reality.public_key = '***';
            });
            console.log('[ProxyService] Generated config:', JSON.stringify(maskedConfig, null, 2));

            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));

            const execPath = this.resolveExecutablePath();
            console.log(`[ProxyService] Final sing-box executable path: ${execPath}`);
            await this.runSingBoxCheck(execPath, this.configPath);
            this.stop();
            console.log('[ProxyService] sing-box config check passed.');
            console.log(`[ProxyService] Starting sing-box with ${this.nodes.length} nodes...`);

            this.proxyProcess = spawn(execPath, ['run', '-c', this.configPath]);

            this.proxyProcess.stdout.on('data', (data) => {
                const msg = data.toString();
                console.log(`[Proxy Log] ${msg.trim()}`);
            });

            this.proxyProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                console.error(`[Proxy STDOUT/ERR] ${msg.trim()}`);
            });

            this.proxyProcess.on('error', (err) => {
                console.error(`[ProxyService] Failed to start sing-box process:`, err.message);
            });

            this.proxyProcess.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    console.error(`[ProxyService] sing-box exited with code ${code}`);
                }
            });

            await this.waitForRuntimeReady();
            console.log('[ProxyService] sing-box runtime is ready.');
        } catch (err) {
            console.error('[ProxyService] Failed to start:', err.message);
            this.stop();
            throw err;
        }
    }

    stop() {
        if (this.proxyProcess) {
            this.proxyProcess.kill();
            this.proxyProcess = null;
        }
    }

    async restart(nodes) {
        this.setNodes(nodes);
        await this.start();
    }

    // Parse proxy links (vless, vmess, ss, trojan, tuic, hysteria2)
    parseProxyLink(link) {
        try {
            const value = normalizeImportedProxyLink(link);
            if (value.startsWith('{') && value.endsWith('}')) return null;

            if (value.startsWith('vmess://')) {
                const b64 = value.replace('vmess://', '');
                const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
                return {
                    id: Math.random().toString(36).substring(2, 9),
                    name: json.ps || 'VMess',
                    type: 'vmess',
                    server: normalizeHost(json.add),
                    port: parseInt(json.port, 10),
                    uuid: json.id,
                    security: normalizeVmessSecurity(json.scy || json.security || 'auto', 'auto'),
                    alterId: parseInt(json.aid || 0, 10),
                    transport: json.net === 'ws' ? 'ws' : (json.net === 'grpc' ? 'grpc' : 'tcp'),
                    wsPath: json.path || '',
                    wsHost: json.host || '',
                    tls: json.tls === 'tls',
                    sni: normalizeHost(json.sni || json.host || ''),
                    serviceName: json.net === 'grpc' ? (json.path || '') : '',
                    alpn: json.alpn || '',
                    fp: json.fp || '',
                    packet_encoding: json.packetEncoding || json.packet_encoding || ''
                };
            }

            const url = new URL(value);
            const protocol = url.protocol.slice(0, -1).toLowerCase();
            const nodeId = Math.random().toString(36).substring(2, 9);
            const name = decodeURIComponent(url.hash.slice(1)) || `${protocol}_${nodeId}`;
            const params = new URLSearchParams(url.search);
            const securityParam = String(params.get('security') || '').trim().toLowerCase();
            const vmessCipherParam = String(params.get('scy') || params.get('cipher') || params.get('encryption') || '').trim().toLowerCase();
            const tlsParam = String(params.get('tls') || '').trim().toLowerCase();
            const wantsTls = ['tls', '1', 'true'].includes(tlsParam) || VMESS_TLS_SECURITY_MODES.has(securityParam);

            const config = {
                id: nodeId,
                name,
                type: protocol,
                server: normalizeHost(url.hostname),
                port: parseInt(url.port, 10)
            };

            if (Number.isNaN(config.port)) config.port = wantsTls ? 443 : 80;
            if (params.get('sni')) config.sni = normalizeHost(params.get('sni'));
            if (protocol === 'vmess') {
                if (vmessCipherParam) config.security = normalizeVmessSecurity(vmessCipherParam, 'auto');
                if (securityParam) {
                    if (VMESS_TLS_SECURITY_MODES.has(securityParam)) config.tls = true;
                    else if (!config.security) config.security = normalizeVmessSecurity(securityParam, 'auto');
                }
            } else if (securityParam) {
                config.security = securityParam;
            }
            if (['tls', '1', 'true'].includes(tlsParam)) config.tls = true;
            if (params.get('alpn')) config.alpn = params.get('alpn');
            if (params.get('type') === 'grpc' && !params.get('serviceName') && params.get('path')) config.serviceName = params.get('path');
            if (params.get('path')) config.wsPath = params.get('path');
            config.wsHost = params.get('host') || params.get('wsHost') || '';
            normalizeWsHeaders(config, config.wsHost);
            config.transport = params.get('type') || params.get('transport') || params.get('net') || 'tcp';

            if (params.get('serviceName')) config.serviceName = params.get('serviceName');
            if (params.get('service_name')) config.serviceName = params.get('service_name');
            if (params.get('fp')) config.fp = params.get('fp');
            if (params.get('pbk')) config.pbk = params.get('pbk');
            if (params.get('sid')) config.sid = params.get('sid');
            if (params.get('short_id') && !config.sid) config.sid = params.get('short_id');
            if (params.get('spx')) config.spx = params.get('spx');
            if (params.get('flow')) config.flow = params.get('flow');
            if (params.get('packet_encoding')) config.packet_encoding = params.get('packet_encoding');
            if (params.get('ed')) config.max_early_data = params.get('ed');
            if (params.get('max_early_data')) config.max_early_data = params.get('max_early_data');
            if (params.get('eh')) config.early_data_header_name = params.get('eh');
            if (params.get('early_data_header_name')) config.early_data_header_name = params.get('early_data_header_name');
            if (params.get('network')) config.network = params.get('network');
            if (params.get('plugin')) Object.assign(config, parsePluginString(params.get('plugin')));
            if (params.get('plugin-opts') && !config.plugin_opts) config.plugin_opts = params.get('plugin-opts');
            if (params.get('plugin_opts') && !config.plugin_opts) config.plugin_opts = params.get('plugin_opts');
            if (params.get('ip')) config.ip = normalizeHost(params.get('ip'));
            if (params.get('upmbps')) config.up_mbps = toInt(params.get('upmbps'));
            if (params.get('up')) config.up_mbps = toInt(params.get('up'), config.up_mbps);
            if (params.get('downmbps')) config.down_mbps = toInt(params.get('downmbps'));
            if (params.get('down')) config.down_mbps = toInt(params.get('down'), config.down_mbps);
            if (params.get('congestion_control')) config.congestion_control = params.get('congestion_control');
            if (params.get('udp_relay_mode')) config.udp_relay_mode = params.get('udp_relay_mode');
            if (params.get('heartbeat')) config.heartbeat = params.get('heartbeat');
            if (params.get('udp_over_stream')) config.udp_over_stream = toBool(params.get('udp_over_stream'));
            if (params.get('zero_rtt_handshake')) config.zero_rtt_handshake = toBool(params.get('zero_rtt_handshake'));
            if (params.get('tls_min_version')) config.tls_min_version = params.get('tls_min_version');
            if (params.get('tls_max_version')) config.tls_max_version = params.get('tls_max_version');
            if (params.get('tls_cipher_suites')) config.tls_cipher_suites = params.get('tls_cipher_suites');
            if (params.get('certificate_public_key_sha256')) config.certificate_public_key_sha256 = params.get('certificate_public_key_sha256');
            if (params.get('reality_next_protocol')) config.reality_next_protocol = params.get('reality_next_protocol');
            if (params.get('idle_timeout')) config.grpc_idle_timeout = toInt(params.get('idle_timeout'));
            if (params.get('ping_timeout')) config.grpc_ping_timeout = toInt(params.get('ping_timeout'));
            if (params.get('permit_without_stream')) config.grpc_permit_without_stream = toBool(params.get('permit_without_stream'));
            if (toBool(params.get('record_fragment'))) config.record_fragment = true;
            if (toBool(params.get('insecure')) || toBool(params.get('allowInsecure')) || toBool(params.get('allow_insecure'))) config.insecure = true;

            const rawUser = decodeURIComponent(url.username || '');
            const rawPass = decodeURIComponent(url.password || '');

            if (protocol === 'tuic') {
                if (rawUser.includes(':')) {
                    const [uuid, password] = rawUser.split(':', 2);
                    config.uuid = uuid;
                    config.password = password;
                } else {
                    config.uuid = rawUser;
                    config.password = rawPass;
                }
                config.tls = true;
                config.security = config.security || 'tls';
                config.sni = config.sni || config.server;
                config.alpn = config.alpn || 'h3';
                if (!url.port) config.port = 443;
            } else if (protocol === 'hysteria2' || protocol === 'hy2') {
                config.type = 'hysteria2';
                config.password = rawUser && rawPass ? `${rawUser}:${rawPass}` : (rawUser || rawPass);
                const hysteria2Obfs = normalizeHysteria2Obfs(params.get('obfs'));
                if (hysteria2Obfs) config.obfs = hysteria2Obfs;
                if (hysteria2Obfs && (params.get('obfs-password') || params.get('obfs_password'))) {
                    config.obfs_password = params.get('obfs-password') || params.get('obfs_password');
                }
                config.tls = true;
                config.security = config.security || 'tls';
                config.sni = config.sni || config.server;
                config.alpn = config.alpn || 'h3';
                if (!url.port) config.port = 443;
            } else if (protocol === 'vmess') {
                config.uuid = rawUser || rawPass || params.get('uuid') || params.get('id');
            } else if (protocol === 'vless') {
                config.uuid = rawUser || rawPass;
            } else if (protocol === 'trojan') {
                config.password = rawUser;
                const tlsExplicitlyDisabled = securityParam === 'none' || ['0', 'false', 'none'].includes(tlsParam);
                if (!tlsExplicitlyDisabled) {
                    config.tls = true;
                    config.security = config.security || 'tls';
                    config.sni = config.sni || config.server;
                }
                if (!url.port) config.port = 443;
            } else if (protocol === 'ss' || protocol === 'shadowsocks') {
                config.type = 'shadowsocks';
                if (rawUser && !rawPass && !rawUser.includes(':')) {
                    try {
                        const decoded = Buffer.from(rawUser, 'base64').toString('utf-8');
                        if (decoded.includes(':')) {
                            const [method, password] = decoded.split(':', 2);
                            config.method = method;
                            config.password = password;
                        } else {
                            config.method = rawUser;
                        }
                    } catch {
                        config.method = rawUser;
                    }
                } else {
                    config.method = rawUser;
                    config.password = rawPass;
                }
            } else if (['socks5', 'socks', 'http'].includes(protocol)) {
                config.type = protocol === 'http' ? 'http' : 'socks';
                config.username = rawUser;
                config.password = rawPass;
            } else {
                console.warn('[ProxyService] Unknown protocol:', protocol);
                return null;
            }

            return config;
        } catch (e) {
            console.error('[ProxyService] Link parse error:', e.message);
            return null;
        }
    }

    normalizeSubscriptionContent(content) {
        const text = typeof content === 'string'
            ? content
            : Buffer.isBuffer(content)
                ? content.toString('utf8')
                : JSON.stringify(content);
        return looksLikeBase64Payload(text) ? decodeBase64Payload(text) : text;
    }

    extractConfigNodes(payload) {
        if (!payload || typeof payload !== 'object') return [];
        if (Array.isArray(payload)) return payload.filter(item => item && typeof item === 'object');
        const candidates = [];
        if (Array.isArray(payload.outbounds)) candidates.push(...payload.outbounds);
        if (Array.isArray(payload.proxies)) candidates.push(...payload.proxies);
        return candidates.filter(item => item && typeof item === 'object');
    }

    normalizeConfigNode(node, index = 0) {
        const type = String(node.type || '').toLowerCase();
        if (!type || ['direct', 'block', 'dns', 'selector', 'urltest'].includes(type)) return null;
        const normalized = {
            id: node.id || Math.random().toString(36).substring(2, 9),
            name: node.name || node.tag || `${type}-${index + 1}`,
            type,
            server: normalizeHost(node.server),
            port: toInt(node.port ?? node.server_port)
        };
        if (!normalized.server || !normalized.port) return null;

        const fieldMap = {
            uuid: node.uuid,
            password: node.password,
            username: node.username,
            method: node.method,
            security: node.security,
            flow: node.flow,
            network: node.network,
            transport: node.transport?.type || node.transport,
            plugin: node.plugin,
            plugin_opts: node.plugin_opts,
            obfs: node.obfs?.type || node.obfs,
            obfs_password: node.obfs?.password || node.obfs_password,
            up_mbps: node.up_mbps,
            down_mbps: node.down_mbps,
            congestion_control: node.congestion_control,
            udp_relay_mode: node.udp_relay_mode,
            heartbeat: node.heartbeat,
            udp_over_stream: node.udp_over_stream,
            zero_rtt_handshake: node.zero_rtt_handshake,
            packet_encoding: node.packet_encoding,
            serviceName: node.transport?.service_name || node.serviceName || node.service_name,
            wsPath: node.transport?.path || node.path,
            wsHost: node.transport?.headers?.Host || node.transport?.headers?.host || node.wsHost || node.host,
            headers: node.transport?.headers || node.headers,
            max_early_data: node.transport?.max_early_data,
            early_data_header_name: node.transport?.early_data_header_name,
            fp: node.tls?.utls?.fingerprint || node.fp,
            pbk: node.tls?.reality?.public_key || node.pbk,
            sid: node.tls?.reality?.short_id || node.sid,
            spx: node.tls?.reality?.spider_x || node.spx,
            reality_next_protocol: Array.isArray(node.tls?.reality?.next_protocol) ? node.tls.reality.next_protocol.join(',') : node.tls?.reality?.next_protocol,
            tls_min_version: node.tls?.min_version,
            tls_max_version: node.tls?.max_version,
            tls_cipher_suites: Array.isArray(node.tls?.cipher_suites) ? node.tls.cipher_suites.join(',') : node.tls?.cipher_suites,
            certificate_public_key_sha256: Array.isArray(node.tls?.certificate_public_key_sha256)
                ? node.tls.certificate_public_key_sha256.join(',')
                : node.tls?.certificate_public_key_sha256,
            alpn: Array.isArray(node.tls?.alpn) ? node.tls.alpn.join(',') : node.tls?.alpn,
            insecure: node.tls?.insecure ?? node.insecure,
            tls: node.tls?.enabled ?? node.tls,
            sni: node.tls?.server_name || node.sni,
            alterId: node.alter_id ?? node.alterId
        };
        Object.entries(fieldMap).forEach(([key, value]) => applyIfPresent(normalized, key, value));
        normalized.server = normalizeHost(normalized.server);
        normalized.sni = normalizeHost(normalized.sni);
        normalized.ip = normalizeHost(normalized.ip);
        if (normalized.transport === 'ws') normalizeWsHeaders(normalized, normalized.wsHost);

        if (normalized.type === 'vless' && nodeUsesReality({ ...node, ...normalized })) {
            normalized.tls = true;
            normalized.security = 'reality';
        }
        if (normalized.type === 'vmess' && VMESS_TLS_SECURITY_MODES.has(String(normalized.security || '').trim().toLowerCase())) {
            normalized.tls = true;
            normalized.security = 'none';
        }
        if (normalized.type === 'hysteria2') {
            normalized.obfs = normalizeHysteria2Obfs(normalized.obfs);
            if (!normalized.obfs) {
                delete normalized.obfs;
                delete normalized.obfs_password;
            }
            normalized.tls = true;
            normalized.security = normalized.security || 'tls';
            normalized.sni = normalized.sni || normalized.server;
            normalized.alpn = normalized.alpn || 'h3';
        }
        if (normalized.type === 'tuic') {
            normalized.tls = true;
            normalized.security = normalized.security || 'tls';
            normalized.sni = normalized.sni || normalized.server;
            normalized.alpn = normalized.alpn || 'h3';
        }
        if (normalized.type === 'trojan' && normalized.security !== 'none') {
            normalized.tls = true;
            normalized.security = normalized.security || 'tls';
            normalized.sni = normalized.sni || normalized.server;
        }
        return normalized;
    }

    parseStructuredSubscription(content) {
        const trimmed = String(content || '').trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const payload = JSON.parse(trimmed);
                return this.extractConfigNodes(payload)
                    .map((node, index) => this.normalizeConfigNode(node, index))
                    .filter(Boolean);
            } catch (error) {
                console.warn(`[ProxyService] Failed to parse structured subscription JSON: ${error.message}`);
            }
        }
        if (/^\s*(mixed-port|port|proxies):/m.test(trimmed)) {
            console.warn('[ProxyService] Clash-style YAML subscriptions are not supported yet');
        }
        return [];
    }

    parseProxyLinks(input) {
        return String(input || '')
            .split(/\r?\n|\s+(?=(?:vmess|vless|trojan|ss|shadowsocks|socks|socks5|http|https|tuic|hy2|hysteria2):\/\/)/i)
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => this.parseProxyLink(item))
            .filter(Boolean);
    }

    async syncSubscription(url) {
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error(`Invalid subscription URL: ${url}`);
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Subscription URL must use http or https');
        }
        if (isPrivateSubscriptionHost(parsedUrl.hostname)) {
            throw new Error('Subscription URL must not point to a private/local address');
        }

        const authHeader = (parsedUrl.username || parsedUrl.password)
            ? `Basic ${Buffer.from(parsedUrl.username ? `${parsedUrl.username}:${parsedUrl.password}` : `:${parsedUrl.password}`).toString('base64')}`
            : '';
        let response;
        let lastError;
        for (const userAgent of SUBSCRIPTION_USER_AGENTS) {
            try {
                response = await axios.get(url, {
                    responseType: 'text',
                    timeout: SUBSCRIPTION_TIMEOUT_MS,
                    transformResponse: [data => data],
                    headers: {
                        'User-Agent': userAgent,
                        Accept: userAgent.startsWith('Mozilla')
                            ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                            : 'text/plain, application/json;q=0.9, */*;q=0.8',
                        ...(authHeader ? { Authorization: authHeader } : {})
                    }
                });
                break;
            } catch (error) {
                lastError = error;
                if (error.response?.status !== 403) break;
            }
        }
        if (!response) {
            const status = lastError?.response?.status;
            const detail = status ? `HTTP ${status}` : lastError?.message || 'Unknown error';
            console.error('[ProxyService] Subscription sync error:', detail);
            throw new Error(`Failed to download subscription: ${detail}`);
        }

        const content = this.normalizeSubscriptionContent(response.data);
        const structuredNodes = this.parseStructuredSubscription(content);
        if (structuredNodes.length) return structuredNodes;
        return this.parseProxyLinks(content);
    }

    // Test connectivity and latency
    async testNode(nodeId) {
        const localPort = this.getLocalPort(nodeId);
        if (!localPort) throw new Error('Node not active in bridge');

        const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${localPort}`, {
            keepAlive: true,
            timeout: SPEEDTEST_TIMEOUT_MS
        });
        const startTime = Date.now();
        try {
            const response = await axios.get(DEFAULT_SPEEDTEST_URL, {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: SPEEDTEST_TIMEOUT_MS,
                proxy: false,
                validateStatus: () => true
            });
            const latency = Date.now() - startTime;
            console.log(`[ProxyService] Test succeeded for ${nodeId} on port ${localPort}: HTTP ${response.status || 0}, ${latency}ms`);
            return latency;
        } catch (e) {
            const reason = e.response ? `HTTP ${e.response.status}` : e.message;
            console.error(`[ProxyService] Test failed for ${nodeId} on port ${localPort}:`, reason);
            throw new Error(reason);
        }
    }
}

export const proxyService = new ProxyService();

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANTIGRAVITY_CLIENT_SECRET = exports.ANTIGRAVITY_CLIENT_ID = void 0;
exports.requestGoogleApi = requestGoogleApi;
exports.exchangeRefreshToken = exchangeRefreshToken;
exports.resolveTokenInfo = resolveTokenInfo;
exports.loginWithGoogleBrowser = loginWithGoogleBrowser;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const vscode = __importStar(require("vscode"));
function decodeStr(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
}
exports.ANTIGRAVITY_CLIENT_ID = decodeStr('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==');
exports.ANTIGRAVITY_CLIENT_SECRET = decodeStr('R09DU1BYLUs1OEZXUjQ4NkxkTExKMW1MQjhzWEM0ejZxREFm');
function requestGoogleApi(urlStr, postData) {
    return new Promise((resolve, reject) => {
        const url = new url_1.URL(urlStr);
        const proxyHost = process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:7897';
        let proxyPort = 7897;
        let proxyHostname = '127.0.0.1';
        try {
            const pUrl = new url_1.URL(proxyHost.startsWith('http') ? proxyHost : `http://${proxyHost}`);
            proxyHostname = pUrl.hostname;
            proxyPort = parseInt(pUrl.port, 10) || 7897;
        }
        catch { }
        const tryDirect = () => {
            const req = https.request(urlStr, {
                method: postData ? 'POST' : 'GET',
                headers: postData
                    ? {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(postData),
                    }
                    : {},
            }, (res) => {
                let body = '';
                res.on('data', (d) => (body += d));
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode || 200, data: JSON.parse(body) });
                    }
                    catch {
                        resolve({ status: res.statusCode || 200, data: body });
                    }
                });
            });
            req.on('error', reject);
            if (postData)
                req.write(postData);
            req.end();
        };
        // First attempt CONNECT tunnel through proxy
        const proxyReq = http.request({
            host: proxyHostname,
            port: proxyPort,
            method: 'CONNECT',
            path: `${url.host}:443`,
            timeout: 5000,
        });
        proxyReq.on('connect', (res, socket) => {
            const tlsReq = https.request({
                host: url.hostname,
                port: 443,
                path: url.pathname + url.search,
                method: postData ? 'POST' : 'GET',
                headers: {
                    Host: url.hostname,
                    ...(postData
                        ? {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(postData),
                        }
                        : {}),
                },
                socket: socket,
                agent: false,
            }, (tlsRes) => {
                let body = '';
                tlsRes.on('data', (d) => (body += d));
                tlsRes.on('end', () => {
                    try {
                        resolve({ status: tlsRes.statusCode || 200, data: JSON.parse(body) });
                    }
                    catch {
                        resolve({ status: tlsRes.statusCode || 200, data: body });
                    }
                });
            });
            tlsReq.on('error', () => {
                tryDirect();
            });
            if (postData)
                tlsReq.write(postData);
            tlsReq.end();
        });
        proxyReq.on('error', () => {
            tryDirect();
        });
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            tryDirect();
        });
        proxyReq.end();
    });
}
async function exchangeRefreshToken(refreshToken) {
    const params = new url_1.URLSearchParams({
        client_id: exports.ANTIGRAVITY_CLIENT_ID,
        client_secret: exports.ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: refreshToken.trim(),
        grant_type: 'refresh_token',
    }).toString();
    const tokenRes = await requestGoogleApi('https://oauth2.googleapis.com/token', params);
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
        throw new Error(`Google 校验 Refresh Token 失败: ${tokenRes.data?.error_description || JSON.stringify(tokenRes.data)}`);
    }
    const accToken = tokenRes.data.access_token;
    const idToken = tokenRes.data.id_token || '';
    let email = '';
    let name = '';
    if (idToken) {
        try {
            const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
            email = payload.email || '';
            name = payload.name || '';
        }
        catch { }
    }
    if (!email && accToken) {
        try {
            const infoRes = await requestGoogleApi(`https://oauth2.googleapis.com/tokeninfo?access_token=${accToken}`);
            email = infoRes.data.email || '';
        }
        catch { }
    }
    return {
        email: email || '',
        accessToken: accToken,
        idToken,
        name,
    };
}
/**
 * Parses user input which can be:
 * 1. A JSON object with token/refresh_token
 * 2. A raw refresh_token string (1//...)
 * 3. An access_token string (ya29...)
 */
async function resolveTokenInfo(rawInput) {
    const trimmed = rawInput.trim();
    // 1. JSON object format
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            const tokenObj = parsed.token || parsed;
            const refreshToken = tokenObj.refresh_token || parsed.refresh_token || '';
            const accessToken = tokenObj.access_token || parsed.access_token || '';
            const idToken = tokenObj.id_token || parsed.id_token || '';
            let email = parsed.email || tokenObj.email || '';
            let name = parsed.name || tokenObj.name || '';
            if (!email && idToken) {
                try {
                    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
                    email = payload.email || '';
                    name = payload.name || name;
                }
                catch { }
            }
            if (refreshToken) {
                if (!email) {
                    try {
                        const resolved = await exchangeRefreshToken(refreshToken);
                        email = resolved.email || email;
                        name = resolved.name || name;
                    }
                    catch { }
                }
                return {
                    email: email || '',
                    refreshToken,
                    accessToken,
                    idToken,
                    name: name || (email ? email.split('@')[0] : 'User'),
                };
            }
        }
        catch {
            // not valid json, proceed to token string
        }
    }
    // 2. Direct Refresh Token (starts with 1// or 40+ chars)
    if (trimmed.startsWith('1//') || trimmed.length >= 40) {
        try {
            const resolved = await exchangeRefreshToken(trimmed);
            return {
                email: resolved.email,
                refreshToken: trimmed,
                accessToken: resolved.accessToken,
                idToken: resolved.idToken,
                name: resolved.name || (resolved.email ? resolved.email.split('@')[0] : 'User'),
            };
        }
        catch (e) {
            console.warn('Google online resolution warning:', e);
            return {
                email: '',
                refreshToken: trimmed,
            };
        }
    }
    throw new Error('无法识别的 Token 格式。请提供有效的 Refresh Token (以 1// 开头) 或包含凭据的 JSON。');
}
/**
 * Launch system browser and authenticate with Google OAuth loopback flow
 */
function loginWithGoogleBrowser() {
    return new Promise((resolve, reject) => {
        let resolved = false;
        let server;
        server = http.createServer(async (req, res) => {
            try {
                const address = server.address();
                const currentPort = address ? address.port : 0;
                const reqUrl = new url_1.URL(req.url || '/', `http://127.0.0.1:${currentPort}`);
                if (reqUrl.pathname === '/oauth-callback') {
                    const code = reqUrl.searchParams.get('code');
                    const error = reqUrl.searchParams.get('error');
                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`<!DOCTYPE html><html><body style="background:#0b1120;color:#f87171;font-family:sans-serif;text-align:center;padding:50px;"><h2>授权失败</h2><p>${error}</p></body></html>`);
                        if (!resolved) {
                            resolved = true;
                            server.close();
                            reject(new Error(`Google 授权拒绝: ${error}`));
                        }
                        return;
                    }
                    if (code) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AntiGravity 授权成功</title>
  <style>
    body { background: #0b1120; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #121929; border: 1px solid #1d283f; padding: 48px; border-radius: 16px; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.5); max-width: 450px; }
    h1 { color: #10b981; font-size: 24px; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 15px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 48px; margin-bottom: 16px;">🚀</div>
    <h1>Google 账号授权成功！</h1>
    <p>凭据已成功同步至 AntiGravity 账号池。<br>您可以关闭此浏览器窗口并返回 VS Code 开始编码。</p>
  </div>
</body>
</html>`);
                        if (!resolved) {
                            resolved = true;
                            server.close();
                            try {
                                const redirectUri = `http://127.0.0.1:${currentPort}/oauth-callback`;
                                const params = new url_1.URLSearchParams({
                                    client_id: exports.ANTIGRAVITY_CLIENT_ID,
                                    client_secret: exports.ANTIGRAVITY_CLIENT_SECRET,
                                    code,
                                    grant_type: 'authorization_code',
                                    redirect_uri: redirectUri,
                                }).toString();
                                const tokenRes = await requestGoogleApi('https://oauth2.googleapis.com/token', params);
                                if (tokenRes.status !== 200 || !tokenRes.data.refresh_token) {
                                    reject(new Error(`换取 Token 失败: ${JSON.stringify(tokenRes.data)}`));
                                    return;
                                }
                                const rfToken = tokenRes.data.refresh_token;
                                const accToken = tokenRes.data.access_token || '';
                                const idToken = tokenRes.data.id_token || '';
                                let email = '';
                                let name = '';
                                if (idToken) {
                                    try {
                                        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
                                        email = payload.email || '';
                                        name = payload.name || '';
                                    }
                                    catch { }
                                }
                                if (!email && accToken) {
                                    try {
                                        const infoRes = await requestGoogleApi(`https://oauth2.googleapis.com/tokeninfo?access_token=${accToken}`);
                                        email = infoRes.data.email || '';
                                    }
                                    catch { }
                                }
                                resolve({
                                    email: email || 'google-user@gmail.com',
                                    refreshToken: rfToken,
                                    accessToken: accToken,
                                    idToken,
                                    name: name || (email ? email.split('@')[0] : 'User'),
                                });
                            }
                            catch (e) {
                                reject(e);
                            }
                        }
                    }
                }
            }
            catch (err) {
                if (!resolved) {
                    resolved = true;
                    server.close();
                    reject(err);
                }
            }
        });
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address.port;
            const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                new url_1.URLSearchParams({
                    client_id: exports.ANTIGRAVITY_CLIENT_ID,
                    response_type: 'code',
                    access_type: 'offline',
                    prompt: 'consent',
                    redirect_uri: redirectUri,
                    scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
                }).toString();
            vscode.env.openExternal(vscode.Uri.parse(authUrl));
        });
        // 2 minutes timeout
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try {
                    server.close();
                }
                catch { }
                reject(new Error('等待浏览器 Google 登录授权超时 (2分钟)'));
            }
        }, 120000);
    });
}
//# sourceMappingURL=oauth.js.map
import * as http from 'http';
import * as https from 'https';
import { URL, URLSearchParams } from 'url';
import * as vscode from 'vscode';
import { getProxyUrl } from './utils';

function decodeStr(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

export const ANTIGRAVITY_CLIENT_ID = decodeStr(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='
);
export const ANTIGRAVITY_CLIENT_SECRET = decodeStr(
  'R09DU1BYLUs1OEZXUjQ4NkxkTExKMW1MQjhzWEM0ejZxREFm'
);

export interface OAuthAccountResult {
  email: string;
  refreshToken: string;
  accessToken?: string;
  idToken?: string;
  name?: string;
}

export function requestGoogleApi(
  urlStr: string,
  postData?: string
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);

    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const ok = (status: number | undefined, body: string) =>
      settle(() => {
        let data: any = body;
        try {
          data = JSON.parse(body);
        } catch {}
        resolve({ status: status || 200, data });
      });
    const fail = (err: Error) => settle(() => reject(err));

    const doDirect = () => {
      const req = https.request(
        urlStr,
        {
          method: postData ? 'POST' : 'GET',
          headers: postData
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
              }
            : {},
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => ok(res.statusCode, body));
        }
      );
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('请求 Google 超时 (直连)')));
      if (postData) req.write(postData);
      req.end();
    };

    // 代理地址来自用户配置或环境变量；不再硬编码 127.0.0.1:7897，
    // 否则未开代理的用户每个请求都要先等一次 CONNECT 失败。
    const proxyUrl = getProxyUrl();
    if (!proxyUrl) {
      doDirect();
      return;
    }

    let proxyHostname = '127.0.0.1';
    let proxyPort = 8080;
    try {
      const pUrl = new URL(proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`);
      proxyHostname = pUrl.hostname;
      proxyPort = parseInt(pUrl.port, 10) || 8080;
    } catch {
      doDirect();
      return;
    }

    const proxyReq = http.request({
      host: proxyHostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${url.host}:443`,
      timeout: 5000,
    });

    proxyReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        proxyReq.destroy();
        doDirect();
        return;
      }
      const tlsReq = https.request(
        {
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
          timeout: 15000,
        } as any,
        (tlsRes) => {
          let body = '';
          tlsRes.on('data', (d) => (body += d));
          tlsRes.on('end', () => ok(tlsRes.statusCode, body));
        }
      );
      tlsReq.on('error', () => {
        try {
          socket.destroy();
        } catch {}
        doDirect();
      });
      tlsReq.on('timeout', () => tlsReq.destroy(new Error('请求 Google 超时 (代理)')));
      if (postData) tlsReq.write(postData);
      tlsReq.end();
    });

    proxyReq.on('error', () => {
      doDirect();
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      doDirect();
    });

    proxyReq.end();
  });
}

export async function exchangeRefreshToken(
  refreshToken: string
): Promise<{ email: string; accessToken: string; idToken?: string; name?: string }> {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: refreshToken.trim(),
    grant_type: 'refresh_token',
  }).toString();

  const tokenRes = await requestGoogleApi('https://oauth2.googleapis.com/token', params);
  if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
    throw new Error(
      `Google 校验 Refresh Token 失败: ${tokenRes.data?.error_description || JSON.stringify(tokenRes.data)}`
    );
  }

  const accToken = tokenRes.data.access_token;
  const idToken = tokenRes.data.id_token || '';

  let email = '';
  let name = '';

  if (idToken) {
    try {
      const payload = JSON.parse(
        Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')
      );
      email = payload.email || '';
      name = payload.name || '';
    } catch {}
  }

  if (!email && accToken) {
    try {
      const infoRes = await requestGoogleApi(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${accToken}`
      );
      email = infoRes.data.email || '';
    } catch {}
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
export async function resolveTokenInfo(rawInput: string): Promise<OAuthAccountResult> {
  const trimmed = rawInput.trim();

  // 1. JSON object format
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 不是合法 JSON，按裸 Token 字符串继续处理
    }
    if (parsed && typeof parsed === 'object') {
      const tokenObj = parsed.token || parsed;
      const refreshToken = tokenObj.refresh_token || parsed.refresh_token || '';
      const accessToken = tokenObj.access_token || parsed.access_token || '';
      const idToken = tokenObj.id_token || parsed.id_token || '';
      let email = parsed.email || tokenObj.email || '';
      let name = parsed.name || tokenObj.name || '';

      if (!email && idToken) {
        try {
          const payload = JSON.parse(
            Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')
          );
          email = payload.email || '';
          name = payload.name || name;
        } catch {}
      }

      if (refreshToken) {
        if (!email) {
          try {
            const resolved = await exchangeRefreshToken(refreshToken);
            email = resolved.email || email;
            name = resolved.name || name;
          } catch {}
        }
        return {
          email: email || '',
          refreshToken,
          accessToken,
          idToken,
          name: name || (email ? email.split('@')[0] : 'User'),
        };
      }

      // 合法 JSON 但缺 refresh_token：直接报错，
      // 不能把整段 JSON 当成裸 Token 拿去 Google 换取并写入账号池
      throw new Error(
        accessToken
          ? 'JSON 凭据中只有 access_token（1 小时就过期），缺少 refresh_token，无法导入。'
          : 'JSON 凭据中未找到 refresh_token 字段。'
      );
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
    } catch (e: any) {
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
function respondPage(
  res: http.ServerResponse,
  status: number,
  icon: string,
  title: string,
  message: string
): void {
  try {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AntiGravity 授权</title>
  <style>
    body { background: #0b1120; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #121929; border: 1px solid #1d283f; padding: 48px; border-radius: 16px; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.5); max-width: 450px; }
    h1 { color: #10b981; font-size: 24px; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 15px; line-height: 1.6; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 48px; margin-bottom: 16px;">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`);
  } catch {}
}

export function loginWithGoogleBrowser(): Promise<OAuthAccountResult> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let server: http.Server;

    server = http.createServer(async (req, res) => {
      try {
        const address = server.address() as any;
        const currentPort = address ? address.port : 0;
        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${currentPort}`);

        if (reqUrl.pathname === '/oauth-callback') {
          const code = reqUrl.searchParams.get('code');
          const error = reqUrl.searchParams.get('error');

          if (error) {
            respondPage(res, 400, '❌', '授权失败', error);
            if (!resolved) {
              resolved = true;
              server.close();
              reject(new Error(`Google 授权拒绝: ${error}`));
            }
            return;
          }

          if (code && !resolved) {
            resolved = true;
            try {
              server.close();
            } catch {}

            // 先完成 Token 交换，再回复浏览器——避免交换失败时页面却显示"授权成功"
            try {
              const redirectUri = `http://127.0.0.1:${currentPort}/oauth-callback`;
              const params = new URLSearchParams({
                client_id: ANTIGRAVITY_CLIENT_ID,
                client_secret: ANTIGRAVITY_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
              }).toString();

              const tokenRes = await requestGoogleApi(
                'https://oauth2.googleapis.com/token',
                params
              );
              if (tokenRes.status !== 200 || !tokenRes.data.refresh_token) {
                const errMsg = `换取 Token 失败: ${JSON.stringify(tokenRes.data).slice(0, 300)}`;
                respondPage(res, 200, '❌', '授权失败', errMsg);
                reject(new Error(errMsg));
                return;
              }

              const rfToken = tokenRes.data.refresh_token;
              const accToken = tokenRes.data.access_token || '';
              const idToken = tokenRes.data.id_token || '';

              let email = '';
              let name = '';

              if (idToken) {
                try {
                  const payload = JSON.parse(
                    Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')
                  );
                  email = payload.email || '';
                  name = payload.name || '';
                } catch {}
              }

              if (!email && accToken) {
                try {
                  const infoRes = await requestGoogleApi(
                    `https://oauth2.googleapis.com/tokeninfo?access_token=${accToken}`
                  );
                  email = infoRes.data.email || '';
                } catch {}
              }

              respondPage(
                res,
                200,
                '🚀',
                'Google 账号授权成功！',
                '凭据已成功同步至 AntiGravity 账号池。<br>您可以关闭此浏览器窗口并返回 VS Code 开始编码。'
              );
              resolve({
                email: email || 'google-user@gmail.com',
                refreshToken: rfToken,
                accessToken: accToken,
                idToken,
                name: name || (email ? email.split('@')[0] : 'User'),
              });
            } catch (e: any) {
              respondPage(res, 500, '❌', '授权失败', e?.message || String(e));
              reject(e);
            }
            return;
          }
        }

        // 其他路径（如 /favicon.ico）直接 404，避免连接悬挂
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      } catch (err: any) {
        if (!resolved) {
          resolved = true;
          try {
            server.close();
          } catch {}
          reject(err);
        }
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as any;
      const port = address.port;
      const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;

      const authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        new URLSearchParams({
          client_id: ANTIGRAVITY_CLIENT_ID,
          response_type: 'code',
          access_type: 'offline',
          prompt: 'consent',
          redirect_uri: redirectUri,
          scope:
            'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
        }).toString();

      vscode.env.openExternal(vscode.Uri.parse(authUrl));
    });

    // 2 minutes timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          server.close();
        } catch {}
        reject(new Error('等待浏览器 Google 登录授权超时 (2分钟)'));
      }
    }, 120000);
  });
}

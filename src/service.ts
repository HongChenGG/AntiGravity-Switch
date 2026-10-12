import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { AccountInfo, AntigravityStatus, TokenStats } from './types';
import { getAntigravityToolsDir, resolveAgySwitchPath } from './utils';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export class AntigravityService {
  private customAgySwitchPath: string = '';
  private lastKnownAccountId: string | null = null;
  private accountSwitchCallback: ((accountId: string, email: string) => void) | null = null;
  private statusChangedCallbacks: Array<() => void> = [];

  private watchers: fs.FSWatcher[] = [];
  private lastOnlineRefreshTime = 0;
  private isRefreshingOnline = false;
  private isSwitchingInternally = false;

  private cachedProcessStatus: { running: boolean; pid: number | null; timestamp: number } | null = null;
  private conversationDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.updateConfig();
    this.startWatchers();
  }

  public getExecEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:7897',
      HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897',
      http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || 'http://127.0.0.1:7897',
      https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897',
    };
  }

  public updateConfig(): void {
    const config = vscode.workspace.getConfiguration('antigravityStatus');
    this.customAgySwitchPath = config.get<string>('agySwitchPath', '');
  }

  public getAgySwitchExecutable(): string | null {
    return resolveAgySwitchPath(this.customAgySwitchPath);
  }

  public onAccountSwitched(callback: (accountId: string, email: string) => void): void {
    this.accountSwitchCallback = callback;
  }

  public onStatusChanged(callback: () => void): void {
    this.statusChangedCallbacks.push(callback);
  }

  private notifyStatusChanged(): void {
    for (const cb of this.statusChangedCallbacks) {
      try {
        cb();
      } catch (err) {
        console.error('Status changed callback error:', err);
      }
    }
  }

  private startWatchers(): void {
    const toolsDir = getAntigravityToolsDir();
    const accountsJsonPath = path.join(toolsDir, 'accounts.json');
    const accountsDirPath = path.join(toolsDir, 'accounts');
    const geminiConversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');

    // 1. Watch accounts.json (Account Switching)
    if (fs.existsSync(accountsJsonPath)) {
      try {
        const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
        const data = JSON.parse(raw);
        this.lastKnownAccountId = data.current_account_id || null;
      } catch {}

      try {
        const w1 = fs.watch(accountsJsonPath, (eventType) => {
          if (eventType === 'change') {
            setTimeout(() => {
              this.checkAccountChange(accountsJsonPath);
            }, 200);
          }
        });
        this.watchers.push(w1);
      } catch (e) {
        console.warn('Failed to watch accounts.json:', e);
      }
    }

    // 2. Watch accounts/ directory (Live quota updates from agy-switch-desktop or background)
    if (fs.existsSync(accountsDirPath)) {
      try {
        const w2 = fs.watch(accountsDirPath, (eventType, filename) => {
          if (eventType === 'change' || eventType === 'rename') {
            this.notifyStatusChanged();
          }
        });
        this.watchers.push(w2);
      } catch (e) {
        console.warn('Failed to watch accounts directory:', e);
      }
    }

    // 3. Watch .gemini/antigravity/conversations directory
    // Any time Antigravity completes a turn/prompt, its DB and WAL files are modified!
    if (fs.existsSync(geminiConversationsDir)) {
      try {
        const w3 = fs.watch(geminiConversationsDir, (eventType, filename) => {
          if (filename && (filename.endsWith('.db') || filename.endsWith('.db-wal'))) {
            if (this.conversationDebounceTimer) {
              clearTimeout(this.conversationDebounceTimer);
            }
            this.conversationDebounceTimer = setTimeout(() => {
              // Immediately refresh locally (0ms)
              this.notifyStatusChanged();
              // Trigger online quota refresh from Google Cloud via agy-switch in background
              const config = vscode.workspace.getConfiguration('antigravityStatus');
              const autoSync = config.get<boolean>('autoSyncOnlineOnTurn', true);
              if (autoSync) {
                this.refreshCurrentAccountOnline().catch(() => {});
              }
            }, 500);
          }
        });
        this.watchers.push(w3);
      } catch (e) {
        console.warn('Failed to watch conversations directory:', e);
      }
    }
  }

  private checkAccountChange(accountsJsonPath: string): void {
    if (this.isSwitchingInternally) return;
    try {
      if (!fs.existsSync(accountsJsonPath)) return;
      const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
      const data = JSON.parse(raw);
      const newId = data.current_account_id;
      if (newId && newId !== this.lastKnownAccountId) {
        this.lastKnownAccountId = newId;
        const matchingAcc = data.accounts?.find((a: any) => a.id === newId);
        const email = matchingAcc?.email || '未知账号';
        // Immediately notify listeners so status bar and dashboard switch data instantly
        this.notifyStatusChanged();
        if (this.accountSwitchCallback) {
          this.accountSwitchCallback(newId, email);
        }
      }
    } catch {
      // ignore
    }
  }

  public async checkAgyProcess(): Promise<{ running: boolean; pid: number | null }> {
    const now = Date.now();
    if (this.cachedProcessStatus && now - this.cachedProcessStatus.timestamp < 2000) {
      return {
        running: this.cachedProcessStatus.running,
        pid: this.cachedProcessStatus.pid,
      };
    }

    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq agy.exe" /FO CSV /NH');
        if (stdout.includes('agy.exe')) {
          const match = stdout.match(/"agy\.exe","(\d+)"/i);
          const pid = match ? parseInt(match[1], 10) : null;
          this.cachedProcessStatus = { running: true, pid, timestamp: now };
          return { running: true, pid };
        }
      } else {
        const { stdout } = await execAsync('pgrep -x agy || true');
        const trimmed = stdout.trim();
        if (trimmed) {
          const pid = parseInt(trimmed.split('\n')[0], 10);
          const resPid = isNaN(pid) ? null : pid;
          this.cachedProcessStatus = { running: true, pid: resPid, timestamp: now };
          return { running: true, pid: resPid };
        }
      }
    } catch {
      // ignore
    }

    this.cachedProcessStatus = { running: false, pid: null, timestamp: now };
    return { running: false, pid: null };
  }

  /**
   * Refreshes the currently active account quota online from Google servers via agy-switch
   * Runs in the background without blocking the UI
   */
  public async refreshCurrentAccountOnline(): Promise<void> {
    const now = Date.now();
    // Throttle to avoid calling Google API more than once every 3 seconds
    if (this.isRefreshingOnline || now - this.lastOnlineRefreshTime < 3000) {
      return;
    }

    const executable = this.getAgySwitchExecutable();
    const currentId = this.getCurrentAccountId();
    if (!executable || !currentId) {
      return;
    }

    this.isRefreshingOnline = true;
    this.lastOnlineRefreshTime = now;

    try {
      await execFileAsync(executable, ['refresh', currentId, '--json'], {
        timeout: 6000,
        encoding: 'utf-8',
        env: this.getExecEnv(),
      });
      // agy-switch updates accounts/<id>.json on disk, which fires the accounts directory watcher!
    } catch (e) {
      console.warn('Online quota refresh warning:', e);
    } finally {
      this.isRefreshingOnline = false;
    }
  }

  public getCurrentAccountId(): string | null {
    if (this.lastKnownAccountId) return this.lastKnownAccountId;
    const toolsDir = getAntigravityToolsDir();
    const accountsJsonPath = path.join(toolsDir, 'accounts.json');
    if (fs.existsSync(accountsJsonPath)) {
      try {
        const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
        const data = JSON.parse(raw);
        this.lastKnownAccountId = data.current_account_id || null;
        return this.lastKnownAccountId;
      } catch {}
    }
    return null;
  }

  public async fetchStatus(): Promise<AntigravityStatus> {
    const processPromise = this.checkAgyProcess();
    const executable = this.getAgySwitchExecutable();

    let account: AccountInfo | null = null;
    let stats: TokenStats | null = null;
    let error: string | null = null;

    // 1. Try reading directly from .antigravity_tools (0ms, 100% accurate & fresh)
    const toolsDir = getAntigravityToolsDir();
    const accountsJsonPath = path.join(toolsDir, 'accounts.json');

    if (fs.existsSync(accountsJsonPath)) {
      try {
        const rawAccounts = fs.readFileSync(accountsJsonPath, 'utf-8');
        const parsedAccounts = JSON.parse(rawAccounts);
        const currentId = parsedAccounts.current_account_id;
        this.lastKnownAccountId = currentId;

        if (currentId) {
          const accountDetailPath = path.join(toolsDir, 'accounts', `${currentId}.json`);
          if (fs.existsSync(accountDetailPath)) {
            const rawDetail = fs.readFileSync(accountDetailPath, 'utf-8');
            const detail = JSON.parse(rawDetail);
            account = {
              id: detail.id,
              email: detail.email,
              name: detail.name,
              is_current: true,
              last_used: detail.last_used,
              quota: detail.quota,
            };
          }
        }
      } catch (e: any) {
        console.warn('Direct accounts.json read warning:', e);
      }
    }

    // 2. Fallback to CLI if direct read didn't give full quota
    if (!account?.quota?.quota_groups && executable) {
      try {
        const { stdout } = await execFileAsync(executable, ['quota', '--json'], {
          timeout: 4000,
          encoding: 'utf-8',
        });
        const qData = JSON.parse(stdout);
        if (qData && qData.quota) {
          account = {
            id: qData.account_id || account?.id || '',
            email: qData.email || account?.email || '',
            name: account?.name || qData.email || '',
            is_current: true,
            quota: qData.quota,
          };
        }
      } catch {
        // Fallback to agy-switch current
        try {
          const { stdout } = await execFileAsync(executable, ['current', '--json'], {
            timeout: 4000,
            encoding: 'utf-8',
          });
          const cData = JSON.parse(stdout);
          if (cData && cData.account) {
            account = cData.account;
          }
        } catch (err: any) {
          error = `获取账号信息失败: ${err.message || String(err)}`;
        }
      }
    }

    // 3. Fetch token stats via CLI
    let statsPromise: Promise<TokenStats | null> = Promise.resolve(null);
    if (executable) {
      statsPromise = execFileAsync(executable, ['stats', '--json'], {
        timeout: 4000,
        encoding: 'utf-8',
      })
        .then(({ stdout }) => JSON.parse(stdout))
        .catch((e) => {
          if (!error && !account) {
            error = `获取 Token 消耗统计失败: ${e.message || String(e)}`;
          }
          return null;
        });
    }

    const [{ running: isAgyRunning, pid: agyPid }, fetchedStats] = await Promise.all([
      processPromise,
      statsPromise,
    ]);
    stats = fetchedStats;

    return {
      account,
      stats,
      isAgyRunning,
      agyPid,
      lastUpdated: new Date(),
      error,
    };
  }

  public async fetchAccountsList(): Promise<AccountInfo[]> {
    const toolsDir = getAntigravityToolsDir();
    const accountsJsonPath = path.join(toolsDir, 'accounts.json');

    if (fs.existsSync(accountsJsonPath)) {
      try {
        const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
        const data = JSON.parse(raw);
        const currentId = data.current_account_id;
        const list: AccountInfo[] = [];

        for (const a of data.accounts || []) {
          const detailPath = path.join(toolsDir, 'accounts', `${a.id}.json`);
          let quota = null;
          if (fs.existsSync(detailPath)) {
            try {
              const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
              quota = detail.quota || null;
            } catch {}
          }
          list.push({
            id: a.id,
            email: a.email,
            name: a.name,
            is_current: a.id === currentId,
            last_used: a.last_used,
            quota,
          });
        }
        return list;
      } catch {}
    }

    // Fallback to CLI
    const executable = this.getAgySwitchExecutable();
    if (!executable) {
      throw new Error('未找到 agy-switch.exe 或 .antigravity_tools 目录。');
    }
    const { stdout } = await execFileAsync(executable, ['accounts', 'list', '--json'], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  }

  public async switchAccount(
    accountIdOrEmail: string
  ): Promise<{ success: boolean; message: string }> {
    const executable = this.getAgySwitchExecutable();
    if (!executable) {
      throw new Error('未找到 agy-switch.exe。');
    }

    try {
      this.isSwitchingInternally = true;
      await execFileAsync(
        executable,
        ['switch', accountIdOrEmail, '--target', 'app', '--json'],
        { timeout: 15000, encoding: 'utf-8', env: this.getExecEnv() }
      );
      try {
        await execFileAsync(
          executable,
          ['switch', accountIdOrEmail, '--target', 'ide', '--json'],
          { timeout: 8000, encoding: 'utf-8', env: this.getExecEnv() }
        );
      } catch {}

      // Immediately re-read accounts.json to update lastKnownAccountId
      const toolsDir = getAntigravityToolsDir();
      const accountsJsonPath = path.join(toolsDir, 'accounts.json');
      if (fs.existsSync(accountsJsonPath)) {
        try {
          const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
          const data = JSON.parse(raw);
          this.lastKnownAccountId = data.current_account_id;
        } catch {}
      }

      // Online quota sync for new account
      const newId = this.getCurrentAccountId();
      if (newId) {
        try {
          await execFileAsync(executable, ['refresh', newId, '--json'], {
            timeout: 6000,
            encoding: 'utf-8',
            env: this.getExecEnv(),
          });
        } catch {}
      }

      // Restart agy.exe backend so it picks up the new token
      await this.restartAgyBackend();

      // Instantly trigger UI refresh
      this.notifyStatusChanged();

      return {
        success: true,
        message: '账号切换成功，核心后台进程已重启并载入新凭据！',
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    } finally {
      setTimeout(() => {
        this.isSwitchingInternally = false;
      }, 1500);
    }
  }

  public async restartAgyBackend(): Promise<{ success: boolean; message: string }> {
    try {
      if (process.platform === 'win32') {
        await execAsync('taskkill /F /IM agy.exe');
      } else {
        await execAsync('pkill -9 -x agy');
      }
      return {
        success: true,
        message: '已终止 agy.exe 后台进程，VS Code 反重力插件将自动以新账号重新拉起。',
      };
    } catch (err: any) {
      return {
        success: false,
        message: `终止进程失败或进程未运行: ${err.message || String(err)}`,
      };
    }
  }

  public async importAccount(
    email: string,
    refreshToken: string,
    accessToken?: string,
    idToken?: string,
    name?: string
  ): Promise<{ success: boolean; message: string; accountId?: string }> {
    const toolsDir = getAntigravityToolsDir();
    const accountsJsonPath = path.join(toolsDir, 'accounts.json');
    const accountsDir = path.join(toolsDir, 'accounts');

    if (!fs.existsSync(toolsDir)) {
      fs.mkdirSync(toolsDir, { recursive: true });
    }
    if (!fs.existsSync(accountsDir)) {
      fs.mkdirSync(accountsDir, { recursive: true });
    }

    const crypto = await import('crypto');
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const finalName = name || email.trim().split('@')[0];

    const accountDetail = {
      id,
      email: email.trim(),
      name: finalName,
      token: {
        access_token: accessToken || '',
        refresh_token: refreshToken.trim(),
        expires_in: 3599,
        expiry_timestamp: now + 3599,
        token_type: 'Bearer',
        email: email.trim(),
        project_id: 'aicode-consumers',
        oauth_client_key: 'antigravity_enterprise',
        is_gcp_tos: false,
        id_token: idToken || '',
      },
      quota: null,
    };

    // 1. Write detail file
    const detailPath = path.join(accountsDir, `${id}.json`);
    fs.writeFileSync(detailPath, JSON.stringify(accountDetail, null, 2), 'utf-8');

    // 2. Update accounts.json
    let accountsData: any = { version: '2.0', accounts: [] };
    if (fs.existsSync(accountsJsonPath)) {
      try {
        accountsData = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf-8'));
      } catch {}
    }

    if (!Array.isArray(accountsData.accounts)) {
      accountsData.accounts = [];
    }

    const existingIndex = accountsData.accounts.findIndex((a: any) => a.email === email.trim());
    if (existingIndex >= 0) {
      accountsData.accounts[existingIndex].id = id;
      accountsData.accounts[existingIndex].last_used = now;
    } else {
      accountsData.accounts.push({
        id,
        email: email.trim(),
        name: email.trim().split('@')[0],
        disabled: false,
        created_at: now,
        last_used: now,
      });
    }

    fs.writeFileSync(accountsJsonPath, JSON.stringify(accountsData, null, 2), 'utf-8');

    // 3. Trigger quota refresh in background if agy-switch is present
    const executable = this.getAgySwitchExecutable();
    if (executable) {
      try {
        await execFileAsync(executable, ['refresh', id, '--json'], {
          timeout: 8000,
          encoding: 'utf-8',
          env: this.getExecEnv(),
        });
      } catch (e) {
        console.warn('Initial quota refresh for imported account:', e);
      }
    }

    this.notifyStatusChanged();

    return {
      success: true,
      message: `账号 ${email} 导入成功！已建立凭据并同步至账号池。`,
      accountId: id,
    };
  }

  public dispose(): void {
    if (this.conversationDebounceTimer) {
      clearTimeout(this.conversationDebounceTimer);
      this.conversationDebounceTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }
}

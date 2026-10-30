import * as vscode from 'vscode';

import * as fs from 'fs';

import * as http from 'http';

import * as path from 'path';

import * as os from 'os';

import { execFile, exec } from 'child_process';

import { promisify } from 'util';

import {

  AccountInfo,

  AccountQuota,

  AccountSummary,

  AntigravityStatus,

  BatchQuotaRefreshResult,

  TokenStats,

} from './types';

import {

  runBoundedBatchRefresh,

  sortAccountSummaries,

  summarizeAccount,

} from './accountQuota';

import { exchangeRefreshToken, fetchAvailableModelsOnline } from './oauth';

import { getAntigravityToolsDir, getProxyUrl, resolveAgySwitchPath } from './utils';

const execFileAsync = promisify(execFile);

const execAsync = promisify(exec);

export class AntigravityService {

  private customAgySwitchPath: string = '';

  private lastKnownAccountId: string | null = null;

  private accountSwitchCallback: ((accountId: string, email: string) => void) | null = null;

  private statusChangedCallbacks: Array<() => void> = [];

  private accountsFileWatcher: fs.FSWatcher | null = null;

  private accountsDirWatcher: fs.FSWatcher | null = null;

  private conversationsWatcher: fs.FSWatcher | null = null;

  private lastOnlineRefreshTime = 0;

  private isRefreshingOnline = false;

  private isSwitchingInternally = false;

  private isSuppressingDirWatchNotify = false;

  private cachedProcessStatus: { running: boolean; pid: number | null; timestamp: number } | null = null;

  private conversationDebounceTimer: NodeJS.Timeout | null = null;

  private statsCache: { data: TokenStats | null; ts: number } | null = null;

  private statsInFlight: Promise<TokenStats | null> | null = null;

  private accountSummariesCache: { list: AccountSummary[]; ts: number } | null = null;

  private memoryQuotaFallback = new Map<string, AccountQuota>();

  private batchRefreshInFlight: Promise<BatchQuotaRefreshResult> | null = null;

  private hubEndpointsCache: { items: Array<{ port: number; csrf: string }>; ts: number } | null = null;

  private lastHubSyncTs = 0;

  constructor() {

    this.updateConfig();

    this.ensureWatchers();

  }

  /**

   * 子进程环境：仅当配置了代理或环境变量存在时注入，

   * 不再强制硬编码 127.0.0.1:7897（没有本地代理时会导致 CLI 联网全部失败/超时）。

   */

  public getExecEnv(): NodeJS.ProcessEnv {

    const proxy = getProxyUrl();

    if (!proxy) {

      return { ...process.env };

    }

    return {

      ...process.env,

      HTTP_PROXY: proxy,

      HTTPS_PROXY: proxy,

      http_proxy: proxy,

      https_proxy: proxy,

    };

  }

  public updateConfig(): void {

    const config = vscode.workspace.getConfiguration('antigravityStatus');

    this.customAgySwitchPath = config.get<string>('agySwitchPath', '');

    this.statsCache = null; // 配置变化后允许立刻重新拉取

    this.accountSummariesCache = null;

  }

  public invalidateAccountsCache(): void {

    this.accountSummariesCache = null;

  }

  public isBatchRefreshing(): boolean {

    return this.batchRefreshInFlight !== null;

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

  /**

   * 挂载文件监听。会在每次 fetchStatus 时懒调用：

   * 若激活时 ~/.antigravity_tools 尚不存在（后导入账号/装 CLI），也能补挂。

   */

  private ensureWatchers(): void {

    const toolsDir = getAntigravityToolsDir();

    const accountsJsonPath = path.join(toolsDir, 'accounts.json');

    const accountsDirPath = path.join(toolsDir, 'accounts');

    const geminiConversationsDir = path.join(

      os.homedir(),

      '.gemini',

      'antigravity',

      'conversations'

    );

    // 1. accounts.json（账号切换检测）

    if (!this.accountsFileWatcher && fs.existsSync(accountsJsonPath)) {

      this.watchAccountsFile(accountsJsonPath);

    }

    // 2. accounts/ 目录（配额文件被 agy-switch / 桌面版回写）

    if (!this.accountsDirWatcher && fs.existsSync(accountsDirPath)) {

      try {

        const w = fs.watch(accountsDirPath, (_eventType, filename) => {

          if (!filename || filename.toString().endsWith('.json')) {

            this.invalidateAccountsCache();

            if (!this.isSuppressingDirWatchNotify) {

              this.notifyStatusChanged();

            }

          }

        });

        w.on('error', () => {

          try {

            w.close();

          } catch {}

          if (this.accountsDirWatcher === w) {

            this.accountsDirWatcher = null;

          }

        });

        this.accountsDirWatcher = w;

      } catch (e) {

        console.warn('Failed to watch accounts directory:', e);

      }

    }

    // 3. conversations 目录：反重力每完成一轮生成会写 DB/WAL

    if (!this.conversationsWatcher && fs.existsSync(geminiConversationsDir)) {

      try {

        const w = fs.watch(geminiConversationsDir, (_eventType, filename) => {

          const name = filename ? filename.toString() : '';

          if (name.endsWith('.db') || name.endsWith('.db-wal')) {

            if (this.conversationDebounceTimer) {

              clearTimeout(this.conversationDebounceTimer);

            }

            this.conversationDebounceTimer = setTimeout(() => {

              this.notifyStatusChanged();

              const config = vscode.workspace.getConfiguration('antigravityStatus');

              const autoSync = config.get<boolean>('autoSyncOnlineOnTurn', true);

              if (autoSync) {

                this.refreshCurrentAccountOnline().catch(() => {});

              }

            }, 500);

          }

        });

        w.on('error', () => {

          try {

            w.close();

          } catch {}

          if (this.conversationsWatcher === w) {

            this.conversationsWatcher = null;

          }

        });

        this.conversationsWatcher = w;

      } catch (e) {

        console.warn('Failed to watch conversations directory:', e);

      }

    }

  }

  /**

   * 监听 accounts.json。Windows 上很多工具是"写临时文件 + rename 替换"的原子写，

   * 只听 'change' 会漏事件，且 rename 后旧 inode 失效必须重新挂监听。

   */

  private watchAccountsFile(accountsJsonPath: string): void {

    try {

      if (this.lastKnownAccountId === null) {

        try {

          const data = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf-8'));

          this.lastKnownAccountId = data.current_account_id || null;

        } catch {}

      }

      const watcher = fs.watch(accountsJsonPath, (eventType) => {

        setTimeout(() => {

          this.invalidateAccountsCache();

          if (fs.existsSync(accountsJsonPath)) {

            this.checkAccountChange(accountsJsonPath);

            if (eventType === 'rename') {

              // 原子替换后重新挂监听，否则后续切换全部漏检

              this.watchAccountsFile(accountsJsonPath);

            }

          } else {

            if (this.accountsFileWatcher) {

              try {

                this.accountsFileWatcher.close();

              } catch {}

              this.accountsFileWatcher = null;

            }

          }

        }, 200);

      });

      watcher.on('error', () => {

        try {

          watcher.close();

        } catch {}

        if (this.accountsFileWatcher === watcher) {

          this.accountsFileWatcher = null;

        }

      });

      if (this.accountsFileWatcher) {

        try {

          this.accountsFileWatcher.close();

        } catch {}

      }

      this.accountsFileWatcher = watcher;

    } catch (e) {

      console.warn('Failed to watch accounts.json:', e);

      this.accountsFileWatcher = null;

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

        this.invalidateAccountsCache();

        const matchingAcc = data.accounts?.find((a: any) => a.id === newId);

        const email = matchingAcc?.email || '未知账号';

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

    if (this.cachedProcessStatus && now - this.cachedProcessStatus.timestamp < 8000) {

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

          this.cachedProcessStatus = { running: true, pid, timestamp: now };

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

   * agy-switch stats 的本地缓存轮询：

   * 状态栏每 5 秒、仪表盘每 4 秒各刷一次，不再每次都拉起一个子进程。

   */

  private async fetchStatsCached(): Promise<TokenStats | null> {

    const config = vscode.workspace.getConfiguration('antigravityStatus');

    const ttlMs = Math.max(1, config.get<number>('statsCacheSeconds', 5)) * 1000;

    if (this.statsCache && Date.now() - this.statsCache.ts < ttlMs) {

      return this.statsCache.data;

    }

    if (this.statsInFlight) {

      return this.statsInFlight;

    }

    const executable = this.getAgySwitchExecutable();

    if (!executable) {

      return null;

    }

    this.statsInFlight = execFileAsync(executable, ['stats', '--json'], {

      timeout: 8000,

      encoding: 'utf-8',

      maxBuffer: 10 * 1024 * 1024,

    })

      .then(({ stdout }) => JSON.parse(stdout) as TokenStats)

      .catch((e) => {

        console.warn('stats fetch failed:', e?.message || e);

        return null;

      })

      .finally(() => {

        this.statsInFlight = null;

      });

    const data = await this.statsInFlight;

    this.statsCache = { data, ts: Date.now() };

    return data;

  }

  private getG4ArgonPersistentGroup(accountId: string): any | null {

    try {

      const toolsDir = getAntigravityToolsDir();

      const p = path.join(toolsDir, 'g4_argon_quotas.json');

      if (fs.existsSync(p)) {

        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));

        const info = data[accountId];

        if (

          info &&

          (info.bucket_id === 'gemini-argon-wtu-weekly' ||

            info.bucketId === 'gemini-argon-wtu-weekly')

        ) {

          return {

            display_name: 'Gemini 4 Argon',

            description: 'For paid Pro plans, Argon quota is separate.',

            buckets: [

              {

                bucket_id: 'gemini-argon-wtu-weekly',

                window: info.window || 'weekly',

                remaining_fraction:

                  typeof info.remaining_fraction === 'number'

                    ? info.remaining_fraction

                    : info.remainingFraction ?? 0,

                reset_time: info.reset_time || info.resetTime || '',

                display_name: 'Gemini 4 Argon Weekly Limit',

              },

            ],

          };

        }

      }

    } catch {}

    return null;

  }

  private saveG4ArgonPersistentGroup(accountId: string, email: string, bucket: any): void {

    try {

      const toolsDir = getAntigravityToolsDir();

      const p = path.join(toolsDir, 'g4_argon_quotas.json');

      let data: Record<string, any> = {};

      if (fs.existsSync(p)) {

        try {

          data = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};

        } catch {}

      }

      data[accountId] = {

        email,

        bucket_id: 'gemini-argon-wtu-weekly',

        window: bucket.window || 'weekly',

        remaining_fraction:

          typeof bucket.remaining_fraction === 'number'

            ? bucket.remaining_fraction

            : bucket.remainingFraction ?? 0,

        reset_time: bucket.reset_time || bucket.resetTime || '',

        recorded_at: Math.floor(Date.now() / 1000),

      };

      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');

    } catch {}

  }

  private mergeQuotaWithMemoryFallback(

    accountId: string,

    diskQuota: AccountQuota | null | undefined

  ): AccountQuota | null {

    const mem = this.memoryQuotaFallback.get(accountId);

    let result = diskQuota || null;

    if (mem) {

      if (!result) {

        result = mem;

      } else if ((!result.models || result.models.length === 0) && mem.models?.length) {

        result = {

          ...result,

          models: mem.models,

          last_updated: mem.last_updated || result.last_updated,

        };

      }

    }

    // 若账号未包含已持久化的 Argon 配额组，且在 g4_argon_quotas.json 中有记录，则合并

    const diskGroups = result?.quota_groups;

    if (Array.isArray(diskGroups)) {

      const hasArgon = diskGroups.some((g: any) =>

        /argon|gemini[\s\-_.]*4/i.test(String(g?.display_name ?? g?.displayName ?? ''))

      );

      if (!hasArgon) {

        const persistentArgon = this.getG4ArgonPersistentGroup(accountId);

        if (persistentArgon) {

          result = {

            ...(result || {}),

            quota_groups: [...diskGroups, persistentArgon],

          };

        }

      }

    }

    return result;

  }

  /**

   * 通过 agy-switch（及可选的内存级 Cloud Code 回退）向云端刷新指定账号配额

   */

  public async refreshAccountOnlineById(

    accountId: string,

    options?: { silentNotify?: boolean }

  ): Promise<{ success: boolean; accountId: string; email?: string; error?: string }> {

    const executable = this.getAgySwitchExecutable();

    const toolsDir = getAntigravityToolsDir();

    const detailPath = path.join(toolsDir, 'accounts', `${accountId}.json`);

    let email: string | undefined;

    let cliSucceeded = false;

    let lastError: string | undefined;

    let preservedArgonGroup: any = null;

    if (fs.existsSync(detailPath)) {

      try {

        const preDetail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));

        email = preDetail?.email;

        const preGroups = preDetail?.quota?.quota_groups;

        if (Array.isArray(preGroups)) {

          preservedArgonGroup =

            preGroups.find((g: any) =>

              /argon|gemini[\s\-_.]*4/i.test(String(g?.display_name ?? g?.displayName ?? ''))

            ) || null;

        }

      } catch {}

    }

    if (executable) {

      try {

        await execFileAsync(executable, ['refresh', accountId, '--json'], {

          timeout: 10000,

          encoding: 'utf-8',

          env: this.getExecEnv(),

        });

        cliSucceeded = true;

      } catch (e: any) {

        lastError = e?.message || String(e);

      }

    }

    // 若为当前激活账号，尝试从本地运行中的 agy.exe --hub RPC 读取独立 Gemini 4 Argon 周限额桶；

    // 若非激活账号但此前已缓存过独立 Argon 桶且 agy-switch 未返回该组，则予以保留不被抹除。

    const argonToRestore = preservedArgonGroup || this.getG4ArgonPersistentGroup(accountId);

    const isCurrentAcc = accountId === this.getCurrentAccountId();

    if (isCurrentAcc) {

      await this.syncActiveAccountFromAgyHub(accountId, true).catch(() => {});

    } else if (argonToRestore && fs.existsSync(detailPath)) {

      try {

        const postDetail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));

        if (Array.isArray(postDetail?.quota?.quota_groups)) {

          const hasArgonNow = postDetail.quota.quota_groups.some((g: any) =>

            /argon|gemini[\s\-_.]*4/i.test(String(g?.display_name ?? g?.displayName ?? ''))

          );

          if (!hasArgonNow) {

            postDetail.quota.quota_groups.push(argonToRestore);

            fs.writeFileSync(detailPath, JSON.stringify(postDetail, null, 2), 'utf-8');

          }

        }

      } catch {}

    }

    // 检查刷新后是否仍缺少 models（如部分 GCP Standard 账号），仅在内存中回退查询 fetchAvailableModels

    if (fs.existsSync(detailPath)) {

      try {

        const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));

        email = detail?.email || email;

        const q: AccountQuota | null = detail?.quota || null;

        const modelsEmpty = !q?.models || q.models.length === 0;

        if (!q?.is_forbidden && modelsEmpty && detail?.token) {

          const nowSec = Math.floor(Date.now() / 1000);

          let accessToken: string = detail.token.access_token || '';

          const expiry: number = detail.token.expiry_timestamp || 0;

          if ((!accessToken || expiry <= nowSec + 60) && detail.token.refresh_token) {

            try {

              const refreshed = await exchangeRefreshToken(detail.token.refresh_token);

              accessToken = refreshed.accessToken;

            } catch {}

          }

          if (accessToken) {

            const models = await fetchAvailableModelsOnline(

              accessToken,

              detail.token.project_id

            );

            if (models.length > 0) {

              this.memoryQuotaFallback.set(accountId, {

                ...(q || {}),

                models,

                last_updated: Math.floor(Date.now() / 1000),

              });

              cliSucceeded = true;

            }

          }

        } else if (q?.models && q.models.length > 0) {

          this.memoryQuotaFallback.delete(accountId);

        }

      } catch {}

    }

    this.invalidateAccountsCache();

    if (!options?.silentNotify) {

      this.notifyStatusChanged();

    }

    return {

      success: cliSucceeded,

      accountId,

      email,

      error: cliSucceeded ? undefined : lastError || '刷新失败',

    };

  }

  /**

   * 有界并发（5 Worker）批量向 Google 云端刷新全部账号剩余额度

   */

  public async refreshAllAccountsOnline(

    onProgress?: (completed: number, total: number, email: string) => void

  ): Promise<BatchQuotaRefreshResult> {

    if (this.batchRefreshInFlight) {

      return this.batchRefreshInFlight;

    }

    const run = async (): Promise<BatchQuotaRefreshResult> => {

      const accounts = await this.fetchAccountsList();

      const targets = accounts.filter((a) => !a.disabled);

      if (targets.length === 0) {

        return { total: 0, succeeded: 0, failed: 0 };

      }

      this.isSuppressingDirWatchNotify = true;

      try {

        const result = await runBoundedBatchRefresh(

          targets,

          (acc) => this.refreshAccountOnlineById(acc.id, { silentNotify: true }),

          {

            concurrency: 5,

            onProgress,

          }

        );

        return result;

      } finally {

        this.isSuppressingDirWatchNotify = false;

        this.invalidateAccountsCache();

        this.notifyStatusChanged();

      }

    };

    this.batchRefreshInFlight = run().finally(() => {

      this.batchRefreshInFlight = null;

    });

    return this.batchRefreshInFlight;

  }

  /**

   * 从本地运行中的 agy.exe --hub RPC 读取最新三组配额（含独立的 Gemini 4 Argon 周限额桶 gemini-argon-wtu-weekly）

   * 并回写至当前激活账号详情文件，弥补 agy-switch CLI 未返回 Argon 独立桶的问题。

   */

  public async syncActiveAccountFromAgyHub(

    targetAccountId?: string,

    force = false

  ): Promise<boolean> {

    const now = Date.now();

    if (!force && now - this.lastHubSyncTs < 8000) {

      return false;

    }

    const currentId = targetAccountId || this.getCurrentAccountId();

    if (!currentId) {

      return false;

    }

    const toolsDir = getAntigravityToolsDir();

    const detailPath = path.join(toolsDir, 'accounts', `${currentId}.json`);

    if (!fs.existsSync(detailPath)) {

      return false;

    }

    this.lastHubSyncTs = now;

    try {

      const endpoints = await this.discoverAgyHubEndpoints();

      if (endpoints.length === 0) {

        return false;

      }

      const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));

      const existingGroups: any[] = Array.isArray(detail?.quota?.quota_groups)

        ? detail.quota.quota_groups

        : [];

      const expectedGeminiWeeklyReset = existingGroups

        .flatMap((g: any) => (Array.isArray(g?.buckets) ? g.buckets : []))

        .find((b: any) => String(b?.bucket_id ?? b?.bucketId ?? '') === 'gemini-weekly')

        ?.reset_time;

      for (const ep of endpoints) {

        const groups = await this.queryAgyHubQuotaGroups(ep.port, ep.csrf);

        if (!groups || groups.length === 0) continue;

        const hubGeminiWeeklyReset = groups

          .flatMap((g: any) => (Array.isArray(g?.buckets) ? g.buckets : []))

          .find((b: any) => String(b?.bucketId ?? b?.bucket_id ?? '') === 'gemini-weekly')

          ?.resetTime;

        if (

          expectedGeminiWeeklyReset &&

          hubGeminiWeeklyReset &&

          expectedGeminiWeeklyReset !== hubGeminiWeeklyReset

        ) {

          continue;

        }

        const normalizedGroups = groups.map((g: any) => ({

          display_name: g.displayName ?? g.display_name ?? '',

          description: g.description ?? '',

          buckets: (Array.isArray(g.buckets) ? g.buckets : []).map((b: any) => ({

            bucket_id: b.bucketId ?? b.bucket_id ?? '',

            window: b.window ?? '',

            remaining_fraction:

              typeof b.remainingFraction === 'number'

                ? b.remainingFraction

                : typeof b.remaining_fraction === 'number'

                ? b.remaining_fraction

                : 0,

            remaining_fraction_known: true,

            reset_time: b.resetTime ?? b.reset_time ?? '',

            display_name: b.displayName ?? b.display_name ?? '',

            description: b.description ?? '',

          })),

        }));

        const argonBucket = normalizedGroups

          .flatMap((g: any) => (Array.isArray(g?.buckets) ? g.buckets : []))

          .find((b: any) => String(b?.bucket_id ?? '').includes('argon'));

        if (argonBucket && detail.email) {

          this.saveG4ArgonPersistentGroup(currentId, detail.email, argonBucket);

        }

        if (!detail.quota || typeof detail.quota !== 'object') {

          detail.quota = {};

        }

        detail.quota.quota_groups = normalizedGroups;

        detail.quota.last_updated = Math.floor(Date.now() / 1000);

        this.isSuppressingDirWatchNotify = true;

        try {

          fs.writeFileSync(detailPath, JSON.stringify(detail, null, 2), 'utf-8');

        } finally {

          this.isSuppressingDirWatchNotify = false;

        }

        this.invalidateAccountsCache();

        return true;

      }

    } catch {}

    return false;

  }

  private async discoverAgyHubEndpoints(): Promise<Array<{ port: number; csrf: string }>> {

    const now = Date.now();

    if (this.hubEndpointsCache && now - this.hubEndpointsCache.ts < 15000) {

      return this.hubEndpointsCache.items;

    }

    const items: Array<{ port: number; csrf: string }> = [];

    try {

      let out = '';

      if (process.platform === 'win32') {

        const res = await execFileAsync(

          'powershell.exe',

          [

            '-NoProfile',

            '-Command',

            "(Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | Sort-Object CreationDate -Descending).CommandLine",

          ],

          { timeout: 3000, encoding: 'utf-8' }

        );

        out = res.stdout || '';

      } else {

        const res = await execAsync('ps -axo pid,command | grep "agy" | grep -- "--hub-port="', {

          timeout: 2500,

        });

        out = res.stdout || '';

      }

      for (const line of out.split(/\r?\n/)) {

        const mp = /--hub-port=(\d+)/.exec(line);

        const mc = /--csrf_token=([a-f0-9\-]+)/i.exec(line);

        if (mp && mc) {

          items.push({ port: Number(mp[1]), csrf: mc[1] });

        }

      }

    } catch {}

    this.hubEndpointsCache = { items, ts: now };

    return items;

  }

  private queryAgyHubQuotaGroups(port: number, csrf: string): Promise<any[] | null> {

    return new Promise((resolve) => {

      const body = '{}';

      const req = http.request(

        {

          hostname: '127.0.0.1',

          port,

          path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',

          method: 'POST',

          timeout: 1800,

          headers: {

            'Content-Type': 'application/json',

            'Connect-Protocol-Version': '1',

            'x-codeium-csrf-token': csrf,

            'Content-Length': Buffer.byteLength(body),

          },

        },

        (res) => {

          let raw = '';

          res.on('data', (chunk) => (raw += chunk));

          res.on('end', () => {

            try {

              const parsed = JSON.parse(raw);

              const groups = parsed?.response?.groups ?? parsed?.groups;

              resolve(Array.isArray(groups) ? groups : null);

            } catch {

              resolve(null);

            }

          });

        }

      );

      req.on('error', () => resolve(null));

      req.on('timeout', () => {

        req.destroy();

        resolve(null);

      });

      req.write(body);

      req.end();

    });

  }

  /**

   * 通过 agy-switch 在后台向 Google 云端刷新当前账号配额

   */

  public async refreshCurrentAccountOnline(): Promise<void> {

    const now = Date.now();

    if (this.isRefreshingOnline || now - this.lastOnlineRefreshTime < 3000) {

      return;

    }

    const currentId = this.getCurrentAccountId();

    if (!currentId) {

      return;

    }

    this.isRefreshingOnline = true;

    this.lastOnlineRefreshTime = now;

    try {

      await this.refreshAccountOnlineById(currentId, { silentNotify: true });

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

    // 懒挂载：目录可能晚于插件激活才创建

    this.ensureWatchers();

    // 尝试从本地运行中的 agy.exe --hub 同步最新三组配额（含独立 Gemini 4 Argon 周限额桶，内部带 8s 节流）

    await this.syncActiveAccountFromAgyHub().catch(() => {});

    const processPromise = this.checkAgyProcess();

    const executable = this.getAgySwitchExecutable();

    let account: AccountInfo | null = null;

    let error: string | null = null;

    // 1. 直接读 .antigravity_tools（本地磁盘，快且新鲜）

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

              disabled: Boolean(detail.disabled),

              is_current: true,

              last_used: detail.last_used,

              project_id: detail.token?.project_id ?? null,

              is_gcp_tos: Boolean(detail.token?.is_gcp_tos),

              quota: this.mergeQuotaWithMemoryFallback(detail.id, detail.quota),

            };

          }

        }

      } catch (e: any) {

        console.warn('Direct accounts.json read warning:', e);

      }

    }

    // 2. 本地读不到配额时回退 CLI

    if (!account?.quota?.quota_groups && !account?.quota?.models?.length && executable) {

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

    // 3. Token 统计（带缓存）

    const statsPromise = this.fetchStatsCached();

    const [{ running: isAgyRunning, pid: agyPid }, stats] = await Promise.all([

      processPromise,

      statsPromise,

    ]);

    return {

      account,

      stats,

      isAgyRunning,

      agyPid,

      lastUpdated: new Date(),

      error,

    };

  }

  /**

   * 账号总数：只读 accounts.json 一个文件。

   * 仪表盘高频轮询用这个，不要为拿个数把全部账号详情文件读一遍。

   */

  public countAccounts(): number {

    if (this.accountSummariesCache) {

      return this.accountSummariesCache.list.length;

    }

    const toolsDir = getAntigravityToolsDir();

    const accountsJsonPath = path.join(toolsDir, 'accounts.json');

    try {

      const data = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf-8'));

      return Array.isArray(data.accounts) ? data.accounts.length : 0;

    } catch {

      return 0;

    }

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

          let quota: AccountQuota | null = null;

          let disabled = Boolean(a.disabled);

          let projectId: string | null = null;

          let isGcpTos = false;

          if (fs.existsSync(detailPath)) {

            try {

              const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));

              quota = detail.quota || null;

              disabled = disabled || Boolean(detail.disabled);

              projectId = detail.token?.project_id ?? null;

              isGcpTos = Boolean(detail.token?.is_gcp_tos);

            } catch {}

          }

          list.push({

            id: a.id,

            email: a.email,

            name: a.name,

            custom_label: a.custom_label ?? null,

            disabled,

            is_current: a.id === currentId,

            last_used: a.last_used,

            project_id: projectId,

            is_gcp_tos: isGcpTos,

            quota: this.mergeQuotaWithMemoryFallback(a.id, quota),

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

  /**

   * 获取全部账号结构化剩余额度摘要（已按智能优先级排序）。

   * 默认带 10 秒内存缓存，并在 accounts/ 或 accounts.json 文件变动时立即失效，

   * 保证状态栏 5s 轮询与仪表盘 4s 轮询零额外磁盘压力。

   */

  public async fetchAccountSummaries(forceFresh = false): Promise<AccountSummary[]> {

    const now = Date.now();

    if (!forceFresh && this.accountSummariesCache && now - this.accountSummariesCache.ts < 10_000) {

      return this.accountSummariesCache.list;

    }

    try {

      const rawList = await this.fetchAccountsList();

      const summarized = rawList.map((acc) => summarizeAccount(acc, now));

      const sorted = sortAccountSummaries(summarized);

      this.accountSummariesCache = { list: sorted, ts: now };

      return sorted;

    } catch {

      return this.accountSummariesCache ? this.accountSummariesCache.list : [];

    }

  }

  /**

   * 纯原生无依赖账号切换：

   * 即使系统未安装 agy-switch.exe 或 CLI 报错，插件也能独立完成全流程切换。

   * 1. 检索目标账号（按 id 或 email）

   * 2. 更新 ~/.antigravity_tools/accounts.json 中的 current_account_id 与 last_used

   * 3. 更新 ~/.antigravity_tools/accounts/<id>.json 中的 last_used

   * 4. 直写 ~/.gemini/jetski-standalone-oauth-token 凭据文件（供核心后台进程读取）

   */

  /**
   * 纯原生无依赖账号切换：
   * 即使系统未安装 agy-switch.exe 或 CLI 报错，插件也能独立完成全流程切换。
   * 1. 检索目标账号（按 id 或 email）
   * 2. 更新 ~/.antigravity_tools/accounts.json 中的 current_account_id 与 last_used
   * 3. 更新 ~/.antigravity_tools/accounts/<id>.json 中的 last_used
   * 4. 直写 ~/.gemini/jetski-standalone-oauth-token 凭据文件（供核心后台进程读取）
   */
  public async switchAccountNatively(
    accountIdOrEmail: string
  ): Promise<{ success: boolean; accountId: string; email: string }> {
    const toolsDir = getAntigravityToolsDir();
    const accountsJsonPath = path.join(toolsDir, 'accounts.json');
    if (!fs.existsSync(accountsJsonPath)) {
      throw new Error(`账号索引文件不存在: ${accountsJsonPath}`);
    }

    const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
    const indexData = JSON.parse(raw);
    const accounts: Array<{ id: string; email: string; name?: string; last_used?: number | null }> =
      Array.isArray(indexData.accounts) ? indexData.accounts : [];

    const target = accounts.find(
      (a) => a.id === accountIdOrEmail || a.email.toLowerCase() === accountIdOrEmail.toLowerCase()
    );
    if (!target) {
      throw new Error(`未找到匹配的账号: ${accountIdOrEmail}`);
    }

    const detailPath = path.join(toolsDir, 'accounts', `${target.id}.json`);
    if (!fs.existsSync(detailPath)) {
      throw new Error(`账号详情文件不存在: ${detailPath}`);
    }

    const detailRaw = fs.readFileSync(detailPath, 'utf-8');
    const detail = JSON.parse(detailRaw);
    const token = detail.token;
    if (!token || !token.refresh_token) {
      throw new Error(`账号 ${target.email} 凭据不完整（缺少 refresh_token）`);
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // 1. 更新 accounts.json（保持 last_used 为整数时间戳，防止 agy-switch 反序列化失败）
    indexData.current_account_id = target.id;
    for (const a of accounts) {
      if (a.id === target.id) {
        a.last_used = nowSec;
      }
    }
    fs.writeFileSync(accountsJsonPath, JSON.stringify(indexData, null, 2), 'utf-8');
    this.lastKnownAccountId = target.id;

    // 2. 更新 detail 文件中的 last_used
    detail.last_used = nowSec;
    fs.writeFileSync(detailPath, JSON.stringify(detail, null, 2), 'utf-8');

    // 3. 写入 ~/.gemini/jetski-standalone-oauth-token 凭据
    const geminiDir = path.join(os.homedir(), '.gemini');
    if (!fs.existsSync(geminiDir)) {
      fs.mkdirSync(geminiDir, { recursive: true });
    }
    const jetskiTokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');

    let expiryIso = '';
    if (typeof token.expiry_timestamp === 'number') {
      expiryIso = new Date(token.expiry_timestamp * 1000).toISOString();
    } else if (typeof token.expires_in === 'number') {
      expiryIso = new Date(Date.now() + token.expires_in * 1000).toISOString();
    } else {
      expiryIso = new Date(Date.now() + 3600 * 1000).toISOString();
    }

    const jetskiPayload = {
      token: {
        access_token: token.access_token || '',
        token_type: token.token_type || 'Bearer',
        refresh_token: token.refresh_token,
        expiry: expiryIso,
      },
      auth_method: 'consumer',
      id_token: token.id_token || '',
    };
    fs.writeFileSync(jetskiTokenPath, JSON.stringify(jetskiPayload, null, 2), 'utf-8');

    return { success: true, accountId: target.id, email: target.email };
  }

  public async switchAccount(

    accountIdOrEmail: string

  ): Promise<{ success: boolean; message: string }> {

    const executable = this.getAgySwitchExecutable();

    let cliSwitched = false;

    try {

      this.isSwitchingInternally = true;

      // 1. 如果检测到 agy-switch CLI 可执行文件，优先尝试通过 CLI 切换

      if (executable) {

        try {

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

          cliSwitched = true;

        } catch (cliErr) {

          console.warn('agy-switch CLI 执行切换失败，自动降级为插件原生独立切换:', cliErr);

        }

      }

      // 2. 若未安装 agy-switch 或 CLI 执行失败，直接使用插件原生独立切换

      if (!cliSwitched) {

        await this.switchAccountNatively(accountIdOrEmail);

      }

      const toolsDir = getAntigravityToolsDir();

      const accountsJsonPath = path.join(toolsDir, 'accounts.json');

      if (fs.existsSync(accountsJsonPath)) {

        try {

          const raw = fs.readFileSync(accountsJsonPath, 'utf-8');

          const data = JSON.parse(raw);

          this.lastKnownAccountId = data.current_account_id;

        } catch {}

      }

      const newId = this.getCurrentAccountId();

      // 云端配额刷新与重启后端并行：refresh 独立连 Google、不依赖 agy.exe，

      // 串行等待会白白多花最多 6 秒

      const refreshPromise = newId

        ? this.refreshAccountOnlineById(newId, { silentNotify: true }).catch(() => {})

        : Promise.resolve();

      await Promise.all([refreshPromise, this.restartAgyBackend()]);

      this.invalidateAccountsCache();

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

    this.cachedProcessStatus = null; // 立即失效缓存，避免显示过期进程状态

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

      const msg = err?.message || String(err) || '';

      const code = typeof err?.code === 'number' ? err.code : null;

      // 用退出码判断而非消息文本：taskkill 输出是 GBK 中文，经 Node 捕获后是乱码无法匹配。

      // taskkill 128 = 没有找到进程；pkill 1 = 无匹配进程 —— 都表示"未在运行"

      if (

        code === 128 ||

        (process.platform !== 'win32' && code === 1) ||

        /not found|找不到|没有/i.test(msg)

      ) {

        return { success: true, message: 'agy.exe 未在运行，无需终止。' };

      }

      return {

        success: false,

        message: `终止进程失败: ${msg}`,

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

    // 1. 写账号详情文件

    const detailPath = path.join(accountsDir, `${id}.json`);

    fs.writeFileSync(detailPath, JSON.stringify(accountDetail, null, 2), 'utf-8');

    // 2. 更新 accounts.json

    let accountsData: any = { version: '2.0', accounts: [] };

    if (fs.existsSync(accountsJsonPath)) {

      try {

        accountsData = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf-8'));

      } catch {}

    }

    if (!Array.isArray(accountsData.accounts)) {

      accountsData.accounts = [];

    }

    const existingIndex = accountsData.accounts.findIndex(

      (a: any) => a.email === email.trim()

    );

    if (existingIndex >= 0) {

      const oldId = accountsData.accounts[existingIndex].id;

      // 同邮箱替换：清理旧详情文件，避免残留失效凭据

      if (oldId && oldId !== id) {

        try {

          fs.unlinkSync(path.join(accountsDir, `${oldId}.json`));

        } catch {}

      }

      accountsData.accounts[existingIndex].id = id;

      accountsData.accounts[existingIndex].name = finalName;

      accountsData.accounts[existingIndex].last_used = now;

    } else {

      accountsData.accounts.push({

        id,

        email: email.trim(),

        name: finalName,

        disabled: false,

        created_at: now,

        last_used: now,

      });

    }

    fs.writeFileSync(accountsJsonPath, JSON.stringify(accountsData, null, 2), 'utf-8');

    // 3. 后台触发配额刷新

    try {

      await this.refreshAccountOnlineById(id, { silentNotify: true });

    } catch (e) {

      console.warn('Initial quota refresh for imported account:', e);

    }

    this.invalidateAccountsCache();

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

    for (const w of [this.accountsFileWatcher, this.accountsDirWatcher, this.conversationsWatcher]) {

      if (w) {

        try {

          w.close();

        } catch {}

      }

    }

    this.accountsFileWatcher = null;

    this.accountsDirWatcher = null;

    this.conversationsWatcher = null;

  }

}


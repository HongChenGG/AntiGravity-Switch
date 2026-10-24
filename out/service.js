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
exports.AntigravityService = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const utils_1 = require("./utils");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class AntigravityService {
    customAgySwitchPath = '';
    lastKnownAccountId = null;
    accountSwitchCallback = null;
    statusChangedCallbacks = [];
    accountsFileWatcher = null;
    accountsDirWatcher = null;
    conversationsWatcher = null;
    lastOnlineRefreshTime = 0;
    isRefreshingOnline = false;
    isSwitchingInternally = false;
    cachedProcessStatus = null;
    conversationDebounceTimer = null;
    statsCache = null;
    statsInFlight = null;
    constructor() {
        this.updateConfig();
        this.ensureWatchers();
    }
    /**
     * 子进程环境：仅当配置了代理或环境变量存在时注入，
     * 不再强制硬编码 127.0.0.1:7897（没有本地代理时会导致 CLI 联网全部失败/超时）。
     */
    getExecEnv() {
        const proxy = (0, utils_1.getProxyUrl)();
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
    updateConfig() {
        const config = vscode.workspace.getConfiguration('antigravityStatus');
        this.customAgySwitchPath = config.get('agySwitchPath', '');
        this.statsCache = null; // 配置变化后允许立刻重新拉取
    }
    getAgySwitchExecutable() {
        return (0, utils_1.resolveAgySwitchPath)(this.customAgySwitchPath);
    }
    onAccountSwitched(callback) {
        this.accountSwitchCallback = callback;
    }
    onStatusChanged(callback) {
        this.statusChangedCallbacks.push(callback);
    }
    notifyStatusChanged() {
        for (const cb of this.statusChangedCallbacks) {
            try {
                cb();
            }
            catch (err) {
                console.error('Status changed callback error:', err);
            }
        }
    }
    /**
     * 挂载文件监听。会在每次 fetchStatus 时懒调用：
     * 若激活时 ~/.antigravity_tools 尚不存在（后导入账号/装 CLI），也能补挂。
     */
    ensureWatchers() {
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
        const accountsJsonPath = path.join(toolsDir, 'accounts.json');
        const accountsDirPath = path.join(toolsDir, 'accounts');
        const geminiConversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
        // 1. accounts.json（账号切换检测）
        if (!this.accountsFileWatcher && fs.existsSync(accountsJsonPath)) {
            this.watchAccountsFile(accountsJsonPath);
        }
        // 2. accounts/ 目录（配额文件被 agy-switch / 桌面版回写）
        if (!this.accountsDirWatcher && fs.existsSync(accountsDirPath)) {
            try {
                const w = fs.watch(accountsDirPath, (_eventType, filename) => {
                    if (!filename || filename.toString().endsWith('.json')) {
                        this.notifyStatusChanged();
                    }
                });
                w.on('error', () => {
                    try {
                        w.close();
                    }
                    catch { }
                    if (this.accountsDirWatcher === w) {
                        this.accountsDirWatcher = null;
                    }
                });
                this.accountsDirWatcher = w;
            }
            catch (e) {
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
                            const autoSync = config.get('autoSyncOnlineOnTurn', true);
                            if (autoSync) {
                                this.refreshCurrentAccountOnline().catch(() => { });
                            }
                        }, 500);
                    }
                });
                w.on('error', () => {
                    try {
                        w.close();
                    }
                    catch { }
                    if (this.conversationsWatcher === w) {
                        this.conversationsWatcher = null;
                    }
                });
                this.conversationsWatcher = w;
            }
            catch (e) {
                console.warn('Failed to watch conversations directory:', e);
            }
        }
    }
    /**
     * 监听 accounts.json。Windows 上很多工具是"写临时文件 + rename 替换"的原子写，
     * 只听 'change' 会漏事件，且 rename 后旧 inode 失效必须重新挂监听。
     */
    watchAccountsFile(accountsJsonPath) {
        try {
            if (this.lastKnownAccountId === null) {
                try {
                    const data = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf-8'));
                    this.lastKnownAccountId = data.current_account_id || null;
                }
                catch { }
            }
            const watcher = fs.watch(accountsJsonPath, (eventType) => {
                setTimeout(() => {
                    if (fs.existsSync(accountsJsonPath)) {
                        this.checkAccountChange(accountsJsonPath);
                        if (eventType === 'rename') {
                            // 原子替换后重新挂监听，否则后续切换全部漏检
                            this.watchAccountsFile(accountsJsonPath);
                        }
                    }
                    else {
                        if (this.accountsFileWatcher) {
                            try {
                                this.accountsFileWatcher.close();
                            }
                            catch { }
                            this.accountsFileWatcher = null;
                        }
                    }
                }, 200);
            });
            watcher.on('error', () => {
                try {
                    watcher.close();
                }
                catch { }
                if (this.accountsFileWatcher === watcher) {
                    this.accountsFileWatcher = null;
                }
            });
            if (this.accountsFileWatcher) {
                try {
                    this.accountsFileWatcher.close();
                }
                catch { }
            }
            this.accountsFileWatcher = watcher;
        }
        catch (e) {
            console.warn('Failed to watch accounts.json:', e);
            this.accountsFileWatcher = null;
        }
    }
    checkAccountChange(accountsJsonPath) {
        if (this.isSwitchingInternally)
            return;
        try {
            if (!fs.existsSync(accountsJsonPath))
                return;
            const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
            const data = JSON.parse(raw);
            const newId = data.current_account_id;
            if (newId && newId !== this.lastKnownAccountId) {
                this.lastKnownAccountId = newId;
                const matchingAcc = data.accounts?.find((a) => a.id === newId);
                const email = matchingAcc?.email || '未知账号';
                this.notifyStatusChanged();
                if (this.accountSwitchCallback) {
                    this.accountSwitchCallback(newId, email);
                }
            }
        }
        catch {
            // ignore
        }
    }
    async checkAgyProcess() {
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
            }
            else {
                const { stdout } = await execAsync('pgrep -x agy || true');
                const trimmed = stdout.trim();
                if (trimmed) {
                    const pid = parseInt(trimmed.split('\n')[0], 10);
                    const resPid = isNaN(pid) ? null : pid;
                    this.cachedProcessStatus = { running: true, pid: resPid, timestamp: now };
                    return { running: true, pid: resPid };
                }
            }
        }
        catch {
            // ignore
        }
        this.cachedProcessStatus = { running: false, pid: null, timestamp: now };
        return { running: false, pid: null };
    }
    /**
     * agy-switch stats 的本地缓存轮询：
     * 状态栏每 5 秒、仪表盘每 4 秒各刷一次，不再每次都拉起一个子进程。
     */
    async fetchStatsCached() {
        const config = vscode.workspace.getConfiguration('antigravityStatus');
        const ttlMs = Math.max(1, config.get('statsCacheSeconds', 3)) * 1000;
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
            .then(({ stdout }) => JSON.parse(stdout))
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
    /**
     * 通过 agy-switch 在后台向 Google 云端刷新当前账号配额
     */
    async refreshCurrentAccountOnline() {
        const now = Date.now();
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
        }
        catch (e) {
            console.warn('Online quota refresh warning:', e);
        }
        finally {
            this.isRefreshingOnline = false;
        }
    }
    getCurrentAccountId() {
        if (this.lastKnownAccountId)
            return this.lastKnownAccountId;
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
        const accountsJsonPath = path.join(toolsDir, 'accounts.json');
        if (fs.existsSync(accountsJsonPath)) {
            try {
                const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
                const data = JSON.parse(raw);
                this.lastKnownAccountId = data.current_account_id || null;
                return this.lastKnownAccountId;
            }
            catch { }
        }
        return null;
    }
    async fetchStatus() {
        // 懒挂载：目录可能晚于插件激活才创建
        this.ensureWatchers();
        const processPromise = this.checkAgyProcess();
        const executable = this.getAgySwitchExecutable();
        let account = null;
        let error = null;
        // 1. 直接读 .antigravity_tools（本地磁盘，快且新鲜）
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
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
            }
            catch (e) {
                console.warn('Direct accounts.json read warning:', e);
            }
        }
        // 2. 本地读不到配额时回退 CLI
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
            }
            catch {
                try {
                    const { stdout } = await execFileAsync(executable, ['current', '--json'], {
                        timeout: 4000,
                        encoding: 'utf-8',
                    });
                    const cData = JSON.parse(stdout);
                    if (cData && cData.account) {
                        account = cData.account;
                    }
                }
                catch (err) {
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
    async fetchAccountsList() {
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
        const accountsJsonPath = path.join(toolsDir, 'accounts.json');
        if (fs.existsSync(accountsJsonPath)) {
            try {
                const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
                const data = JSON.parse(raw);
                const currentId = data.current_account_id;
                const list = [];
                for (const a of data.accounts || []) {
                    const detailPath = path.join(toolsDir, 'accounts', `${a.id}.json`);
                    let quota = null;
                    if (fs.existsSync(detailPath)) {
                        try {
                            const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
                            quota = detail.quota || null;
                        }
                        catch { }
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
            }
            catch { }
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
    async switchAccount(accountIdOrEmail) {
        const executable = this.getAgySwitchExecutable();
        if (!executable) {
            throw new Error('未找到 agy-switch.exe。');
        }
        try {
            this.isSwitchingInternally = true;
            await execFileAsync(executable, ['switch', accountIdOrEmail, '--target', 'app', '--json'], { timeout: 15000, encoding: 'utf-8', env: this.getExecEnv() });
            try {
                await execFileAsync(executable, ['switch', accountIdOrEmail, '--target', 'ide', '--json'], { timeout: 8000, encoding: 'utf-8', env: this.getExecEnv() });
            }
            catch { }
            const toolsDir = (0, utils_1.getAntigravityToolsDir)();
            const accountsJsonPath = path.join(toolsDir, 'accounts.json');
            if (fs.existsSync(accountsJsonPath)) {
                try {
                    const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
                    const data = JSON.parse(raw);
                    this.lastKnownAccountId = data.current_account_id;
                }
                catch { }
            }
            const newId = this.getCurrentAccountId();
            if (newId) {
                try {
                    await execFileAsync(executable, ['refresh', newId, '--json'], {
                        timeout: 6000,
                        encoding: 'utf-8',
                        env: this.getExecEnv(),
                    });
                }
                catch { }
            }
            await this.restartAgyBackend();
            this.notifyStatusChanged();
            return {
                success: true,
                message: '账号切换成功，核心后台进程已重启并载入新凭据！',
            };
        }
        catch (err) {
            return { success: false, message: err.message || String(err) };
        }
        finally {
            setTimeout(() => {
                this.isSwitchingInternally = false;
            }, 1500);
        }
    }
    async restartAgyBackend() {
        this.cachedProcessStatus = null; // 立即失效缓存，避免显示过期进程状态
        try {
            if (process.platform === 'win32') {
                await execAsync('taskkill /F /IM agy.exe');
            }
            else {
                await execAsync('pkill -9 -x agy');
            }
            return {
                success: true,
                message: '已终止 agy.exe 后台进程，VS Code 反重力插件将自动以新账号重新拉起。',
            };
        }
        catch (err) {
            const msg = err?.message || String(err) || '';
            // taskkill 找不到进程时返回非零退出码，这不是错误
            if (/128|not found|找不到|没有/i.test(msg)) {
                return { success: true, message: 'agy.exe 未在运行，无需终止。' };
            }
            return {
                success: false,
                message: `终止进程失败: ${msg}`,
            };
        }
    }
    async importAccount(email, refreshToken, accessToken, idToken, name) {
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
        const accountsJsonPath = path.join(toolsDir, 'accounts.json');
        const accountsDir = path.join(toolsDir, 'accounts');
        if (!fs.existsSync(toolsDir)) {
            fs.mkdirSync(toolsDir, { recursive: true });
        }
        if (!fs.existsSync(accountsDir)) {
            fs.mkdirSync(accountsDir, { recursive: true });
        }
        const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
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
        let accountsData = { version: '2.0', accounts: [] };
        if (fs.existsSync(accountsJsonPath)) {
            try {
                accountsData = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf-8'));
            }
            catch { }
        }
        if (!Array.isArray(accountsData.accounts)) {
            accountsData.accounts = [];
        }
        const existingIndex = accountsData.accounts.findIndex((a) => a.email === email.trim());
        if (existingIndex >= 0) {
            const oldId = accountsData.accounts[existingIndex].id;
            // 同邮箱替换：清理旧详情文件，避免残留失效凭据
            if (oldId && oldId !== id) {
                try {
                    fs.unlinkSync(path.join(accountsDir, `${oldId}.json`));
                }
                catch { }
            }
            accountsData.accounts[existingIndex].id = id;
            accountsData.accounts[existingIndex].name = finalName;
            accountsData.accounts[existingIndex].last_used = now;
        }
        else {
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
        const executable = this.getAgySwitchExecutable();
        if (executable) {
            try {
                await execFileAsync(executable, ['refresh', id, '--json'], {
                    timeout: 8000,
                    encoding: 'utf-8',
                    env: this.getExecEnv(),
                });
            }
            catch (e) {
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
    dispose() {
        if (this.conversationDebounceTimer) {
            clearTimeout(this.conversationDebounceTimer);
            this.conversationDebounceTimer = null;
        }
        for (const w of [this.accountsFileWatcher, this.accountsDirWatcher, this.conversationsWatcher]) {
            if (w) {
                try {
                    w.close();
                }
                catch { }
            }
        }
        this.accountsFileWatcher = null;
        this.accountsDirWatcher = null;
        this.conversationsWatcher = null;
    }
}
exports.AntigravityService = AntigravityService;
//# sourceMappingURL=service.js.map
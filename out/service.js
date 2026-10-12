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
    watchers = [];
    lastOnlineRefreshTime = 0;
    isRefreshingOnline = false;
    isSwitchingInternally = false;
    cachedProcessStatus = null;
    conversationDebounceTimer = null;
    constructor() {
        this.updateConfig();
        this.startWatchers();
    }
    getExecEnv() {
        return {
            ...process.env,
            HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:7897',
            HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897',
            http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || 'http://127.0.0.1:7897',
            https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897',
        };
    }
    updateConfig() {
        const config = vscode.workspace.getConfiguration('antigravityStatus');
        this.customAgySwitchPath = config.get('agySwitchPath', '');
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
    startWatchers() {
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
        const accountsJsonPath = path.join(toolsDir, 'accounts.json');
        const accountsDirPath = path.join(toolsDir, 'accounts');
        const geminiConversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
        // 1. Watch accounts.json (Account Switching)
        if (fs.existsSync(accountsJsonPath)) {
            try {
                const raw = fs.readFileSync(accountsJsonPath, 'utf-8');
                const data = JSON.parse(raw);
                this.lastKnownAccountId = data.current_account_id || null;
            }
            catch { }
            try {
                const w1 = fs.watch(accountsJsonPath, (eventType) => {
                    if (eventType === 'change') {
                        setTimeout(() => {
                            this.checkAccountChange(accountsJsonPath);
                        }, 200);
                    }
                });
                this.watchers.push(w1);
            }
            catch (e) {
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
            }
            catch (e) {
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
                            const autoSync = config.get('autoSyncOnlineOnTurn', true);
                            if (autoSync) {
                                this.refreshCurrentAccountOnline().catch(() => { });
                            }
                        }, 500);
                    }
                });
                this.watchers.push(w3);
            }
            catch (e) {
                console.warn('Failed to watch conversations directory:', e);
            }
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
                // Immediately notify listeners so status bar and dashboard switch data instantly
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
     * Refreshes the currently active account quota online from Google servers via agy-switch
     * Runs in the background without blocking the UI
     */
    async refreshCurrentAccountOnline() {
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
        const processPromise = this.checkAgyProcess();
        const executable = this.getAgySwitchExecutable();
        let account = null;
        let stats = null;
        let error = null;
        // 1. Try reading directly from .antigravity_tools (0ms, 100% accurate & fresh)
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
            }
            catch {
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
                }
                catch (err) {
                    error = `获取账号信息失败: ${err.message || String(err)}`;
                }
            }
        }
        // 3. Fetch token stats via CLI
        let statsPromise = Promise.resolve(null);
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
            // Immediately re-read accounts.json to update lastKnownAccountId
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
            // Online quota sync for new account
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
            // Restart agy.exe backend so it picks up the new token
            await this.restartAgyBackend();
            // Instantly trigger UI refresh
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
            return {
                success: false,
                message: `终止进程失败或进程未运行: ${err.message || String(err)}`,
            };
        }
    }
    async importAccount(email, refreshToken) {
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
        const accountDetail = {
            id,
            email: email.trim(),
            name: email.trim().split('@')[0],
            token: {
                access_token: '',
                refresh_token: refreshToken.trim(),
                expires_in: 3599,
                expiry_timestamp: now + 3599,
                token_type: 'Bearer',
                email: email.trim(),
                project_id: 'aicode-consumers',
                oauth_client_key: 'antigravity_enterprise',
                is_gcp_tos: false,
            },
            quota: null,
        };
        // 1. Write detail file
        const detailPath = path.join(accountsDir, `${id}.json`);
        fs.writeFileSync(detailPath, JSON.stringify(accountDetail, null, 2), 'utf-8');
        // 2. Update accounts.json
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
            accountsData.accounts[existingIndex].id = id;
            accountsData.accounts[existingIndex].last_used = now;
        }
        else {
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
        for (const w of this.watchers) {
            try {
                w.close();
            }
            catch { }
        }
        this.watchers = [];
    }
}
exports.AntigravityService = AntigravityService;
//# sourceMappingURL=service.js.map
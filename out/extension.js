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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const service_1 = require("./service");
const statusBar_1 = require("./statusBar");
const commands_1 = require("./commands");
let refreshTimer = null;
let currentStatus = null;
let isRefreshing = false;
let needsRefresh = false;
function activate(context) {
    const service = new service_1.AntigravityService();
    const statusBar = new statusBar_1.StatusBarController();
    // If a reload was triggered by our extension, automatically focus the Antigravity panel!
    if (context.globalState.get('antigravity.autoFocusPanelAfterReload')) {
        context.globalState.update('antigravity.autoFocusPanelAfterReload', false);
        setTimeout(async () => {
            try {
                await vscode.commands.executeCommand('antigravity.panel.focus');
            }
            catch { }
        }, 1200);
    }
    const refresh = async () => {
        // 定时器间隔可能小于 fetchStatus 耗时（CLI 慢时可达数秒），防止刷新堆叠；
        // 进行中到达的刷新不丢弃，结束后补跑一次（配额文件变动事件不丢）
        if (isRefreshing) {
            needsRefresh = true;
            return;
        }
        isRefreshing = true;
        try {
            const status = await service.fetchStatus();
            currentStatus = status;
            statusBar.update(status);
        }
        catch (err) {
            console.error('Antigravity Status fetch error:', err);
        }
        finally {
            isRefreshing = false;
            if (needsRefresh) {
                needsRefresh = false;
                refresh();
            }
        }
    };
    const commandController = new commands_1.CommandController(context, service, refresh, () => currentStatus);
    // Instant notification when quota or configuration change on disk
    service.onStatusChanged(async () => {
        await refresh();
    });
    // Auto-detect external account switches!
    service.onAccountSwitched(async (newId, email) => {
        await refresh();
        const config = vscode.workspace.getConfiguration('antigravityStatus');
        const autoReload = config.get('autoReloadOnSwitch', true);
        if (autoReload) {
            vscode.window.showInformationMessage(`[反重力监控] 检测到已切换至账号 ${email}，正在自动热重启核心进程以立即生效...`);
            await commandController.restartBackend();
        }
        else {
            const action = await vscode.window.showInformationMessage(`[反重力监控] 检测到账号已切换至 ${email}！是否立即热重启生效？(免重启 VS Code)`, '立即热重启生效', '稍后');
            if (action === '立即热重启生效') {
                await commandController.restartBackend();
            }
        }
    });
    const setupTimer = () => {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        const config = vscode.workspace.getConfiguration('antigravityStatus');
        const intervalSec = config.get('refreshIntervalSeconds', 5);
        if (intervalSec > 0) {
            refreshTimer = setInterval(() => {
                refresh();
            }, intervalSec * 1000);
        }
    };
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('antigravity-status.statusBarClicked', () => commandController.statusBarClicked()), vscode.commands.registerCommand('antigravity-status.showMenu', () => commandController.showMenu()), vscode.commands.registerCommand('antigravity-status.showDashboard', () => commandController.showDashboard()), vscode.commands.registerCommand('antigravity-status.refresh', async () => {
        // Manual refresh also triggers online cloud sync
        service.refreshCurrentAccountOnline().catch(() => { });
        await refresh();
        vscode.window.showInformationMessage('反重力状态已刷新！');
    }), vscode.commands.registerCommand('antigravity-status.reloadExtensionHost', () => commandController.reloadExtensionHost()), vscode.commands.registerCommand('antigravity-status.reloadWindow', () => vscode.commands.executeCommand('workbench.action.reloadWindow')), vscode.commands.registerCommand('antigravity-status.restartBackend', () => commandController.restartBackend()), vscode.commands.registerCommand('antigravity-status.switchAccount', () => commandController.switchAccount()), vscode.commands.registerCommand('antigravity-status.importAccount', () => commandController.importAccount()), vscode.commands.registerCommand('antigravity-status.showDetails', () => commandController.showDashboard()), statusBar, commandController, service, vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('antigravityStatus')) {
            service.updateConfig();
            setupTimer();
            refresh();
        }
    }));
    // Initial timer setup & immediate fetch
    setupTimer();
    refresh();
}
function deactivate() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}
//# sourceMappingURL=extension.js.map
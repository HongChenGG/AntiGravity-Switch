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
exports.CommandController = void 0;
const vscode = __importStar(require("vscode"));
const dashboardPanel_1 = require("./dashboardPanel");
const oauth_1 = require("./oauth");
const accountQuota_1 = require("./accountQuota");
class CommandController {
    context;
    service;
    refreshCallback;
    getLatestStatus;
    outputChannel;
    constructor(context, service, refreshCallback, getLatestStatus) {
        this.context = context;
        this.service = service;
        this.refreshCallback = refreshCallback;
        this.getLatestStatus = getLatestStatus;
        this.outputChannel = vscode.window.createOutputChannel('Google Antigravity Status');
    }
    async statusBarClicked() {
        const config = vscode.workspace.getConfiguration('antigravityStatus');
        const action = config.get('statusBarClickAction', 'dashboard');
        if (action === 'menu') {
            await this.showMenu();
        }
        else {
            this.showDashboard();
        }
    }
    showDashboard() {
        dashboardPanel_1.DashboardPanel.createOrShow(this.service, () => this.reloadExtensionHost(), () => this.restartBackend(), (targetIdOrEmail) => this.switchAccount(targetIdOrEmail), () => this.importAccount(), () => this.refreshAllQuotas());
    }
    async showMenu() {
        const status = this.getLatestStatus();
        const email = status?.account?.email ? ` (${status.account.email})` : '';
        const items = [
            {
                id: 'show-dashboard',
                label: '$(dashboard) 📊 打开高级监控仪表盘 (Advanced Dashboard)',
                description: '账号池剩余额度总览 & 一键切号、G4 识别、重置倒计时、Token 与费用看板',
            },
            {
                id: 'switch-account',
                label: `$(account) 👥 切换反重力账号 & 查看各号剩余额度${email}`,
                description: '置顶 🔥 Gemini 4 + Opus 5.5 账号，实时查看 5h/周限额与多久重置',
            },
            {
                id: 'refresh-all-quotas',
                label: '$(sync) 🔄 刷新全部账号最新剩余额度',
                description: '并发查询账号池内所有账号的 5h / 周限额与重置倒计时',
            },
            {
                id: 'refresh',
                label: '$(refresh) 🔄 刷新当前账号状态与统计',
                description: '重新获取当前激活账号配额与 Token 消耗',
            },
            {
                id: 'import-account',
                label: '$(plus) ➕ 导入账号 (OAuth Refresh Token)',
                description: '通过浏览器授权或粘贴 refresh_token 直接添加新 Google 账号',
            },
            {
                id: 'reload-ext-host',
                label: '$(sync) ⚡ 重新加载反重力插件 (Restart Extension Host)',
                description: '推荐！平滑重启扩展宿主，瞬间恢复反重力连接',
            },
            {
                id: 'restart-backend',
                label: '$(debug-restart) 🔌 强制冷重启核心后端 (Kill & Restart agy.exe)',
                description: '终止旧进程并释放端口，强制以新凭据冷拉起服务',
            },
            {
                id: 'reload-window',
                label: '$(window) 🪟 重载 VS Code 窗口 (Reload Window)',
                description: '完全重新加载编辑器界面',
            },
            {
                id: 'open-settings',
                label: '$(gear) ⚙️ 打开插件设置',
                description: '配置刷新频率、agy-switch 路径及显示格式',
            },
        ];
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要执行的反重力操作...',
        });
        if (!selected) {
            return;
        }
        switch (selected.id) {
            case 'show-dashboard':
                this.showDashboard();
                break;
            case 'refresh-all-quotas':
                await this.refreshAllQuotas();
                break;
            case 'refresh':
                this.service.refreshCurrentAccountOnline().catch(() => { });
                await this.refreshCallback();
                vscode.window.showInformationMessage('反重力状态已刷新！');
                break;
            case 'import-account':
                await this.importAccount();
                break;
            case 'switch-account':
                await this.switchAccount();
                break;
            case 'reload-ext-host':
                await this.reloadExtensionHost();
                break;
            case 'restart-backend':
                await this.restartBackend();
                break;
            case 'reload-window':
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                break;
            case 'open-settings':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityStatus');
                break;
        }
    }
    async refreshAllQuotas(options) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在刷新全部账号额度...',
            cancellable: false,
        }, async (progress) => {
            let lastCompleted = 0;
            const result = await this.service.refreshAllAccountsOnline((completed, total, email) => {
                const delta = completed - lastCompleted;
                lastCompleted = completed;
                const increment = total > 0 ? (delta / total) * 100 : 0;
                progress.report({
                    increment,
                    message: `(${completed}/${total}) ${email}`,
                });
            });
            await this.refreshCallback();
            if (!options?.reopenSwitchPicker) {
                const freshSummaries = await this.service.fetchAccountSummaries(true);
                const pool = (0, accountQuota_1.computePoolStats)(freshSummaries);
                vscode.window.showInformationMessage(`已刷新 ${result.total} 个账号额度（成功 ${result.succeeded}）：🔥 G4 可用 ${pool.usableG4}/${pool.totalG4} 个，3.8 可用 ${pool.usableGemini} 个！`);
            }
        });
        if (options?.reopenSwitchPicker) {
            await this.switchAccount();
        }
    }
    async reloadExtensionHost() {
        await this.context.globalState.update('antigravity.autoFocusPanelAfterReload', true);
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在平滑重载扩展宿主...',
            cancellable: false,
        }, async () => {
            try {
                await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
            }
            catch {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }
    async restartBackend() {
        await this.context.globalState.update('antigravity.autoFocusPanelAfterReload', true);
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在终止旧后端并重新拉起 agy.exe...',
            cancellable: false,
        }, async () => {
            // Kill backend
            await this.service.restartAgyBackend();
            // Wait 800ms for Windows socket/port to fully release
            await new Promise((r) => setTimeout(r, 800));
            // Restart extension host cleanly
            try {
                await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
            }
            catch {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }
    getSectionHeaderForAccount(acc, pool) {
        const rank = (0, accountQuota_1.sortGroupRank)(acc);
        if (rank === 0) {
            return '📌 当前激活账号';
        }
        if (rank === 1) {
            if (acc.hasGemini4) {
                return `🔥 支持 Gemini 4 + Opus 5.5 可用账号 (${pool.usableG4}/${pool.totalG4} 可用)`;
            }
            return '⚡ Gemini 3.8 + Claude 4.6 可用付费账号';
        }
        if (rank === 2) {
            return `⏳ 限流冷却中付费账号 (${pool.rateLimited} 个 · 自动显示恢复倒计时)`;
        }
        if (rank === 3) {
            return '❓ 待同步额度账号';
        }
        return '🚫 受限 / 已禁用账号';
    }
    async switchAccount(targetIdOrEmail) {
        try {
            const summaries = await this.service.fetchAccountSummaries(true);
            if (!summaries || summaries.length === 0) {
                vscode.window.showWarningMessage('未发现已配置的反重力账号。');
                return;
            }
            let switchArg = targetIdOrEmail;
            let displayEmail = targetIdOrEmail;
            if (switchArg) {
                const matched = summaries.find((a) => a.id === switchArg || a.email.toLowerCase() === switchArg.toLowerCase());
                if (matched) {
                    switchArg = matched.id;
                    displayEmail = matched.email;
                }
            }
            else {
                const pool = (0, accountQuota_1.computePoolStats)(summaries);
                const nowMs = Date.now();
                const items = [
                    {
                        isRefreshAction: true,
                        label: '$(sync) 刷新全部账号最新剩余额度',
                        description: `并发查询全部 ${pool.total} 个账号 5h/周限额、多久重置与 🔥 G4 可用状态 (当前 G4 可用 ${pool.usableG4}/${pool.totalG4} · 3.8 可用 ${pool.usableGemini})`,
                        alwaysShow: true,
                    },
                ];
                let lastSection = '';
                for (const acc of summaries) {
                    const section = this.getSectionHeaderForAccount(acc, pool);
                    if (section !== lastSection) {
                        lastSection = section;
                        items.push({
                            label: section,
                            kind: vscode.QuickPickItemKind.Separator,
                        });
                    }
                    const disp = (0, accountQuota_1.formatAccountQuickPickDisplay)(acc, nowMs);
                    items.push({
                        label: disp.label,
                        description: disp.description,
                        detail: disp.detail,
                        account: acc,
                    });
                }
                const chosen = await vscode.window.showQuickPick(items, {
                    placeHolder: '选择要切换的账号（🔥G4+Opus5.5 已置顶 | 🟢充足 🟡偏低 🔴限流冷却 ⚪免费；输入 G4 / Pro 可筛选）',
                    matchOnDescription: true,
                    matchOnDetail: true,
                });
                if (!chosen) {
                    return;
                }
                if (chosen.isRefreshAction) {
                    await this.refreshAllQuotas({ reopenSwitchPicker: true });
                    return;
                }
                if (!chosen.account) {
                    return;
                }
                if (chosen.account.isCurrent) {
                    const confirmSame = await vscode.window.showInformationMessage(`账号 ${chosen.account.email} 已是当前激活账号，是否重新同步凭据并热重载？`, '重新载入', '取消');
                    if (confirmSame !== '重新载入') {
                        return;
                    }
                }
                switchArg = chosen.account.id;
                displayEmail = chosen.account.email;
            }
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在切换至账号 ${displayEmail}...`,
                cancellable: false,
            }, async () => {
                const res = await this.service.switchAccount(switchArg);
                if (res.success) {
                    vscode.window.showInformationMessage(`账号已成功切换为 ${displayEmail}！已重新拉起新凭据。`);
                    await this.refreshCallback();
                    await this.context.globalState.update('antigravity.autoFocusPanelAfterReload', true);
                    // Wait 600ms then reload extension host
                    await new Promise((r) => setTimeout(r, 600));
                    try {
                        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
                    }
                    catch {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }
                else {
                    vscode.window.showErrorMessage(`切换账号失败: ${res.message}`);
                }
            });
        }
        catch (err) {
            vscode.window.showErrorMessage(`获取账号列表失败: ${err.message || String(err)}`);
        }
    }
    async importAccount() {
        const items = [
            {
                id: 'browser',
                label: '$(globe) 🌐 浏览器跳转 Google 登录 (一键授权 · 推荐)',
                description: '自动拉起系统浏览器进行 Google 官方 OAuth 授权，无需手动复制 Token',
            },
            {
                id: 'paste-token',
                label: '$(key) 🔑 直接填 Token / Refresh Token (免输邮箱)',
                description: '直接粘贴 1// 开头的 Refresh Token，插件将自动解析 Google 邮箱并建立凭据',
            },
            {
                id: 'paste-json',
                label: '$(json) 📋 粘贴完整 JSON 凭据',
                description: '粘贴包含 refresh_token、email 等字段的完整 JSON 格式凭据',
            },
        ];
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '请选择导入 / 登录 Google 账号的方式...',
        });
        if (!selected) {
            return;
        }
        if (selected.id === 'browser') {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '已在浏览器打开 Google 登录页，等待授权回调...',
                cancellable: false,
            }, async () => {
                try {
                    const authRes = await (0, oauth_1.loginWithGoogleBrowser)();
                    const res = await this.service.importAccount(authRes.email, authRes.refreshToken, authRes.accessToken, authRes.idToken, authRes.name);
                    if (res.success) {
                        await this.refreshCallback();
                        const action = await vscode.window.showInformationMessage(`🎉 账号 ${authRes.email} 授权成功！是否立即切换使用？`, '立即切换', '稍后切换');
                        if (action === '立即切换') {
                            await this.switchAccount(res.accountId || authRes.email);
                        }
                    }
                    else {
                        vscode.window.showErrorMessage(`导入账号失败: ${res.message}`);
                    }
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Google 登录失败: ${err.message || String(err)}`);
                }
            });
            return;
        }
        // paste-token or paste-json
        const promptText = selected.id === 'paste-token'
            ? '请粘贴 OAuth Refresh Token (以 1// 开头，将自动提取对应 Google 邮箱)'
            : '请粘贴包含 refresh_token 的完整 JSON 凭据文本';
        const rawInput = await vscode.window.showInputBox({
            title: '导入 Google Antigravity 账号 Token',
            prompt: promptText,
            placeHolder: selected.id === 'paste-token'
                ? '1//0g...'
                : '{"refresh_token": "1//...", "email": "user@gmail.com"}',
            password: selected.id === 'paste-token',
            ignoreFocusOut: true,
            validateInput: (val) => {
                if (!val || val.trim().length < 15) {
                    return 'Token 内容过短，请提供有效的凭据';
                }
                return null;
            },
        });
        if (!rawInput) {
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在校验 Token 并初始化配额...',
            cancellable: false,
        }, async () => {
            try {
                const resolved = await (0, oauth_1.resolveTokenInfo)(rawInput.trim());
                let finalEmail = resolved.email;
                if (!finalEmail) {
                    finalEmail =
                        (await vscode.window.showInputBox({
                            title: '确认账号邮箱',
                            prompt: '未能从该 Token 中自动解析出 Google 邮箱，请输入该账号邮箱',
                            placeHolder: 'user@gmail.com',
                            ignoreFocusOut: true,
                        })) || '';
                    if (!finalEmail)
                        return;
                }
                const res = await this.service.importAccount(finalEmail.trim(), resolved.refreshToken, resolved.accessToken, resolved.idToken, resolved.name);
                if (res.success) {
                    await this.refreshCallback();
                    const action = await vscode.window.showInformationMessage(`🎉 账号 ${finalEmail} 导入成功！是否立即切换使用？`, '立即切换', '稍后切换');
                    if (action === '立即切换') {
                        await this.switchAccount(res.accountId || finalEmail.trim());
                    }
                }
                else {
                    vscode.window.showErrorMessage(`导入账号失败: ${res.message}`);
                }
            }
            catch (err) {
                vscode.window.showErrorMessage(`解析 Token 失败: ${err.message || String(err)}`);
            }
        });
    }
    dispose() {
        this.outputChannel.dispose();
    }
}
exports.CommandController = CommandController;
//# sourceMappingURL=commands.js.map
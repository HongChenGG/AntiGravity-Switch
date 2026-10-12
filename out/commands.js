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
const utils_1 = require("./utils");
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
        dashboardPanel_1.DashboardPanel.createOrShow(this.service, () => this.reloadExtensionHost(), () => this.restartBackend(), () => this.switchAccount(), () => this.importAccount());
    }
    async showMenu() {
        const status = this.getLatestStatus();
        const email = status?.account?.email ? ` (${status.account.email})` : '';
        const items = [
            {
                id: 'show-dashboard',
                label: '$(dashboard) 📊 打开高级监控仪表盘 (Advanced Dashboard)',
                description: '高颜值图表看板：今日Token、费用估算、生成速度、模型明细',
            },
            {
                id: 'refresh',
                label: '$(refresh) 🔄 刷新状态与配额数据',
                description: '重新获取 5小时限额、周限额与 Token 消耗',
            },
            {
                id: 'import-account',
                label: '$(plus) ➕ 导入账号 (OAuth Refresh Token)',
                description: '通过邮箱与 refresh_token 直接添加新 Google 账号',
            },
            {
                id: 'switch-account',
                label: `$(account) 👥 切换反重力账号${email}`,
                description: '直接选择并切换已登录的 Google 账号 (免重启 VS Code)',
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
            case 'refresh':
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
    async switchAccount(targetEmail) {
        try {
            const accounts = await this.service.fetchAccountsList();
            if (!accounts || accounts.length === 0) {
                vscode.window.showWarningMessage('未发现已配置的反重力账号。');
                return;
            }
            let chosenEmail = targetEmail;
            if (!chosenEmail) {
                const items = accounts.map((acc) => {
                    const isCurrent = acc.is_current ? '【当前使用中】' : '';
                    const tier = acc.quota?.subscription_tier || 'Google AI';
                    let q5hStr = '--';
                    let qWkStr = '--';
                    if (acc.quota?.quota_groups) {
                        for (const g of acc.quota.quota_groups) {
                            if (g.display_name.includes('Gemini')) {
                                for (const b of g.buckets) {
                                    if (b.window === '5h')
                                        q5hStr = (0, utils_1.formatPercent)(b.remaining_fraction);
                                    if (b.window === 'weekly')
                                        qWkStr = (0, utils_1.formatPercent)(b.remaining_fraction);
                                }
                            }
                        }
                    }
                    return {
                        label: `$(account) ${acc.email}`,
                        description: `${isCurrent} [${tier}] ${acc.name || ''}`,
                        detail: `Gemini 5h限额: ${q5hStr} | 周限额: ${qWkStr} | ID: ${acc.id.substring(0, 8)}...`,
                        account: acc,
                    };
                });
                const chosen = await vscode.window.showQuickPick(items, {
                    placeHolder: '选择要切换的目标账号 (切换后将自动热重启生效，无需重启 VS Code)',
                });
                if (!chosen) {
                    return;
                }
                chosenEmail = chosen.account.email;
            }
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在切换至账号 ${chosenEmail}...`,
                cancellable: false,
            }, async () => {
                const res = await this.service.switchAccount(chosenEmail);
                if (res.success) {
                    vscode.window.showInformationMessage(`账号已成功切换为 ${chosenEmail}！已重新拉起新凭据。`);
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
        const email = await vscode.window.showInputBox({
            title: '导入 Google Antigravity 账号',
            prompt: '请输入 Google 账号邮箱 (例如: your-account@gmail.com)',
            placeHolder: 'user@gmail.com',
            ignoreFocusOut: true,
            validateInput: (val) => {
                if (!val || !val.includes('@')) {
                    return '请输入有效的邮箱地址';
                }
                return null;
            },
        });
        if (!email) {
            return;
        }
        const refreshToken = await vscode.window.showInputBox({
            title: '导入 Google Antigravity 账号',
            prompt: '请输入 OAuth Refresh Token (以 1// 开头)',
            placeHolder: '1//0g...',
            password: true,
            ignoreFocusOut: true,
            validateInput: (val) => {
                if (!val || val.trim().length < 10) {
                    return 'Refresh Token 格式不正确，通常以 1// 开头';
                }
                return null;
            },
        });
        if (!refreshToken) {
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `正在导入账号 ${email} 并初始化配额...`,
            cancellable: false,
        }, async () => {
            const res = await this.service.importAccount(email.trim(), refreshToken.trim());
            if (res.success) {
                await this.refreshCallback();
                const action = await vscode.window.showInformationMessage(`🎉 ${res.message} 是否立即切换至该账号？`, '立即切换', '稍后切换');
                if (action === '立即切换') {
                    await this.switchAccount(email.trim());
                }
            }
            else {
                vscode.window.showErrorMessage(`导入账号失败: ${res.message}`);
            }
        });
    }
    dispose() {
        this.outputChannel.dispose();
    }
}
exports.CommandController = CommandController;
//# sourceMappingURL=commands.js.map
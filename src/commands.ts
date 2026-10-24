import * as vscode from 'vscode';
import { AntigravityService } from './service';
import { DashboardPanel } from './dashboardPanel';
import { AntigravityStatus } from './types';
import { loginWithGoogleBrowser, resolveTokenInfo } from './oauth';
import {
  extractQuotaFamilies,
  formatDateLocal,
  formatPercent,
  formatTimeRemaining,
  formatTokens,
} from './utils';

export class CommandController {
  private outputChannel: vscode.OutputChannel;

  constructor(
    private context: vscode.ExtensionContext,
    private service: AntigravityService,
    private refreshCallback: () => Promise<void>,
    private getLatestStatus: () => AntigravityStatus | null
  ) {
    this.outputChannel = vscode.window.createOutputChannel('Google Antigravity Status');
  }

  public async statusBarClicked(): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravityStatus');
    const action = config.get<string>('statusBarClickAction', 'dashboard');
    if (action === 'menu') {
      await this.showMenu();
    } else {
      this.showDashboard();
    }
  }

  public showDashboard(): void {
    DashboardPanel.createOrShow(
      this.service,
      () => this.reloadExtensionHost(),
      () => this.restartBackend(),
      () => this.switchAccount(),
      () => this.importAccount()
    );
  }

  public async showMenu(): Promise<void> {
    const status = this.getLatestStatus();
    const email = status?.account?.email ? ` (${status.account.email})` : '';

    interface MenuQuickPickItem extends vscode.QuickPickItem {
      id: string;
    }

    const items: MenuQuickPickItem[] = [
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
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'antigravityStatus'
        );
        break;
    }
  }

  public async reloadExtensionHost(): Promise<void> {
    await this.context.globalState.update('antigravity.autoFocusPanelAfterReload', true);
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在平滑重载扩展宿主...',
        cancellable: false,
      },
      async () => {
        try {
          await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        } catch {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    );
  }

  public async restartBackend(): Promise<void> {
    await this.context.globalState.update('antigravity.autoFocusPanelAfterReload', true);
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在终止旧后端并重新拉起 agy.exe...',
        cancellable: false,
      },
      async () => {
        // Kill backend
        await this.service.restartAgyBackend();
        // Wait 800ms for Windows socket/port to fully release
        await new Promise((r) => setTimeout(r, 800));

        // Restart extension host cleanly
        try {
          await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        } catch {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    );
  }

  public async switchAccount(targetEmail?: string): Promise<void> {
    try {
      const accounts = await this.service.fetchAccountsList();
      if (!accounts || accounts.length === 0) {
        vscode.window.showWarningMessage('未发现已配置的反重力账号。');
        return;
      }

      let chosenEmail = targetEmail;

      if (!chosenEmail) {
        interface AccountPickItem extends vscode.QuickPickItem {
          account: any;
        }

        const items: AccountPickItem[] = accounts.map((acc) => {
          const isCurrent = acc.is_current ? '【当前使用中】' : '';
          const tier = acc.quota?.subscription_tier || 'Google AI';

          // 按配额族汇总（Gemini / Gemini 4 / Claude-GPT），多组不再互相覆盖
          const fams = extractQuotaFamilies(acc.quota?.quota_groups);
          const quotaBits = fams.map(
            (f) =>
              `${f.displayName} ${f.fiveHour !== null ? formatPercent(f.fiveHour) : '--'}/${
                f.weekly !== null ? formatPercent(f.weekly) : '--'
              }`
          );

          return {
            label: `$(account) ${acc.email}`,
            description: `${isCurrent} [${tier}] ${acc.name || ''}`,
            detail: `${
              quotaBits.length ? quotaBits.join(' · ') + ' (5h/周) | ' : ''
            }ID: ${acc.id.substring(0, 8)}...`,
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

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在切换至账号 ${chosenEmail}...`,
          cancellable: false,
        },
        async () => {
          const res = await this.service.switchAccount(chosenEmail!);
          if (res.success) {
            vscode.window.showInformationMessage(
              `账号已成功切换为 ${chosenEmail}！已重新拉起新凭据。`
            );
            await this.refreshCallback();

            await this.context.globalState.update('antigravity.autoFocusPanelAfterReload', true);
            // Wait 600ms then reload extension host
            await new Promise((r) => setTimeout(r, 600));
            try {
              await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
            } catch {
              await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          } else {
            vscode.window.showErrorMessage(`切换账号失败: ${res.message}`);
          }
        }
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`获取账号列表失败: ${err.message || String(err)}`);
    }
  }

  public async importAccount(): Promise<void> {
    interface ImportMethodPickItem extends vscode.QuickPickItem {
      id: 'browser' | 'paste-token' | 'paste-json';
    }

    const items: ImportMethodPickItem[] = [
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
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '已在浏览器打开 Google 登录页，等待授权回调...',
          cancellable: false,
        },
        async () => {
          try {
            const authRes = await loginWithGoogleBrowser();
            const res = await this.service.importAccount(
              authRes.email,
              authRes.refreshToken,
              authRes.accessToken,
              authRes.idToken,
              authRes.name
            );
            if (res.success) {
              await this.refreshCallback();
              const action = await vscode.window.showInformationMessage(
                `🎉 账号 ${authRes.email} 授权成功！是否立即切换使用？`,
                '立即切换',
                '稍后切换'
              );
              if (action === '立即切换') {
                await this.switchAccount(authRes.email);
              }
            } else {
              vscode.window.showErrorMessage(`导入账号失败: ${res.message}`);
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Google 登录失败: ${err.message || String(err)}`);
          }
        }
      );
      return;
    }

    // paste-token or paste-json
    const promptText =
      selected.id === 'paste-token'
        ? '请粘贴 OAuth Refresh Token (以 1// 开头，将自动提取对应 Google 邮箱)'
        : '请粘贴包含 refresh_token 的完整 JSON 凭据文本';

    const rawInput = await vscode.window.showInputBox({
      title: '导入 Google Antigravity 账号 Token',
      prompt: promptText,
      placeHolder:
        selected.id === 'paste-token'
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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在校验 Token 并初始化配额...',
        cancellable: false,
      },
      async () => {
        try {
          const resolved = await resolveTokenInfo(rawInput.trim());

          let finalEmail = resolved.email;
          if (!finalEmail) {
            finalEmail =
              (await vscode.window.showInputBox({
                title: '确认账号邮箱',
                prompt: '未能从该 Token 中自动解析出 Google 邮箱，请输入该账号邮箱',
                placeHolder: 'user@gmail.com',
                ignoreFocusOut: true,
              })) || '';
            if (!finalEmail) return;
          }

          const res = await this.service.importAccount(
            finalEmail.trim(),
            resolved.refreshToken,
            resolved.accessToken,
            resolved.idToken,
            resolved.name
          );

          if (res.success) {
            await this.refreshCallback();
            const action = await vscode.window.showInformationMessage(
              `🎉 账号 ${finalEmail} 导入成功！是否立即切换使用？`,
              '立即切换',
              '稍后切换'
            );
            if (action === '立即切换') {
              await this.switchAccount(finalEmail.trim());
            }
          } else {
            vscode.window.showErrorMessage(`导入账号失败: ${res.message}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`解析 Token 失败: ${err.message || String(err)}`);
        }
      }
    );
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}

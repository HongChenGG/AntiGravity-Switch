import * as vscode from 'vscode';
import { AntigravityService } from './service';
import { StatusBarController } from './statusBar';
import { CommandController } from './commands';
import { AntigravityStatus } from './types';

let refreshTimer: NodeJS.Timeout | null = null;
let currentStatus: AntigravityStatus | null = null;
let isRefreshing = false;
let needsRefresh = false;

export function activate(context: vscode.ExtensionContext) {
  const service = new AntigravityService();
  const statusBar = new StatusBarController();

  // If a reload was triggered by our extension, automatically focus the Antigravity panel!
  if (context.globalState.get<boolean>('antigravity.autoFocusPanelAfterReload')) {
    context.globalState.update('antigravity.autoFocusPanelAfterReload', false);
    setTimeout(async () => {
      try {
        await vscode.commands.executeCommand('antigravity.panel.focus');
      } catch {}
    }, 1200);
  }

  const refresh = async (): Promise<void> => {
    // 定时器间隔可能小于 fetchStatus 耗时（CLI 慢时可达数秒），防止刷新堆叠；
    // 进行中到达的刷新不丢弃，结束后补跑一次（配额文件变动事件不丢）
    if (isRefreshing) {
      needsRefresh = true;
      return;
    }
    isRefreshing = true;
    try {
      const [status, poolSummaries] = await Promise.all([
        service.fetchStatus(),
        service.fetchAccountSummaries(),
      ]);
      currentStatus = status;
      statusBar.update(status, poolSummaries);
    } catch (err: any) {
      console.error('Antigravity Status fetch error:', err);
    } finally {
      isRefreshing = false;
      if (needsRefresh) {
        needsRefresh = false;
        refresh();
      }
    }
  };

  const commandController = new CommandController(
    context,
    service,
    refresh,
    () => currentStatus
  );

  // Instant notification when quota or configuration change on disk
  service.onStatusChanged(async () => {
    await refresh();
  });

  // Auto-detect external account switches!
  service.onAccountSwitched(async (newId, email) => {
    await refresh();
    const config = vscode.workspace.getConfiguration('antigravityStatus');
    const autoReload = config.get<boolean>('autoReloadOnSwitch', true);

    if (autoReload) {
      vscode.window.showInformationMessage(
        `[反重力监控] 检测到已切换至账号 ${email}，正在自动热重启核心进程以立即生效...`
      );
      await commandController.restartBackend();
    } else {
      const action = await vscode.window.showInformationMessage(
        `[反重力监控] 检测到账号已切换至 ${email}！是否立即热重启生效？(免重启 VS Code)`,
        '立即热重启生效',
        '稍后'
      );
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
    const intervalSec = config.get<number>('refreshIntervalSeconds', 5);
    if (intervalSec > 0) {
      refreshTimer = setInterval(() => {
        refresh();
      }, intervalSec * 1000);
    }
  };

  // Register commands (including aliases so both antigravity-status.* and antigravity.* links work)
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-status.statusBarClicked', () =>
      commandController.statusBarClicked()
    ),
    vscode.commands.registerCommand('antigravity-status.showMenu', () =>
      commandController.showMenu()
    ),
    vscode.commands.registerCommand('antigravity-status.showDashboard', () =>
      commandController.showDashboard()
    ),
    vscode.commands.registerCommand('antigravity-status.refresh', async () => {
      // Manual refresh also triggers online cloud sync
      service.refreshCurrentAccountOnline().catch(() => {});
      await refresh();
      vscode.window.showInformationMessage('反重力状态已刷新！');
    }),
    vscode.commands.registerCommand('antigravity.refreshAllQuotas', () =>
      commandController.refreshAllQuotas()
    ),
    vscode.commands.registerCommand('antigravity-status.refreshAllQuotas', () =>
      commandController.refreshAllQuotas()
    ),
    vscode.commands.registerCommand(
      'antigravity-status.reloadExtensionHost',
      () => commandController.reloadExtensionHost()
    ),
    vscode.commands.registerCommand('antigravity-status.reloadWindow', () =>
      vscode.commands.executeCommand('workbench.action.reloadWindow')
    ),
    vscode.commands.registerCommand('antigravity-status.restartBackend', () =>
      commandController.restartBackend()
    ),
    vscode.commands.registerCommand('antigravity-status.switchAccount', () =>
      commandController.switchAccount()
    ),
    vscode.commands.registerCommand('antigravity.switchAccount', () =>
      commandController.switchAccount()
    ),
    vscode.commands.registerCommand('antigravity-status.importAccount', () =>
      commandController.importAccount()
    ),
    vscode.commands.registerCommand('antigravity-status.showDetails', () =>
      commandController.showDashboard()
    ),
    statusBar,
    commandController,
    service,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityStatus')) {
        service.updateConfig();
        setupTimer();
        refresh();
      }
    })
  );

  // Initial timer setup & immediate fetch
  setupTimer();
  refresh();
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

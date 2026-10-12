import * as vscode from 'vscode';
import { AntigravityStatus } from './types';
import {
  formatDateLocal,
  formatPercent,
  formatTimeRemaining,
  formatTokens,
} from './utils';

export class StatusBarController {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'antigravity-status.statusBarClicked';
    this.statusBarItem.text = '$(sync~spin) 反重力: 初始化...';
    this.statusBarItem.tooltip = '正在读取 Google Antigravity 状态...';
    this.statusBarItem.show();
  }

  public update(status: AntigravityStatus): void {
    const config = vscode.workspace.getConfiguration('antigravityStatus');
    const displayFormat = config.get<string>('displayFormat', 'standard');

    if (status.error && !status.account) {
      this.statusBarItem.text = '$(alert) 反重力: 未连接';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `### ⚠️ 反重力状态读取异常\n\n${status.error}\n\n*点击查看操作菜单*`
      );
      return;
    }

    // Extract quotas
    let weeklyGeminiFraction: number | null = null;
    let fiveHourGeminiFraction: number | null = null;
    let weeklyClaudeFraction: number | null = null;
    let fiveHourClaudeFraction: number | null = null;

    const quotaGroups = status.account?.quota?.quota_groups || [];
    for (const group of quotaGroups) {
      for (const bucket of group.buckets) {
        if (group.display_name.includes('Gemini')) {
          if (bucket.window === 'weekly') {
            weeklyGeminiFraction = bucket.remaining_fraction;
          } else if (bucket.window === '5h') {
            fiveHourGeminiFraction = bucket.remaining_fraction;
          }
        } else if (group.display_name.includes('Claude') || group.display_name.includes('GPT')) {
          if (bucket.window === 'weekly') {
            weeklyClaudeFraction = bucket.remaining_fraction;
          } else if (bucket.window === '5h') {
            fiveHourClaudeFraction = bucket.remaining_fraction;
          }
        }
      }
    }

    // Fallback if no quota groups
    if (fiveHourGeminiFraction === null && status.account?.quota?.models?.length) {
      const geminiModel = status.account.quota.models.find(
        (m: any) => m.quota_bucket_id === 'gemini-5h' || m.name.includes('gemini')
      );
      if (geminiModel) {
        fiveHourGeminiFraction =
          (geminiModel as any).observed_remaining_fraction ??
          geminiModel.percentage / 100;
      }
    }

    const todayTokens = formatTokens(status.stats?.today?.total_tokens ?? 0);
    const fiveHourPercentStr =
      fiveHourGeminiFraction !== null ? formatPercent(fiveHourGeminiFraction) : '--';
    const weeklyPercentStr =
      weeklyGeminiFraction !== null ? formatPercent(weeklyGeminiFraction) : '--';

    // Format text - Default prominent 5h limit as user requested
    switch (displayFormat) {
      case 'compact':
        this.statusBarItem.text = `$(sparkle) 反重力: ${fiveHourPercentStr} (5h)`;
        break;
      case '5h-only':
        this.statusBarItem.text = `$(sparkle) 反重力: ${fiveHourPercentStr} (5h) | 今日 ${todayTokens}`;
        break;
      case 'full':
        this.statusBarItem.text = `$(sparkle) 反重力: 5h ${fiveHourPercentStr} | 周 ${weeklyPercentStr} | 今日 ${todayTokens}`;
        break;
      case 'standard':
      default:
        // Default standard: 5h limit first + weekly + today tokens
        this.statusBarItem.text = `$(sparkle) 反重力: ${fiveHourPercentStr} (5h) | 周 ${weeklyPercentStr} | 今日 ${todayTokens}`;
        break;
    }

    // Warning color: based on 5h limit & weekly limit
    if (
      (fiveHourGeminiFraction !== null && fiveHourGeminiFraction <= 0.05) ||
      (weeklyGeminiFraction !== null && weeklyGeminiFraction <= 0.1)
    ) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground'
      );
    } else if (
      (fiveHourGeminiFraction !== null && fiveHourGeminiFraction <= 0.2) ||
      (weeklyGeminiFraction !== null && weeklyGeminiFraction <= 0.25)
    ) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    // Rich Tooltip
    this.statusBarItem.tooltip = this.buildTooltip(status);
  }

  private buildTooltip(status: AntigravityStatus): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown('### 🚀 Google Antigravity (反重力) 状态监控\n\n');

    // Account & Process Info
    const email = status.account?.email || '未登录/未识别';
    const tier = status.account?.quota?.subscription_tier || 'Google AI';
    const processStatus = status.isAgyRunning
      ? `🟢 运行中 (PID: ${status.agyPid ?? '自动托管'})`
      : '🔴 未检测到后台进程';

    md.appendMarkdown(`- **当前账号**: \`${email}\`\n`);
    md.appendMarkdown(`- **订阅等级**: \`${tier}\`\n`);
    md.appendMarkdown(`- **核心引擎**: \`agy.exe\` ${processStatus}\n\n`);

    // Quota details
    md.appendMarkdown('---\n');
    md.appendMarkdown('#### ⏳ 周期限额与配额 (Quotas)\n\n');

    const quotaGroups = status.account?.quota?.quota_groups;
    if (quotaGroups && quotaGroups.length > 0) {
      md.appendMarkdown('| 模型组 | 周期 | 剩余配额 | 重置时间 |\n');
      md.appendMarkdown('| :--- | :--- | :--- | :--- |\n');
      for (const group of quotaGroups) {
        for (const bucket of group.buckets) {
          const windowLabel =
            bucket.window === 'weekly'
              ? '周限额 (Weekly)'
              : bucket.window === '5h'
              ? '5小时限额 (5-Hour)'
              : `${bucket.window} 限额`;
          const remaining = `**${formatPercent(bucket.remaining_fraction)}**`;
          const resetHuman = formatTimeRemaining(bucket.reset_time);
          const resetLocal = formatDateLocal(bucket.reset_time);
          md.appendMarkdown(
            `| ${group.display_name} | ${windowLabel} | ${remaining} | ${resetHuman} (${resetLocal}) |\n`
          );
        }
      }
      md.appendMarkdown('\n');
    } else if (status.account?.quota?.models?.length) {
      md.appendMarkdown('| 模型 | 剩余百分比 | 重置时间 |\n');
      md.appendMarkdown('| :--- | :--- | :--- |\n');
      for (const m of status.account.quota.models.slice(0, 6)) {
        md.appendMarkdown(
          `| ${m.name} | **${m.percentage}%** | ${formatTimeRemaining(m.reset_time)} |\n`
        );
      }
      md.appendMarkdown('\n');
    }

    // Token statistics
    md.appendMarkdown('---\n');
    md.appendMarkdown('#### 📊 Token 消耗统计 (Token Usage)\n\n');

    if (status.stats?.today) {
      const today = status.stats.today;
      const todayTotal = formatTokens(today.total_tokens);
      const input = formatTokens(today.input_tokens);
      const output = formatTokens(today.output_tokens);
      const cached = formatTokens(today.cached_tokens);
      const reqCount = today.request_count.toLocaleString();

      md.appendMarkdown(`- **今日总消耗**: \`${todayTotal} tokens\` (共 \`${reqCount}\` 次请求)\n`);
      md.appendMarkdown(`  - 📤 输入 (Input): \`${input}\`\n`);
      md.appendMarkdown(`  - 📥 输出 (Output): \`${output}\`\n`);
      md.appendMarkdown(`  - ⚡ 缓存节省 (Cached): \`${cached}\`\n`);
    }

    if (status.stats?.last_7_days) {
      const l7 = status.stats.last_7_days;
      const l7Total = formatTokens(l7.total_tokens);
      const l7Req = l7.request_count.toLocaleString();
      md.appendMarkdown(`- **近 7 天总计**: \`${l7Total} tokens\` (共 \`${l7Req}\` 次请求)\n`);
    }

    if (status.stats?.recent_performance) {
      const perf = status.stats.recent_performance;
      const tps = perf.body_tokens_per_second ? perf.body_tokens_per_second.toFixed(1) : '--';
      const ttft = perf.first_text_seconds ? perf.first_text_seconds.toFixed(2) : '--';
      md.appendMarkdown(`- **生成性能**: \`${tps} tokens/s\` | 首字延迟: \`${ttft}s\`\n`);
    }

    md.appendMarkdown('\n---\n');
    const updateTimeStr = formatDateLocal(status.lastUpdated.toISOString());
    md.appendMarkdown(`*更新时间: ${updateTimeStr}*\n\n`);
    md.appendMarkdown(
      `👉 [📊 高级仪表盘](command:antigravity-status.showDashboard) &nbsp;|&nbsp; ` +
      `[⚡ 热重载插件](command:antigravity-status.reloadExtensionHost) &nbsp;|&nbsp; ` +
      `[👥 切换账号](command:antigravity-status.switchAccount) &nbsp;|&nbsp; ` +
      `[➕ 导入账号](command:antigravity-status.importAccount) &nbsp;|&nbsp; ` +
      `[⚙️ 菜单](command:antigravity-status.showMenu)`
    );

    return md;
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}

import * as vscode from 'vscode';
import { AccountSummary, AntigravityStatus, QuotaFamily } from './types';
import {
  computePoolStats,
  normalizeQuotaGroups,
  summarizeAccount,
} from './accountQuota';
import {
  extractQuotaFamilies,
  formatDateLocal,
  formatPercent,
  formatTimeRemaining,
  formatTokens,
  isGemini4ModelName,
  pickGemini4Family,
  pickPrimaryGeminiFamily,
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

  public update(status: AntigravityStatus, poolSummaries?: AccountSummary[]): void {
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

    // 按配额族归纳（Gemini / Gemini 4 / Claude-GPT），多组不再互相覆盖
    const families = extractQuotaFamilies(status.account?.quota?.quota_groups);
    const primary = pickPrimaryGeminiFamily(families);
    const gemini4 = pickGemini4Family(families);
    const currentSummary = status.account ? summarizeAccount(status.account) : null;

    // 模型级兜底：Google 尚未拆分 G4 独立配额组、但 models 里出现 gemini-4 条目时，
    // 用该模型的剩余百分比展示 G4
    let g4ModelFraction: number | null = null;
    if (!gemini4 && status.account?.quota?.models?.length) {
      const g4Model = status.account.quota.models.find((m) => isGemini4ModelName(m.name));
      if (g4Model) {
        g4ModelFraction =
          g4Model.observed_remaining_fraction ?? g4Model.percentage / 100;
      }
    }

    let fiveHourGeminiFraction = primary?.fiveHour ?? null;
    let weeklyGeminiFraction = primary?.weekly ?? null;

    // 无 quota_groups 时（例如 GCP Standard 账号），利用 summarizeAccount 优先提取 3.8 模型配额
    if (
      fiveHourGeminiFraction === null &&
      weeklyGeminiFraction === null &&
      currentSummary
    ) {
      if (currentSummary.gemini5hPct !== null) {
        fiveHourGeminiFraction = currentSummary.gemini5hPct / 100;
      }
      if (currentSummary.geminiWeeklyPct !== null) {
        weeklyGeminiFraction = currentSummary.geminiWeeklyPct / 100;
      }
    }

    const todayTokens = formatTokens(status.stats?.today?.total_tokens ?? 0);
    const fiveHourPercentStr =
      fiveHourGeminiFraction !== null ? formatPercent(fiveHourGeminiFraction) : '--';
    const weeklyPercentStr =
      weeklyGeminiFraction !== null ? formatPercent(weeklyGeminiFraction) : '--';

    // Gemini 4 追加段（仅当与基础 Gemini 并存时；5h/周 顺序与前文一致）
    // 优先独立配额族；无独立族时回退模型级百分比（仅 5h 数字）
    const g4Five = gemini4 ? gemini4.fiveHour : g4ModelFraction;
    const g4Weekly = gemini4 ? gemini4.weekly : null;
    const g4Compact =
      primary?.key === 'gemini' && g4Five !== null
        ? ` | G4${(g4Weekly !== null ? g4Weekly : g4Five) <= 0.1 ? '⚠' : ''} ${formatPercent(g4Five)}${
            g4Weekly !== null ? `/${formatPercent(g4Weekly)}` : ''
          }`
        : '';
    const g4Full =
      primary?.key === 'gemini' && (g4Five !== null || g4Weekly !== null)
        ? ` | G4 5h ${formatPercent(g4Five)} | G4 周 ${formatPercent(g4Weekly)}`
        : '';

    // 若只有 Gemini 4 配额组（无基础组），直接以 G4 为主显数据
    const label = primary?.key === 'gemini-4' ? '反重力G4' : '反重力';

    switch (displayFormat) {
      case 'compact':
        this.statusBarItem.text = `$(sparkle) ${label}: ${fiveHourPercentStr} (5h)${g4Compact}`;
        break;
      case '5h-only':
        this.statusBarItem.text = `$(sparkle) ${label}: ${fiveHourPercentStr} (5h)${g4Compact} | 今日 ${todayTokens}`;
        break;
      case 'full':
        this.statusBarItem.text = `$(sparkle) ${label}: 5h ${fiveHourPercentStr} | 周 ${weeklyPercentStr}${g4Full} | 今日 ${todayTokens}`;
        break;
      case 'standard':
      default:
        this.statusBarItem.text = `$(sparkle) ${label}: ${fiveHourPercentStr} (5h) | 周 ${weeklyPercentStr}${g4Compact} | 今日 ${todayTokens}`;
        break;
    }

    // 预警配色：基础 Gemini 与 Gemini 4 任一族触线即告警（同时覆盖 models-only 账号）
    const watched: QuotaFamily[] = [];
    if (primary) {
      watched.push(primary);
    } else if (fiveHourGeminiFraction !== null || weeklyGeminiFraction !== null) {
      watched.push({
        key: 'gemini',
        displayName: 'Gemini',
        fiveHour: fiveHourGeminiFraction,
        weekly: weeklyGeminiFraction,
      });
    }
    // 注意：Gemini 4 Argon 是独立周池，不参与底色告警（否则 G4 余量低会让整条状态栏常红，
    // 而显示的 3.8 数字明明充足）；G4 偏低时仅在文字后加 ⚠ 提示。

    const anyLow = watched.some(
      (f) =>
        (f.fiveHour !== null && f.fiveHour <= 0.05) ||
        (f.weekly !== null && f.weekly <= 0.1)
    );
    const anyWarn = watched.some(
      (f) =>
        (f.fiveHour !== null && f.fiveHour <= 0.2) ||
        (f.weekly !== null && f.weekly <= 0.25)
    );

    if (anyLow) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground'
      );
    } else if (anyWarn) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.tooltip = this.buildTooltip(
      status,
      families,
      currentSummary,
      poolSummaries
    );
  }

  private buildTooltip(
    status: AntigravityStatus,
    families: QuotaFamily[],
    currentSummary: AccountSummary | null,
    poolSummaries?: AccountSummary[]
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown('### 🚀 Google Antigravity (反重力) 状态监控\n\n');

    const email = status.account?.email || '未登录/未识别';
    const rawTier = status.account?.quota?.subscription_tier;
    const tierLabel = rawTier
      ? `${rawTier}${
          currentSummary?.capabilityTags.length
            ? ` (${currentSummary.capabilityTags.join(' · ')})`
            : ''
        }`
      : currentSummary
      ? `${currentSummary.tierDisplay}${
          currentSummary.capabilityTags.length
            ? ` (${currentSummary.capabilityTags.join(' · ')})`
            : ''
        }`
      : 'Google AI';
    const processStatus = status.isAgyRunning
      ? `🟢 运行中 (PID: ${status.agyPid ?? '自动托管'})`
      : '🔴 未检测到后台进程';

    md.appendMarkdown(`- **当前账号**: \`${email}\`\n`);
    md.appendMarkdown(`- **订阅等级**: \`${tierLabel}\`\n`);
    md.appendMarkdown(`- **核心引擎**: \`agy.exe\` ${processStatus}\n`);

    // 账号池整体剩余可用概览
    if (poolSummaries && poolSummaries.length > 0) {
      const pool = computePoolStats(poolSummaries);
      const coolingBit = pool.rateLimited > 0 ? ` · 限流冷却 \`${pool.rateLimited}\`` : '';
      md.appendMarkdown(
        `- **账号池余量**: 总计 \`${pool.total}\` · **3.8 可用** \`${pool.usableGemini}\` · **G4 可用** \`${pool.usableG4}\`${coolingBit}\n`
      );
    }
    md.appendMarkdown('\n');

    // 配额族摘要（含 Gemini 4 与重置倒计时）
    for (const f of families) {
      if (f.key === 'claude-gpt') {
        continue;
      }
      const r5 = f.fiveHourReset ? ` (${formatTimeRemaining(f.fiveHourReset)}重置)` : '';
      const rw = f.weeklyReset ? ` (${formatTimeRemaining(f.weeklyReset)}重置)` : '';
      md.appendMarkdown(
        `- **${f.displayName}**: 5h \`${formatPercent(f.fiveHour)}\`${r5} · 周 \`${formatPercent(
          f.weekly
        )}\`${rw}\n`
      );
    }
    if (families.some((f) => f.key !== 'claude-gpt')) {
      md.appendMarkdown('\n');
    } else if (currentSummary && currentSummary.effectiveGeminiPct !== null) {
      const rStr = currentSummary.geminiResetTime
        ? ` (${formatTimeRemaining(currentSummary.geminiResetTime)}重置)`
        : '';
      md.appendMarkdown(
        `- **Gemini 3.8**: 可用 \`${currentSummary.effectiveGeminiPct}%\`${rStr}\n\n`
      );
    }

    // Quota details
    md.appendMarkdown('---\n');
    md.appendMarkdown('#### ⏳ 周期限额与配额 (Quotas)\n\n');

    const quotaGroups = normalizeQuotaGroups(status.account?.quota?.quota_groups);
    if (quotaGroups.length > 0) {
      md.appendMarkdown('| 模型组 | 周期 | 剩余配额 | 多久重置 |\n');
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
      md.appendMarkdown('| 模型 | 剩余百分比 | 多久重置 |\n');
      md.appendMarkdown('| :--- | :--- | :--- |\n');
      for (const m of status.account.quota.models.slice(0, 6)) {
        const resetLocal = formatDateLocal(m.reset_time);
        md.appendMarkdown(
          `| ${m.name} | **${m.percentage}%** | ${formatTimeRemaining(m.reset_time)}${
            resetLocal ? ` (${resetLocal})` : ''
          } |\n`
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

      md.appendMarkdown(
        `- **今日总消耗**: \`${todayTotal} tokens\` (共 \`${reqCount}\` 次请求)\n`
      );
      md.appendMarkdown(`  - 📤 输入 (Input): \`${input}\`\n`);
      md.appendMarkdown(`  - 📥 输出 (Output): \`${output}\`\n`);
      md.appendMarkdown(`  - ⚡ 缓存节省 (Cached): \`${cached}\`\n`);
    }

    if (status.stats?.last_7_days) {
      const l7 = status.stats.last_7_days;
      const l7Total = formatTokens(l7.total_tokens);
      const l7Req = l7.request_count.toLocaleString();
      md.appendMarkdown(
        `- **近 7 天总计**: \`${l7Total} tokens\` (共 \`${l7Req}\` 次请求)\n`
      );
    }

    if (status.stats?.recent_performance) {
      const perf = status.stats.recent_performance;
      const tps = perf.body_tokens_per_second
        ? perf.body_tokens_per_second.toFixed(1)
        : '--';
      const ttft = perf.first_text_seconds ? perf.first_text_seconds.toFixed(2) : '--';
      md.appendMarkdown(`- **生成性能**: \`${tps} tokens/s\` | 首字延迟: \`${ttft}s\`\n`);
    }

    md.appendMarkdown('\n---\n');
    const updateTimeStr = formatDateLocal(status.lastUpdated.toISOString());
    md.appendMarkdown(`*更新时间: ${updateTimeStr}*\n\n`);
    md.appendMarkdown(
      `👉 [📊 高级仪表盘](command:antigravity-status.showDashboard) &nbsp;|&nbsp; ` +
        `[$(arrow-swap) 切换账号](command:antigravity.switchAccount) &nbsp;|&nbsp; ` +
        `[$(sync) 刷新全池额度](command:antigravity.refreshAllQuotas) &nbsp;|&nbsp; ` +
        `[⚡ 热重载](command:antigravity-status.reloadExtensionHost) &nbsp;|&nbsp; ` +
        `[➕ 导入](command:antigravity-status.importAccount) &nbsp;|&nbsp; ` +
        `[⚙️ 菜单](command:antigravity-status.showMenu)`
    );

    return md;
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}

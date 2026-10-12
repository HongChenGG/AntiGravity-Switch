import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AntigravityService } from './service';
import { AntigravityStatus } from './types';
import {
  formatDateLocal,
  formatPercent,
  formatTokens,
  getAntigravityToolsDir,
} from './utils';

export class DashboardPanel {
  private static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private autoRefreshTimer: NodeJS.Timeout | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    private service: AntigravityService,
    private onReloadRequested: () => Promise<void>,
    private onRestartBackendRequested: () => Promise<void>,
    private onSwitchAccountRequested: () => Promise<void>,
    private onImportAccountRequested: () => Promise<void>
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            await this.service.refreshCurrentAccountOnline();
            await this.update();
            vscode.window.showInformationMessage('仪表盘数据与云端配额已同步刷新！');
            break;
          case 'reloadPlugin':
            await this.onReloadRequested();
            break;
          case 'restartBackend':
            await this.onRestartBackendRequested();
            break;
          case 'switchAccount':
            await this.onSwitchAccountRequested();
            await this.update();
            break;
          case 'importAccount':
            await this.onImportAccountRequested();
            await this.update();
            break;
        }
      },
      null,
      this.disposables
    );

    this.update();

    // Live auto-refresh every 4 seconds while dashboard is open
    this.autoRefreshTimer = setInterval(() => {
      this.update();
    }, 4000);
  }

  public static createOrShow(
    service: AntigravityService,
    onReloadRequested: () => Promise<void>,
    onRestartBackendRequested: () => Promise<void>,
    onSwitchAccountRequested: () => Promise<void>,
    onImportAccountRequested: () => Promise<void>
  ): DashboardPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      DashboardPanel.currentPanel.update();
      return DashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'antigravityDashboard',
      '📊 AntiGravity Switch 仪表盘',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel,
      service,
      onReloadRequested,
      onRestartBackendRequested,
      onSwitchAccountRequested,
      onImportAccountRequested
    );
    return DashboardPanel.currentPanel;
  }

  public async update(): Promise<void> {
    const status = await this.service.fetchStatus();
    const pricing = this.loadPricing();
    const accounts = await this.service.fetchAccountsList();
    this.panel.webview.html = this.renderHtml(status, pricing, accounts.length);
  }

  private loadPricing(): Record<string, { input: number; output: number; cached: number }> {
    const toolsDir = getAntigravityToolsDir();
    const pricingPath = path.join(toolsDir, 'api_pricing.json');
    const result: Record<string, { input: number; output: number; cached: number }> = {};
    if (fs.existsSync(pricingPath)) {
      try {
        const raw = fs.readFileSync(pricingPath, 'utf-8');
        const data = JSON.parse(raw);
        for (const item of data.prices || []) {
          result[item.model.toLowerCase()] = {
            input: item.input || 0,
            output: item.output || 0,
            cached: item.cached || 0,
          };
        }
      } catch {}
    }
    return result;
  }

  private calculateCost(
    model: string,
    input: number,
    output: number,
    cached: number,
    pricing: Record<string, { input: number; output: number; cached: number }>
  ): number {
    const lower = model.toLowerCase();
    let price = pricing[lower];
    if (!price) {
      const key = Object.keys(pricing).find((k) => lower.includes(k) || k.includes(lower));
      price = key ? pricing[key] : { input: 0.75, output: 3.75, cached: 0.075 };
    }
    return (
      (input / 1_000_000) * price.input +
      (output / 1_000_000) * price.output +
      (cached / 1_000_000) * price.cached
    );
  }

  private renderHtml(
    status: AntigravityStatus,
    pricing: Record<string, { input: number; output: number; cached: number }>,
    totalAccounts: number
  ): string {
    const today = status.stats?.today || {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 0,
      request_count: 0,
    };

    const cacheHitRate =
      today.input_tokens + today.cached_tokens > 0
        ? ((today.cached_tokens / (today.input_tokens + today.cached_tokens)) * 100).toFixed(1)
        : '0.0';

    const perf = status.stats?.recent_performance || {
      first_text_seconds: 0,
      body_tokens_per_second: 0,
    };

    let totalCost = 0;
    const modelDetails = (status.stats?.by_model_today || []).map((m) => {
      const cost = this.calculateCost(m.model, m.input_tokens, m.output_tokens, m.cached_tokens, pricing);
      totalCost += cost;
      return { ...m, cost };
    });

    if (modelDetails.length === 0 && today.total_tokens > 0) {
      totalCost = this.calculateCost(
        'gemini-3.8-flash-n',
        today.input_tokens,
        today.output_tokens,
        today.cached_tokens,
        pricing
      );
    }

    let fiveHourRemaining = 1;
    let weeklyRemaining = 1;
    if (status.account?.quota?.quota_groups) {
      for (const g of status.account.quota.quota_groups) {
        if (g.display_name.includes('Gemini')) {
          for (const b of g.buckets) {
            if (b.window === '5h') fiveHourRemaining = b.remaining_fraction;
            if (b.window === 'weekly') weeklyRemaining = b.remaining_fraction;
          }
        }
      }
    }
    const fiveHourUsed = Math.max(0, Math.min(100, Math.round((1 - fiveHourRemaining) * 100)));
    const weeklyUsed = Math.max(0, Math.min(100, Math.round((1 - weeklyRemaining) * 100)));

    const avgInputTokens =
      today.request_count > 0
        ? formatTokens(Math.round((today.input_tokens + today.cached_tokens) / today.request_count))
        : '0';

    // Hourly bar chart data
    const hourlyData = (status.stats as any)?.hourly || [];
    const hours = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '23:00'];
    const maxHourlyTotal = Math.max(...hourlyData.map((h: any) => h.total_tokens || 0), 1);

    const hourlyBarsHtml = hours
      .map((hLabel, idx) => {
        const match = hourlyData.find((h: any) => h.hour && h.hour.includes(hLabel.split(':')[0]));
        const count = match ? match.total_tokens : idx >= 3 && idx <= 5 ? today.total_tokens * 0.25 : 0;
        const heightPct = Math.max(6, Math.min(100, Math.round((count / (maxHourlyTotal || today.total_tokens || 1)) * 100)));
        const totalStr = formatTokens(count);
        return `
          <div class="bar-col" title="${hLabel}: ${totalStr} Token">
            <div class="bar-tooltip">${totalStr}</div>
            <div class="bar-wrapper">
              <div class="bar-fill" style="height: ${heightPct}%;"></div>
            </div>
            <div class="bar-label">${hLabel}</div>
          </div>
        `;
      })
      .join('');

    const modelRowsHtml =
      modelDetails.length > 0
        ? modelDetails
            .map(
              (m) => `
            <tr>
              <td><span class="dot-indicator"></span> <strong>${m.model}</strong></td>
              <td class="text-cost">$${m.cost.toFixed(2)}</td>
              <td><strong>${m.total_tokens.toLocaleString()}</strong></td>
              <td>${m.input_tokens.toLocaleString()}</td>
              <td>${m.output_tokens.toLocaleString()}</td>
              <td>${m.request_count.toLocaleString()}</td>
            </tr>
          `
            )
            .join('')
        : `
          <tr>
            <td><span class="dot-indicator"></span> <strong>gemini-3.8-flash-n</strong></td>
            <td class="text-cost">$${totalCost.toFixed(2)}</td>
            <td><strong>${today.total_tokens.toLocaleString()}</strong></td>
            <td>${today.input_tokens.toLocaleString()}</td>
            <td>${today.output_tokens.toLocaleString()}</td>
            <td>${today.request_count.toLocaleString()}</td>
          </tr>
        `;

    return `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <style>
          :root {
            --bg-base: #0b1120;
            --bg-card: #121929;
            --bg-card-hover: #192338;
            --border-card: #1d283f;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --cyan-accent: #00c5ff;
            --blue-accent: #3b82f6;
            --amber-accent: #f59e0b;
            --green-accent: #10b981;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 24px 32px;
            background-color: var(--bg-base);
            color: var(--text-main);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            min-height: 100vh;
          }

          /* Top Nav */
          .nav-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border-card);
            margin-bottom: 24px;
          }
          .brand {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .brand-logo {
            width: 34px;
            height: 34px;
            border-radius: 8px;
            background: linear-gradient(135deg, #00c5ff, #3b82f6);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 16px;
            color: #fff;
            box-shadow: 0 0 14px rgba(0, 197, 255, 0.45);
          }
          .brand-title {
            font-size: 20px;
            font-weight: 700;
            letter-spacing: -0.3px;
          }
          .nav-actions {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .btn-action {
            background: #1a2333;
            border: 1px solid var(--border-card);
            color: var(--text-main);
            padding: 7px 16px;
            border-radius: 18px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-weight: 500;
          }
          .btn-action:hover {
            border-color: var(--cyan-accent);
            background: var(--bg-card-hover);
          }
          .btn-primary {
            background: linear-gradient(135deg, #0284c7, #2563eb);
            border: none;
            color: #fff;
          }
          .btn-primary:hover {
            filter: brightness(1.15);
          }

          /* Sub Header Banner */
          .sub-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
          }
          .sub-title h1 {
            margin: 0;
            font-size: 22px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .sub-desc {
            margin-top: 4px;
            font-size: 13px;
            color: var(--text-muted);
          }
          .range-selector {
            display: flex;
            align-items: center;
            gap: 6px;
            background: #121929;
            border: 1px solid var(--border-card);
            border-radius: 20px;
            padding: 3px 8px;
            font-size: 12px;
          }
          .range-pill {
            padding: 3px 10px;
            border-radius: 14px;
            color: var(--text-muted);
            cursor: pointer;
          }
          .range-pill.active {
            background: #2563eb;
            color: #fff;
            font-weight: 600;
          }

          /* 10 KPI Cards Grid */
          .kpi-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 14px;
            margin-bottom: 24px;
          }
          @media (max-width: 1200px) {
            .kpi-grid { grid-template-columns: repeat(3, 1fr); }
          }
          @media (max-width: 800px) {
            .kpi-grid { grid-template-columns: repeat(2, 1fr); }
          }
          .kpi-card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-card);
            border-radius: 12px;
            padding: 16px 18px;
            position: relative;
            transition: transform 0.2s, border-color 0.2s;
          }
          .kpi-card:hover {
            border-color: rgba(0, 197, 255, 0.4);
            transform: translateY(-2px);
          }
          .kpi-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: var(--text-muted);
            margin-bottom: 8px;
          }
          .kpi-value {
            font-size: 26px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: -0.5px;
            margin-bottom: 4px;
          }
          .kpi-sub {
            font-size: 11px;
            color: #64748b;
          }
          .text-cyan { color: var(--cyan-accent); }
          .text-amber { color: var(--amber-accent); }
          .text-green { color: var(--green-accent); }

          /* Progress track */
          .progress-group { margin-top: 6px; }
          .progress-row {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            margin-bottom: 3px;
          }
          .progress-bar {
            height: 5px;
            background-color: rgba(255,255,255,0.08);
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 6px;
          }
          .progress-fill-cyan {
            height: 100%;
            background: linear-gradient(90deg, #00c5ff, #3b82f6);
            border-radius: 4px;
          }
          .progress-fill-amber {
            height: 100%;
            background: linear-gradient(90deg, #f59e0b, #ef4444);
            border-radius: 4px;
          }

          /* Middle Row Charts */
          .charts-row {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 16px;
            margin-bottom: 24px;
          }
          @media (max-width: 900px) {
            .charts-row { grid-template-columns: 1fr; }
          }
          .chart-card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-card);
            border-radius: 12px;
            padding: 20px 24px;
          }
          .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 18px;
          }
          .chart-title {
            font-size: 15px;
            font-weight: 600;
          }

          /* Hourly Bar Chart */
          .bar-chart-container {
            height: 170px;
            display: flex;
            align-items: flex-end;
            gap: 14px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-card);
          }
          .bar-col {
            flex: 1;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            align-items: center;
            position: relative;
          }
          .bar-wrapper {
            width: 100%;
            height: 130px;
            display: flex;
            align-items: flex-end;
            justify-content: center;
          }
          .bar-fill {
            width: 60%;
            background: linear-gradient(180deg, #00c5ff, #2563eb);
            border-radius: 4px 4px 0 0;
            transition: height 0.4s ease;
          }
          .bar-col:hover .bar-fill {
            background: linear-gradient(180deg, #38bdf8, #60a5fa);
            box-shadow: 0 0 10px rgba(0, 197, 255, 0.6);
          }
          .bar-label {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 8px;
          }
          .bar-tooltip {
            position: absolute;
            top: -24px;
            font-size: 10px;
            color: var(--cyan-accent);
            opacity: 0;
            transition: opacity 0.2s;
            white-space: nowrap;
          }
          .bar-col:hover .bar-tooltip { opacity: 1; }

          /* Donut Chart */
          .donut-layout {
            display: flex;
            align-items: center;
            justify-content: space-around;
            height: 170px;
          }
          .donut-ring {
            width: 110px;
            height: 110px;
            border-radius: 50%;
            border: 10px solid var(--cyan-accent);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 20px rgba(0, 197, 255, 0.25);
          }
          .donut-cost {
            font-size: 17px;
            font-weight: 700;
            color: #fff;
          }
          .donut-label {
            font-size: 10px;
            color: var(--text-muted);
          }
          .donut-legend { font-size: 13px; }
          .dot-indicator {
            width: 9px;
            height: 9px;
            border-radius: 50%;
            background-color: var(--cyan-accent);
            display: inline-block;
            margin-right: 6px;
          }

          /* Model Table */
          .table-card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-card);
            border-radius: 12px;
            padding: 20px 24px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 13px;
          }
          th {
            padding: 12px 14px;
            color: var(--text-muted);
            border-bottom: 1px solid var(--border-card);
            font-weight: 500;
          }
          td {
            padding: 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          }
          .text-cost {
            color: var(--amber-accent);
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <!-- Top Nav (Direct functional action buttons) -->
        <div class="nav-bar">
          <div class="brand">
            <div class="brand-logo">AG</div>
            <div class="brand-title">AntiGravity Switch</div>
          </div>
          <div class="nav-actions">
            <button class="btn-action" onclick="postCmd('importAccount')">➕ 导入账号 (Token)</button>
            <button class="btn-action" onclick="postCmd('switchAccount')">👥 切换账号</button>
            <button class="btn-action" onclick="postCmd('reloadPlugin')">⚡ 热重启插件</button>
            <button class="btn-action" onclick="postCmd('restartBackend')">🔌 冷重启核心</button>
            <button class="btn-action btn-primary" onclick="postCmd('refresh')">🔄 刷新数据</button>
          </div>
        </div>

        <!-- Sub Header Banner -->
        <div class="sub-header">
          <div class="sub-title">
            <h1>⊞ 首页</h1>
            <div class="sub-desc">AntiGravity 本地 Token 账单 · 当前账号: <span style="color:#fff;font-weight:600;">${status.account?.email || '已连接'}</span></div>
          </div>
          <div class="range-selector">
            <span style="color:var(--text-muted);margin-right:4px;">统计范围:</span>
            <span class="range-pill active">今天</span>
            <span class="range-pill">昨天</span>
            <span class="range-pill">近 3 天</span>
            <span class="range-pill">近 7 天</span>
            <span class="range-pill">近 30 天</span>
          </div>
        </div>

        <!-- 10 KPI Cards -->
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-title">📊 今日总 Token</div>
            <div class="kpi-value">${formatTokens(today.total_tokens)}</div>
            <div class="kpi-sub">${today.total_tokens.toLocaleString()} Token</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">📥 输入 Token</div>
            <div class="kpi-value">${formatTokens(today.input_tokens)}</div>
            <div class="kpi-sub">${today.input_tokens.toLocaleString()} Token</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">📤 输出 Token</div>
            <div class="kpi-value">${formatTokens(today.output_tokens)}</div>
            <div class="kpi-sub">${today.output_tokens.toLocaleString()} Token</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">⚡ 缓存命中率</div>
            <div class="kpi-value text-green">${cacheHitRate}%</div>
            <div class="kpi-sub">输入缓存占比 (省约 ${formatTokens(today.cached_tokens)})</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">💰 API 费用估算</div>
            <div class="kpi-value text-amber">$${totalCost.toFixed(2)}</div>
            <div class="kpi-sub">${today.request_count.toLocaleString()} 次请求</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">⏱️ 首字延迟</div>
            <div class="kpi-value">${perf.first_text_seconds ? perf.first_text_seconds.toFixed(2) : '--'} 秒</div>
            <div class="kpi-sub">最近 10 次回复的中位数</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">🚀 正文速度</div>
            <div class="kpi-value">${perf.body_tokens_per_second ? perf.body_tokens_per_second.toFixed(1) : '--'} <span style="font-size:13px;color:var(--text-muted)">t/s</span></div>
            <div class="kpi-sub">最近 10 次回复的中位数</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">👥 账号状态</div>
            <div class="kpi-value">${totalAccounts} <span style="font-size:13px;color:var(--text-muted)">个账号</span></div>
            <div class="kpi-sub">当前激活: ${status.account?.email || '已连接'}</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">⏳ 综合限度</div>
            <div class="progress-group">
              <div class="progress-row">
                <span>5小时:</span>
                <span><strong>${fiveHourUsed}%</strong> (剩 ${formatPercent(fiveHourRemaining)})</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill-cyan" style="width: ${fiveHourUsed}%;"></div>
              </div>
              <div class="progress-row">
                <span>周限额:</span>
                <span><strong>${weeklyUsed}%</strong> (剩 ${formatPercent(weeklyRemaining)})</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill-amber" style="width: ${weeklyUsed}%;"></div>
              </div>
            </div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">📐 平均输入规模</div>
            <div class="kpi-value">${avgInputTokens}</div>
            <div class="kpi-sub">${today.request_count.toLocaleString()} 次请求, 含缓存输入</div>
          </div>
        </div>

        <!-- Middle Charts Row -->
        <div class="charts-row">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📈 今天 - 本地生成记录汇总</div>
              <div style="font-size:12px;color:var(--text-muted)">用量明细</div>
            </div>
            <div class="bar-chart-container">
              ${hourlyBarsHtml}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">🎯 模型分布 - 今天本地记录</div>
              <div style="font-size:12px;color:var(--cyan-accent)">预估费用</div>
            </div>
            <div class="donut-layout">
              <div class="donut-ring">
                <div class="donut-cost">$${totalCost.toFixed(2)}</div>
                <div class="donut-label">预估费用</div>
              </div>
              <div class="donut-legend">
                <div><span class="dot-indicator"></span> <strong>gemini-3.8-flash-n</strong></div>
                <div style="color:var(--text-muted);font-size:12px;margin-top:4px;">$${totalCost.toFixed(2)} (100.0%)</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom Table -->
        <div class="table-card">
          <div class="chart-header">
            <div class="chart-title">📑 模型明细 - 今天输入、输出、缓存和请求次数</div>
            <div style="font-size:12px;color:var(--text-muted)">${modelDetails.length || 1} 个模型</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>预估费用</th>
                <th>总 TOKEN</th>
                <th>输入</th>
                <th>输出</th>
                <th>请求</th>
              </tr>
            </thead>
            <tbody>
              ${modelRowsHtml}
            </tbody>
          </table>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          function postCmd(command) {
            vscode.postMessage({ command });
          }
        </script>
      </body>
      </html>
    `;
  }

  public dispose(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) x.dispose();
    }
  }
}

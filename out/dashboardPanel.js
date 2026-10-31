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
exports.DashboardPanel = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const utils_1 = require("./utils");
const dashboardAccountPool_1 = require("./dashboardAccountPool");
const RANGE_DEFS = [
    { key: 'today', label: '今天' },
    { key: 'yesterday', label: '昨天' },
    { key: '3d', label: '近 3 天' },
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' },
];
function rangeBlock(stats, key) {
    if (!stats)
        return null;
    switch (key) {
        case 'today':
            return stats.today ?? null;
        case 'yesterday':
            return stats.yesterday ?? null;
        case '3d':
            return stats.last_3_days ?? null;
        case '7d':
            return stats.last_7_days ?? null;
        case '30d':
            return stats.last_30_days ?? null;
    }
}
function rangeModels(stats, key) {
    if (!stats)
        return [];
    switch (key) {
        case 'today':
            return stats.by_model_today ?? [];
        case 'yesterday':
            return stats.by_model_yesterday ?? [];
        case '3d':
            return stats.by_model_3_days ?? [];
        case '7d':
            return stats.by_model_7_days ?? [];
        case '30d':
            return stats.by_model ?? [];
    }
}
function rangeLabelOf(key) {
    return RANGE_DEFS.find((r) => r.key === key)?.label || '';
}
class DashboardPanel {
    service;
    onReloadRequested;
    onRestartBackendRequested;
    onSwitchAccountRequested;
    onImportAccountRequested;
    onRefreshAllQuotasRequested;
    static currentPanel;
    panel;
    disposables = [];
    autoRefreshTimer = null;
    currentRange = 'today';
    isUpdating = false;
    needsUpdate = false;
    disposed = false;
    lastHtml = null;
    constructor(panel, service, onReloadRequested, onRestartBackendRequested, onSwitchAccountRequested, onImportAccountRequested, onRefreshAllQuotasRequested) {
        this.service = service;
        this.onReloadRequested = onReloadRequested;
        this.onRestartBackendRequested = onRestartBackendRequested;
        this.onSwitchAccountRequested = onSwitchAccountRequested;
        this.onImportAccountRequested = onImportAccountRequested;
        this.onRefreshAllQuotasRequested = onRefreshAllQuotasRequested;
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'refresh':
                        await this.service.refreshCurrentAccountOnline();
                        await this.update();
                        vscode.window.showInformationMessage('仪表盘数据与云端配额已同步刷新！');
                        break;
                    case 'refreshAllQuotas':
                        if (this.onRefreshAllQuotasRequested) {
                            await this.onRefreshAllQuotasRequested();
                        }
                        else {
                            await this.service.refreshAllAccountsOnline();
                        }
                        await this.update();
                        break;
                    case 'refreshSingleAccount':
                        if (typeof message.accountId === 'string' && message.accountId.trim()) {
                            const res = await this.service.refreshAccountOnlineById(message.accountId.trim());
                            await this.update();
                            if (res.success) {
                                vscode.window.showInformationMessage(`✅ 已刷新账号 ${res.email || message.accountId} 的最新云端额度！`);
                            }
                            else {
                                vscode.window.showWarningMessage(`刷新账号失败 (${res.email || message.accountId}): ${res.error || '未知错误'}`);
                            }
                        }
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
                    case 'switchToAccount':
                        if (typeof message.accountId === 'string' && message.accountId.trim()) {
                            await this.onSwitchAccountRequested(message.accountId.trim());
                            await this.update();
                        }
                        break;
                    case 'importAccount':
                        await this.onImportAccountRequested();
                        await this.update();
                        break;
                    case 'setRange':
                        if (RANGE_DEFS.some((r) => r.key === message.range)) {
                            this.currentRange = message.range;
                            await this.update();
                        }
                        break;
                }
            }
            catch (err) {
                vscode.window.showErrorMessage(`仪表盘操作失败: ${err?.message || String(err)}`);
            }
        }, null, this.disposables);
        this.update();
        // 面板从后台重新可见时立即刷新（隐藏期间定时器跳过重渲染）
        this.panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible && !this.disposed) {
                this.update();
            }
        }, null, this.disposables);
        // Live auto-refresh every 4 seconds while dashboard is open
        this.autoRefreshTimer = setInterval(() => {
            this.update();
        }, 4000);
    }
    static createOrShow(service, onReloadRequested, onRestartBackendRequested, onSwitchAccountRequested, onImportAccountRequested, onRefreshAllQuotasRequested) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.onReloadRequested = onReloadRequested;
            DashboardPanel.currentPanel.onRestartBackendRequested = onRestartBackendRequested;
            DashboardPanel.currentPanel.onSwitchAccountRequested = onSwitchAccountRequested;
            DashboardPanel.currentPanel.onImportAccountRequested = onImportAccountRequested;
            DashboardPanel.currentPanel.onRefreshAllQuotasRequested = onRefreshAllQuotasRequested;
            DashboardPanel.currentPanel.panel.reveal(column);
            DashboardPanel.currentPanel.update();
            return DashboardPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel('antigravityDashboard', '📊 AntiGravity Switch 仪表盘', column || vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        DashboardPanel.currentPanel = new DashboardPanel(panel, service, onReloadRequested, onRestartBackendRequested, onSwitchAccountRequested, onImportAccountRequested, onRefreshAllQuotasRequested);
        return DashboardPanel.currentPanel;
    }
    /**
     * 串行化更新：避免 4 秒定时器与用户操作触发的更新互相竞态，
     * 且数据未变化时不重写 html（防止悬停/滚动被反复重置）。
     * 更新期间到达的请求（如切换统计范围）不丢弃，结束后补跑一次。
     */
    async update() {
        if (this.disposed) {
            return;
        }
        // 隐藏在后台时跳过重渲染（retainContextWhenHidden 保住了内容），
        // 重新可见由 onDidChangeViewState 触发立即刷新
        if (!this.panel.visible) {
            return;
        }
        if (this.isUpdating) {
            this.needsUpdate = true;
            return;
        }
        this.isUpdating = true;
        try {
            const [status, accountSummaries] = await Promise.all([
                this.service.fetchStatus(),
                this.service.fetchAccountSummaries(),
            ]);
            const pricing = this.loadPricing();
            const totalAccounts = accountSummaries.length || this.service.countAccounts();
            if (this.disposed) {
                return;
            }
            const html = this.renderHtml(status, pricing, totalAccounts, accountSummaries);
            if (html !== this.lastHtml) {
                this.panel.webview.html = html;
                this.lastHtml = html;
            }
        }
        catch (err) {
            console.warn('Dashboard update error:', err);
        }
        finally {
            this.isUpdating = false;
            if (this.needsUpdate && !this.disposed) {
                this.needsUpdate = false;
                this.update();
            }
        }
    }
    loadPricing() {
        const toolsDir = (0, utils_1.getAntigravityToolsDir)();
        const pricingPath = path.join(toolsDir, 'api_pricing.json');
        const result = {};
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
            }
            catch { }
        }
        return result;
    }
    normalizeModelName(s) {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }
    calculateCost(model, input, output, cached, pricing) {
        const lower = model.toLowerCase();
        let price = pricing[lower];
        if (!price) {
            // 归一化分隔符后再匹配：定价表键是 "gemini-4-argon"，
            // 而统计里的模型名是 "Gemini 4 Argon (High)"，直接 includes 永远匹配不上
            const nLower = this.normalizeModelName(lower);
            const key = Object.keys(pricing).find((k) => {
                const nk = this.normalizeModelName(k);
                if (!nk)
                    return false;
                return nLower.includes(nk) || nk.includes(nLower);
            });
            price = key
                ? pricing[key]
                : { input: 0.75, output: 3.75, cached: 0.075 };
        }
        return ((input / 1_000_000) * price.input +
            (output / 1_000_000) * price.output +
            (cached / 1_000_000) * price.cached);
    }
    renderHtml(status, pricing, totalAccounts, accountSummaries = []) {
        const rangeKey = this.currentRange;
        const rangeLabel = rangeLabelOf(rangeKey);
        const block = rangeBlock(status.stats, rangeKey) ||
            {
                input_tokens: 0,
                output_tokens: 0,
                cached_tokens: 0,
                total_tokens: 0,
                request_count: 0,
            };
        const cacheHitRate = block.input_tokens + block.cached_tokens > 0
            ? ((block.cached_tokens / (block.input_tokens + block.cached_tokens)) * 100).toFixed(1)
            : '0.0';
        const perf = status.stats?.recent_performance || {
            first_text_seconds: 0,
            body_tokens_per_second: 0,
        };
        // 模型明细与费用（按当前范围）
        let totalCost = 0;
        const modelDetails = rangeModels(status.stats, rangeKey).map((m) => {
            const cost = this.calculateCost(m.model, m.input_tokens, m.output_tokens, m.cached_tokens, pricing);
            totalCost += cost;
            return { ...m, cost };
        });
        const avgInputTokens = block.request_count > 0
            ? (0, utils_1.formatTokens)(Math.round((block.input_tokens + block.cached_tokens) / block.request_count))
            : '0';
        // ---- 配额族（Gemini / Gemini 4 / Claude-GPT）----
        const families = (0, utils_1.extractQuotaFamilies)(status.account?.quota?.quota_groups);
        const gemini4 = families.find((f) => f.key === 'gemini-4') || null;
        // Gemini 4 用量（当前 Google 未提供 G4 独立配额时的可见指标）
        const g4ModelsDetail = modelDetails.filter((m) => (0, utils_1.isGemini4ModelName)(m.model));
        const g4UsageTokens = g4ModelsDetail.reduce((s, m) => s + m.total_tokens, 0);
        const g4UsageReq = g4ModelsDetail.reduce((s, m) => s + m.request_count, 0);
        const g4UsageCost = g4ModelsDetail.reduce((s, m) => s + m.cost, 0);
        const g4UsageShare = g4UsageTokens > 0 && block.total_tokens > 0
            ? ((g4UsageTokens / block.total_tokens) * 100).toFixed(1)
            : null;
        const showG4Card = !!gemini4 || g4UsageTokens > 0;
        const pct = (f) => f === null || f === undefined ? '--' : (0, utils_1.formatPercent)(f);
        const remainPct = (f) => f === null || f === undefined ? 0 : Math.max(0, Math.min(100, Math.round(f * 100)));
        const quotaRowsHtml = families.length
            ? families
                .map((f) => {
                const fiveRow = f.fiveHour !== null
                    ? `
            <div class="progress-row">
              <span>${(0, utils_1.escapeHtml)(f.displayName)} 5h:</span>
              <span><strong>${pct(f.fiveHour)}</strong>${f.fiveHourReset
                        ? ` <span style="color:var(--text-muted);font-size:10px;">(⏳${(0, utils_1.escapeHtml)((0, utils_1.formatTimeRemaining)(f.fiveHourReset))})</span>`
                        : ''}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill-cyan" style="width: ${remainPct(f.fiveHour)}%;"></div>
            </div>`
                    : '';
                const weekRow = f.weekly !== null
                    ? `
            <div class="progress-row">
              <span>${(0, utils_1.escapeHtml)(f.displayName)} 周:</span>
              <span><strong>${pct(f.weekly)}</strong>${f.weeklyReset
                        ? ` <span style="color:var(--text-muted);font-size:10px;">(⏳${(0, utils_1.escapeHtml)((0, utils_1.formatTimeRemaining)(f.weeklyReset))})</span>`
                        : ''}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill-amber" style="width: ${remainPct(f.weekly)}%;"></div>
            </div>`
                    : '';
                return fiveRow + weekRow;
            })
                .join('')
            : '<div class="kpi-sub">暂无配额数据</div>';
        let g4CardHtml = '';
        if (showG4Card) {
            if (gemini4) {
                // Google 已提供 G4 Argon 独立周限额组（不与 Gemini 3.8 共享）
                const g4FiveHtml = gemini4.fiveHour !== null
                    ? `
              <div class="progress-row">
                <span>5小时剩余:</span>
                <span><strong>${pct(gemini4.fiveHour)}</strong>${gemini4.fiveHourReset
                        ? ` <span style="color:var(--text-muted);font-size:10px;">(⏳${(0, utils_1.escapeHtml)((0, utils_1.formatTimeRemaining)(gemini4.fiveHourReset))})</span>`
                        : ''}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill-cyan" style="width: ${remainPct(gemini4.fiveHour)}%;"></div>
              </div>`
                    : '';
                g4CardHtml = `
          <div class="kpi-card" style="border-color: rgba(139, 92, 246, 0.45);">
            <div class="kpi-title">🔥 Gemini 4 Argon 独立额度</div>
            <div class="progress-group">
              ${g4FiveHtml}
              <div class="progress-row">
                <span>独立周限额剩余:</span>
                <span><strong>${pct(gemini4.weekly)}</strong>${gemini4.weeklyReset
                    ? ` <span style="color:var(--text-muted);font-size:10px;">(⏳${(0, utils_1.escapeHtml)((0, utils_1.formatTimeRemaining)(gemini4.weeklyReset))})</span>`
                    : ''}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill-cyan" style="width: ${remainPct(gemini4.weekly)}%;"></div>
              </div>
            </div>
            <div class="kpi-sub">${g4UsageTokens > 0
                    ? `${rangeLabel}用量 ${(0, utils_1.formatTokens)(g4UsageTokens)}${g4UsageShare !== null ? ` (${g4UsageShare}%)` : ''} · $${g4UsageCost.toFixed(2)}`
                    : 'Pro 独立周限额池 (不与 Gemini 3.8 共享)'}</div>
          </div>
        `;
            }
            else {
                g4CardHtml = `
          <div class="kpi-card" style="border-color: rgba(139, 92, 246, 0.45);">
            <div class="kpi-title">🔥 Gemini 4 用量</div>
            <div class="kpi-value">${(0, utils_1.formatTokens)(g4UsageTokens)}</div>
            <div class="kpi-sub">${rangeLabel} · 占总用量 ${g4UsageShare !== null ? `${g4UsageShare}%` : '--'} · ${g4UsageReq.toLocaleString()} 次请求 · $${g4UsageCost.toFixed(2)}</div>
            <div class="kpi-sub" style="margin-top:4px;">Pro 灰度账号拥有独立 Gemini 4 Argon 周限额池（点右上角刷新数据即可同步余量）</div>
          </div>
        `;
            }
        }
        // ---- 柱状图：真实数据 ----
        // 今天/昨天 → hourly（按本地日期过滤）；3/7/30 天 → daily
        let barEntries = [];
        if (rangeKey === 'today' || rangeKey === 'yesterday') {
            const dateStr = (0, utils_1.localDateStr)(rangeKey === 'yesterday' ? -1 : 0);
            barEntries = (status.stats?.hourly || [])
                .filter((h) => h.hour && h.hour.startsWith(dateStr))
                .map((h) => ({ label: h.hour.slice(11), total_tokens: h.total_tokens || 0 }));
        }
        else {
            const n = rangeKey === '3d' ? 3 : rangeKey === '7d' ? 7 : 30;
            barEntries = (status.stats?.daily || [])
                .slice(-n)
                .map((d) => ({ label: d.date.slice(5), total_tokens: d.total_tokens || 0 }));
        }
        const maxBarTotal = Math.max(...barEntries.map((b) => b.total_tokens), 1);
        const barGap = barEntries.length > 12 ? '4px' : '14px';
        const barsHtml = barEntries.length
            ? barEntries
                .map((b) => {
                const heightPct = Math.max(6, Math.min(100, Math.round((b.total_tokens / maxBarTotal) * 100)));
                const totalStr = (0, utils_1.formatTokens)(b.total_tokens);
                return `
              <div class="bar-col" title="${(0, utils_1.escapeHtml)(b.label)}: ${totalStr} Token">
                <div class="bar-tooltip">${totalStr}</div>
                <div class="bar-wrapper">
                  <div class="bar-fill" style="height: ${heightPct}%;"></div>
                </div>
                <div class="bar-label">${(0, utils_1.escapeHtml)(b.label)}</div>
              </div>
            `;
            })
                .join('')
            : '<div class="empty-chart">该时段暂无生成记录</div>';
        const chartTitle = rangeKey === 'today' || rangeKey === 'yesterday'
            ? `📈 ${rangeLabel} · 每小时 Token 生成`
            : `📈 ${rangeLabel} · 每日 Token 生成`;
        // ---- 模型环形图：真实 by_model 数据 ----
        const palette = [
            '#00c5ff',
            '#3b82f6',
            '#8b5cf6',
            '#10b981',
            '#f59e0b',
            '#ef4444',
            '#ec4899',
            '#14b8a6',
        ];
        const donutModels = [...modelDetails].sort((a, b) => b.total_tokens - a.total_tokens);
        const donutTotalTokens = donutModels.reduce((s, m) => s + m.total_tokens, 0);
        let donutGradient = 'conic-gradient(#1d283f 0% 100%)';
        if (donutModels.length === 1) {
            donutGradient = `conic-gradient(${palette[0]} 0% 100%)`;
        }
        else if (donutModels.length > 1 && donutTotalTokens > 0) {
            let acc = 0;
            const stops = [];
            donutModels.forEach((m, i) => {
                const share = (m.total_tokens / donutTotalTokens) * 100;
                const from = acc;
                acc += share;
                stops.push(`${palette[i % palette.length]} ${from.toFixed(2)}% ${acc.toFixed(2)}%`);
            });
            donutGradient = `conic-gradient(${stops.join(', ')})`;
        }
        const donutLegendHtml = donutModels.length
            ? donutModels
                .slice(0, 6)
                .map((m, i) => {
                const share = donutTotalTokens > 0
                    ? ((m.total_tokens / donutTotalTokens) * 100).toFixed(1)
                    : '0.0';
                return `
            <div style="margin-bottom:6px;">
              <span class="dot-indicator" style="background-color:${palette[i % palette.length]};"></span>
              <strong>${(0, utils_1.escapeHtml)(m.model)}</strong>
              <div style="color:var(--text-muted);font-size:12px;margin-top:2px;">
                ${(0, utils_1.formatTokens)(m.total_tokens)} Token · ${share}% · $${m.cost.toFixed(2)}
              </div>
            </div>
          `;
            })
                .join('')
            : '<div style="color:var(--text-muted);font-size:13px;">暂无模型明细数据</div>';
        const modelRowsHtml = modelDetails.length
            ? modelDetails
                .map((m) => `
          <tr>
            <td><span class="dot-indicator"></span> <strong>${(0, utils_1.escapeHtml)(m.model)}</strong></td>
            <td class="text-cost">$${m.cost.toFixed(2)}</td>
            <td><strong>${m.total_tokens.toLocaleString()}</strong></td>
            <td>${m.input_tokens.toLocaleString()}</td>
            <td>${m.output_tokens.toLocaleString()}</td>
            <td>${m.request_count.toLocaleString()}</td>
          </tr>
        `)
                .join('')
            : `
        <tr>
          <td><span class="dot-indicator"></span> <strong>未分类模型</strong></td>
          <td class="text-cost">$0.00</td>
          <td><strong>${block.total_tokens.toLocaleString()}</strong></td>
          <td>${block.input_tokens.toLocaleString()}</td>
          <td>${block.output_tokens.toLocaleString()}</td>
          <td>${block.request_count.toLocaleString()}</td>
        </tr>
      `;
        const rangePillsHtml = RANGE_DEFS.map((r) => `<span class="range-pill${r.key === rangeKey ? ' active' : ''}" onclick="setRange('${r.key}')">${r.label}</span>`).join('');
        const generatedAt = status.stats?.generated_at
            ? (0, utils_1.formatDateLocal)(new Date(status.stats.generated_at * 1000).toISOString())
            : '';
        return `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
            user-select: none;
            transition: all 0.15s;
          }
          .range-pill:hover {
            color: var(--text-main);
          }
          .range-pill.active {
            background: #2563eb;
            color: #fff;
            font-weight: 600;
          }

          /* KPI Cards Grid */
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

          /* Bar Chart */
          .bar-chart-container {
            height: 170px;
            display: flex;
            align-items: flex-end;
            gap: ${barGap};
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-card);
            overflow-x: auto;
          }
          .bar-col {
            flex: 1 0 auto;
            min-width: 18px;
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
            font-size: 10px;
            color: var(--text-muted);
            margin-top: 8px;
            white-space: nowrap;
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
          .empty-chart {
            width: 100%;
            text-align: center;
            color: var(--text-muted);
            font-size: 13px;
            padding-top: 60px;
          }

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
            background: ${donutGradient};
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 20px rgba(0, 197, 255, 0.25);
          }
          .donut-inner {
            width: 86px;
            height: 86px;
            border-radius: 50%;
            background: var(--bg-card);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
          }
          .donut-cost {
            font-size: 15px;
            font-weight: 700;
            color: #fff;
          }
          .donut-label {
            font-size: 10px;
            color: var(--text-muted);
          }
          .donut-legend { font-size: 13px; max-width: 55%; }
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
          .footer-note {
            margin-top: 16px;
            font-size: 11px;
            color: #64748b;
          }
          ${(0, dashboardAccountPool_1.getAccountPoolStyles)()}
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
            <button class="btn-action" onclick="postCmd('switchAccount')">👥 弹窗切号</button>
            <button class="btn-action" onclick="postCmd('refreshAllQuotas')">🔄 刷新全池额度</button>
            <button class="btn-action" onclick="postCmd('reloadPlugin')">⚡ 热重启插件</button>
            <button class="btn-action" onclick="postCmd('restartBackend')">🔌 冷重启核心</button>
            <button class="btn-action btn-primary" onclick="postCmd('refresh')">🔄 刷新当前</button>
          </div>
        </div>

        <!-- Sub Header Banner -->
        <div class="sub-header">
          <div class="sub-title">
            <h1>⊞ 首页</h1>
            <div class="sub-desc">AntiGravity 本地 Token 账单 · 当前账号: <span style="color:#fff;font-weight:600;">${(0, utils_1.escapeHtml)(status.account?.email || '已连接')}</span></div>
          </div>
          <div class="range-selector">
            <span style="color:var(--text-muted);margin-right:4px;">统计范围:</span>
            ${rangePillsHtml}
          </div>
        </div>

        <!-- KPI Cards -->
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-title">📊 ${rangeLabel}总 Token</div>
            <div class="kpi-value">${(0, utils_1.formatTokens)(block.total_tokens)}</div>
            <div class="kpi-sub">${block.total_tokens.toLocaleString()} Token · ${block.request_count.toLocaleString()} 次请求</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">📥 输入 Token</div>
            <div class="kpi-value">${(0, utils_1.formatTokens)(block.input_tokens)}</div>
            <div class="kpi-sub">${block.input_tokens.toLocaleString()} Token</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">📤 输出 Token</div>
            <div class="kpi-value">${(0, utils_1.formatTokens)(block.output_tokens)}</div>
            <div class="kpi-sub">${block.output_tokens.toLocaleString()} Token</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">⚡ 缓存命中率</div>
            <div class="kpi-value text-green">${cacheHitRate}%</div>
            <div class="kpi-sub">输入缓存占比 (省约 ${(0, utils_1.formatTokens)(block.cached_tokens)})</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">💰 API 费用估算</div>
            <div class="kpi-value text-amber">$${totalCost.toFixed(2)}</div>
            <div class="kpi-sub">${rangeLabel} · ${block.request_count.toLocaleString()} 次请求</div>
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
            <div class="kpi-sub">当前激活: ${(0, utils_1.escapeHtml)(status.account?.email || '已连接')}</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-title">⏳ 配额剩余 (全部模型组)</div>
            <div class="progress-group">
              ${quotaRowsHtml}
            </div>
          </div>

          ${g4CardHtml}

          <div class="kpi-card">
            <div class="kpi-title">📐 平均输入规模</div>
            <div class="kpi-value">${avgInputTokens}</div>
            <div class="kpi-sub">${block.request_count.toLocaleString()} 次请求, 含缓存输入</div>
          </div>
        </div>

        <!-- Account Pool Remaining Quotas & One-Click Switch -->
        ${(0, dashboardAccountPool_1.renderAccountPoolSection)(accountSummaries)}

        <!-- Middle Charts Row -->
        <div class="charts-row">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">${chartTitle}</div>
              <div style="font-size:12px;color:var(--text-muted)">真实本地记录</div>
            </div>
            <div class="bar-chart-container">
              ${barsHtml}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">🎯 模型分布 · ${rangeLabel}</div>
              <div style="font-size:12px;color:var(--cyan-accent)">预估费用</div>
            </div>
            <div class="donut-layout">
              <div class="donut-ring">
                <div class="donut-inner">
                  <div class="donut-cost">$${totalCost.toFixed(2)}</div>
                  <div class="donut-label">预估费用</div>
                </div>
              </div>
              <div class="donut-legend">
                ${donutLegendHtml}
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom Table -->
        <div class="table-card">
          <div class="chart-header">
            <div class="chart-title">📑 模型明细 · ${rangeLabel}输入、输出、缓存和请求次数</div>
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
          <div class="footer-note">数据来源: agy-switch stats 本地统计${generatedAt ? ` · 统计生成于 ${generatedAt}` : ''}</div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          function postCmd(command) {
            vscode.postMessage({ command });
          }
          function setRange(range) {
            vscode.postMessage({ command: 'setRange', range });
          }
          function setPoolFilter(filterKey) {
            const prev = vscode.getState() || {};
            vscode.setState({ ...prev, poolFilter: filterKey });
            document.querySelectorAll('.ag-filter-btn').forEach((btn) => {
              btn.classList.toggle('active', btn.getAttribute('data-pool-filter') === filterKey);
            });
            document.querySelectorAll('.ag-pool-row').forEach((row) => {
              const tags = (row.getAttribute('data-filters') || '').split(' ');
              row.style.display = filterKey === 'all' || tags.includes(filterKey) ? '' : 'none';
            });
          }
          document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            const accountId = btn.getAttribute('data-account-id');
            if (!accountId) return;
            if (action === 'switch-acc') {
              if (btn.disabled || btn.classList.contains('loading')) return;
              document.querySelectorAll('.ag-btn-switch').forEach((b) => {
                b.setAttribute('disabled', 'true');
                b.style.opacity = '0.55';
                b.style.pointerEvents = 'none';
              });
              btn.innerHTML = '⏳ 切换中...';
              btn.classList.add('loading');
              vscode.postMessage({ command: 'switchToAccount', accountId });
            } else if (action === 'refresh-one') {
              if (btn.disabled || btn.classList.contains('loading')) return;
              btn.innerHTML = '⏳';
              btn.classList.add('loading');
              vscode.postMessage({ command: 'refreshSingleAccount', accountId });
            }
          });
          (function restorePoolFilter() {
            const saved = vscode.getState();
            if (saved && saved.poolFilter && saved.poolFilter !== 'all') {
              setPoolFilter(saved.poolFilter);
            }
          })();
        </script>
      </body>
      </html>
    `;
    }
    dispose() {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
        }
        this.disposed = true;
        DashboardPanel.currentPanel = undefined;
        this.lastHtml = null;
        this.panel.dispose();
        while (this.disposables.length) {
            const x = this.disposables.pop();
            if (x)
                x.dispose();
        }
    }
}
exports.DashboardPanel = DashboardPanel;
//# sourceMappingURL=dashboardPanel.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyAccountPoolFilters = classifyAccountPoolFilters;
exports.getAccountPoolStyles = getAccountPoolStyles;
exports.renderAccountPoolSection = renderAccountPoolSection;
const accountQuota_1 = require("./accountQuota");
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function classifyAccountPoolFilters(acc) {
    const tags = ['all'];
    if (acc.hasGemini4) {
        tags.push('g4');
    }
    if (acc.isFreeTier) {
        tags.push('free');
    }
    else if (!acc.hasGemini4 && !acc.isForbidden && !acc.isDisabled) {
        tags.push('pro');
    }
    return tags;
}
function barColorClass(pct) {
    if (pct === null)
        return 'ag-bar-muted';
    if (pct <= 0)
        return 'ag-bar-red';
    if (pct < 25)
        return 'ag-bar-amber';
    return 'ag-bar-green';
}
function pctTextClass(pct) {
    if (pct === null)
        return 'ag-pct-muted';
    if (pct <= 0)
        return 'ag-pct-red';
    if (pct < 25)
        return 'ag-pct-amber';
    return 'ag-pct-green';
}
function clampPctWidth(pct) {
    if (pct === null || isNaN(pct))
        return 0;
    return Math.max(0, Math.min(100, Math.round(pct)));
}
function renderG4Cell(acc, nowMs) {
    if (!acc.hasGemini4) {
        return '<span class="ag-cell-dash">—</span>';
    }
    if (acc.g4Pct !== null) {
        const resetText = acc.g4ResetTime
            ? `⏳ ${escapeHtml((0, accountQuota_1.formatCountdownHuman)(acc.g4ResetTime, nowMs))}重置 (${escapeHtml((0, accountQuota_1.formatShortLocalResetTime)(acc.g4ResetTime, nowMs))})`
            : '独立 Argon 周限额池';
        return `

      <div class="ag-quota-cell">

        <div class="ag-quota-top">

          <span class="ag-pill ag-pill-g4">🔥 G4 独立周池</span>

          <span class="ag-pct-num ${pctTextClass(acc.g4Pct)}">${acc.g4Pct}%</span>

        </div>

        <div class="ag-mini-bar">

          <div class="ag-mini-fill ${barColorClass(acc.g4Pct)}" style="width:${clampPctWidth(acc.g4Pct)}%;"></div>

        </div>

        <div class="ag-reset-line">${resetText}</div>

      </div>

    `;
    }
    return `

    <div class="ag-quota-cell">

      <div class="ag-quota-top">

        <span class="ag-pill ag-pill-g4">🔥 支持 G4 Argon</span>

      </div>

      <div class="ag-reset-line">独立周池 · 切入 IDE 后直读余量</div>

    </div>

  `;
}
function renderGemini38Cell(acc, nowMs) {
    if (acc.isForbidden) {
        return `<span class="ag-limit-badge">🚫 ${escapeHtml(acc.quota?.forbidden_reason || '账号受限 (403)')}</span>`;
    }
    if (acc.gemini5hPct === null && acc.geminiWeeklyPct === null && acc.effectiveGeminiPct === null) {
        return '<span class="ag-cell-dash">未同步 (点右侧 ↻)</span>';
    }
    const eff = acc.effectiveGeminiPct;
    const p5 = acc.gemini5hPct !== null ? `${acc.gemini5hPct}%` : '--';
    const pw = acc.geminiWeeklyPct !== null ? `${acc.geminiWeeklyPct}%` : '--';
    let limitTag = '';
    if (acc.isRateLimited) {
        const reason = acc.geminiLimitReason === 'weekly'
            ? '周限额耗尽'
            : acc.geminiLimitReason === '5h'
                ? '5h限额耗尽'
                : '限流冷却';
        limitTag = `<span class="ag-limit-badge">🔴 ${reason}</span>`;
    }
    const resetParts = [];
    if (acc.gemini5hResetTime) {
        resetParts.push(`5h: ${escapeHtml((0, accountQuota_1.formatCountdownCompact)(acc.gemini5hResetTime, nowMs))} (${escapeHtml((0, accountQuota_1.formatShortLocalResetTime)(acc.gemini5hResetTime, nowMs))})`);
    }
    if (acc.geminiWeeklyResetTime) {
        resetParts.push(`周: ${escapeHtml((0, accountQuota_1.formatCountdownHuman)(acc.geminiWeeklyResetTime, nowMs))} (${escapeHtml((0, accountQuota_1.formatShortLocalResetTime)(acc.geminiWeeklyResetTime, nowMs))})`);
    }
    return `

    <div class="ag-quota-cell">

      <div class="ag-quota-top">

        <span class="ag-window-pair">

          5h <strong class="${pctTextClass(acc.gemini5hPct)}">${p5}</strong>

          <span class="ag-sep">·</span>

          周 <strong class="${pctTextClass(acc.geminiWeeklyPct)}">${pw}</strong>

        </span>

        ${limitTag}

      </div>

      <div class="ag-mini-bar">

        <div class="ag-mini-fill ${barColorClass(eff)}" style="width:${clampPctWidth(eff)}%;"></div>

      </div>

      <div class="ag-reset-line">⏳ ${resetParts.length > 0 ? resetParts.join(' ｜ ') : '重置时间待刷新'}</div>

    </div>

  `;
}
function renderClaudeCell(acc, nowMs) {
    if (acc.isForbidden) {
        return '<span class="ag-cell-dash">—</span>';
    }
    if (acc.claude5hPct === null && acc.claudeWeeklyPct === null && acc.effectiveClaudePct === null) {
        return '<span class="ag-cell-dash">—</span>';
    }
    const eff = acc.effectiveClaudePct;
    const p5 = acc.claude5hPct !== null ? `${acc.claude5hPct}%` : '--';
    const pw = acc.claudeWeeklyPct !== null ? `${acc.claudeWeeklyPct}%` : '--';
    const modelBadge = acc.hasOpus55
        ? '<span class="ag-pill ag-pill-opus55">Opus 5.5</span>'
        : acc.hasOpus
            ? '<span class="ag-pill ag-pill-opus46">Opus 4.6</span>'
            : '<span class="ag-pill ag-pill-opus46">Claude</span>';
    const resetIso = acc.claudeWeeklyResetTime || acc.claudeResetTime || acc.claude5hResetTime;
    const resetText = resetIso
        ? `⏳ ${acc.claude5hResetTime
            ? `5h: ${escapeHtml((0, accountQuota_1.formatCountdownCompact)(acc.claude5hResetTime, nowMs))} · `
            : ''}${acc.claudeWeeklyResetTime
            ? `周: ${escapeHtml((0, accountQuota_1.formatCountdownHuman)(acc.claudeWeeklyResetTime, nowMs))} (${escapeHtml((0, accountQuota_1.formatShortLocalResetTime)(acc.claudeWeeklyResetTime, nowMs))})`
            : escapeHtml((0, accountQuota_1.formatCountdownHuman)(resetIso, nowMs))}`
        : '重置时间待刷新';
    return `

    <div class="ag-quota-cell">

      <div class="ag-quota-top">

        ${modelBadge}

        <span class="ag-window-pair">

          5h <strong class="${pctTextClass(acc.claude5hPct)}">${p5}</strong>

          <span class="ag-sep">·</span>

          周 <strong class="${pctTextClass(acc.claudeWeeklyPct)}">${pw}</strong>

        </span>

      </div>

      <div class="ag-mini-bar">

        <div class="ag-mini-fill ${barColorClass(eff)}" style="width:${clampPctWidth(eff)}%;"></div>

      </div>

      <div class="ag-reset-line">${resetText}</div>

    </div>

  `;
}
function getAccountPoolStyles() {
    return `

    .ag-pool-card {

      background-color: var(--bg-card);

      border: 1px solid rgba(56, 189, 248, 0.25);

      border-radius: 12px;

      padding: 20px 24px;

      margin-bottom: 24px;

    }

    .ag-pool-header {

      display: flex;

      justify-content: space-between;

      align-items: flex-start;

      gap: 12px;

      flex-wrap: wrap;

      margin-bottom: 14px;

    }

    .ag-pool-title-wrap {

      display: flex;

      flex-direction: column;

      gap: 6px;

    }

    .ag-pool-title {

      font-size: 16px;

      font-weight: 700;

      color: #f8fafc;

      display: flex;

      align-items: center;

      gap: 10px;

      flex-wrap: wrap;

    }

    .ag-pool-badges {

      display: flex;

      gap: 8px;

      flex-wrap: wrap;

      align-items: center;

    }

    .ag-stat-chip {

      font-size: 11px;

      padding: 3px 9px;

      border-radius: 999px;

      border: 1px solid var(--border-card);

      background: rgba(255, 255, 255, 0.04);

      color: var(--text-main);

    }

    .ag-stat-chip-g4 {

      border-color: rgba(168, 85, 247, 0.45);

      background: rgba(168, 85, 247, 0.14);

      color: #e9d5ff;

    }

    .ag-stat-chip-ok {

      border-color: rgba(16, 185, 129, 0.4);

      background: rgba(16, 185, 129, 0.12);

      color: #6ee7b7;

    }

    .ag-stat-chip-warn {

      border-color: rgba(245, 158, 11, 0.4);

      background: rgba(245, 158, 11, 0.12);

      color: #fcd34d;

    }

    .ag-stat-chip-free {
      background: rgba(148, 163, 184, 0.12);
      color: #94a3b8;
      border-color: rgba(148, 163, 184, 0.3);
    }

    .ag-tier-tag.ag-tier-free {
      background: rgba(148, 163, 184, 0.15);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.35);
    }

    .ag-pool-toolbar {

      display: flex;

      justify-content: space-between;

      align-items: center;

      gap: 10px;

      flex-wrap: wrap;

      margin-bottom: 14px;

      padding-bottom: 12px;

      border-bottom: 1px solid var(--border-card);

    }

    .ag-filter-tabs {

      display: flex;

      gap: 6px;

      flex-wrap: wrap;

    }

    .ag-filter-btn {

      background: rgba(255, 255, 255, 0.04);

      color: var(--text-muted);

      border: 1px solid var(--border-card);

      border-radius: 6px;

      padding: 5px 11px;

      font-size: 12px;

      cursor: pointer;

      transition: all 0.15s;

    }

    .ag-filter-btn:hover {

      color: #fff;

      border-color: rgba(0, 197, 255, 0.4);

    }

    .ag-filter-btn.active {

      background: rgba(0, 197, 255, 0.16);

      color: var(--cyan-accent);

      border-color: rgba(0, 197, 255, 0.55);

      font-weight: 600;

    }

    .ag-table-wrap {

      overflow-x: auto;

    }

    .ag-pool-table {

      width: 100%;

      border-collapse: collapse;

      font-size: 12.5px;

    }

    .ag-pool-table th {

      padding: 10px 12px;

      font-size: 11.5px;

      color: var(--text-muted);

      border-bottom: 1px solid var(--border-card);

      white-space: nowrap;

    }

    .ag-pool-table td {

      padding: 11px 12px;

      border-bottom: 1px solid rgba(255, 255, 255, 0.05);

      vertical-align: middle;

    }

    .ag-row-current {

      background: rgba(0, 197, 255, 0.07);

    }

    .ag-row-current td:first-child {

      border-left: 3px solid var(--cyan-accent);

    }

    .ag-row-cooling {

      opacity: 0.82;

    }

    .ag-acc-main {

      display: flex;

      align-items: center;

      gap: 7px;

      font-weight: 600;

      color: #f1f5f9;

      margin-bottom: 4px;

      flex-wrap: wrap;

    }

    .ag-acc-meta {

      display: flex;

      align-items: center;

      gap: 6px;

      flex-wrap: wrap;

      font-size: 11px;

      color: var(--text-muted);

    }

    .ag-tier-tag {

      padding: 1px 7px;

      border-radius: 4px;

      font-size: 10.5px;

      font-weight: 600;

      border: 1px solid rgba(255, 255, 255, 0.12);

      background: rgba(255, 255, 255, 0.05);

      color: #cbd5e1;

    }

    .ag-tier-pro {

      border-color: rgba(56, 189, 248, 0.4);

      background: rgba(56, 189, 248, 0.12);

      color: #7dd3fc;

    }

    .ag-tier-g4 {

      border-color: rgba(168, 85, 247, 0.5);

      background: rgba(168, 85, 247, 0.16);

      color: #d8b4fe;

    }

    .ag-pill {

      display: inline-block;

      padding: 1px 6px;

      border-radius: 4px;

      font-size: 10.5px;

      font-weight: 600;

    }

    .ag-pill-g4 {

      background: rgba(168, 85, 247, 0.18);

      color: #d8b4fe;

      border: 1px solid rgba(168, 85, 247, 0.45);

    }

    .ag-pill-opus55 {

      background: rgba(236, 72, 153, 0.15);

      color: #f9a8d4;

      border: 1px solid rgba(236, 72, 153, 0.35);

    }

    .ag-pill-opus46 {

      background: rgba(59, 130, 246, 0.15);

      color: #93c5fd;

      border: 1px solid rgba(59, 130, 246, 0.35);

    }

    .ag-pill-current {

      background: rgba(16, 185, 129, 0.18);

      color: #6ee7b7;

      border: 1px solid rgba(16, 185, 129, 0.45);

    }

    .ag-quota-cell {

      min-width: 175px;

    }

    .ag-quota-top {

      display: flex;

      justify-content: space-between;

      align-items: center;

      gap: 6px;

      margin-bottom: 4px;

      font-size: 12px;

    }

    .ag-window-pair {

      color: #cbd5e1;

      font-size: 11.5px;

    }

    .ag-sep {

      color: #64748b;

      margin: 0 3px;

    }

    .ag-mini-bar {

      height: 5px;

      background: rgba(255, 255, 255, 0.08);

      border-radius: 4px;

      overflow: hidden;

      margin-bottom: 4px;

    }

    .ag-mini-fill {

      height: 100%;

      border-radius: 4px;

      transition: width 0.25s ease;

    }

    .ag-bar-green { background: linear-gradient(90deg, #10b981, #00c5ff); }

    .ag-bar-amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }

    .ag-bar-red { background: #ef4444; }

    .ag-bar-muted { background: #475569; }

    .ag-pct-num { font-weight: 700; }

    .ag-pct-green { color: #34d399; }

    .ag-pct-amber { color: #fbbf24; }

    .ag-pct-red { color: #f87171; }

    .ag-pct-muted { color: #94a3b8; }

    .ag-reset-line {

      font-size: 10.5px;

      color: var(--text-muted);

      line-height: 1.35;

    }

    .ag-limit-badge {

      font-size: 10.5px;

      color: #fca5a5;

      background: rgba(239, 68, 68, 0.14);

      border: 1px solid rgba(239, 68, 68, 0.35);

      padding: 1px 6px;

      border-radius: 4px;

      white-space: nowrap;

    }

    .ag-cell-dash {

      color: #64748b;

      font-size: 11.5px;

    }

    .ag-sub-label {

      color: var(--text-muted);

      font-size: 11px;

    }

    .ag-actions-cell {

      display: flex;

      align-items: center;

      gap: 6px;

      white-space: nowrap;

    }

    .ag-btn-switch {

      background: linear-gradient(135deg, rgba(0, 197, 255, 0.2), rgba(59, 130, 246, 0.25));

      color: #7dd3fc;

      border: 1px solid rgba(0, 197, 255, 0.45);

      border-radius: 6px;

      padding: 5px 11px;

      font-size: 12px;

      font-weight: 600;

      cursor: pointer;

      transition: all 0.15s;

    }

    .ag-btn-switch:hover {

      background: linear-gradient(135deg, #0284c7, #2563eb);

      color: #fff;

      border-color: #38bdf8;

    }

    .ag-btn-icon {

      background: rgba(255, 255, 255, 0.05);

      color: var(--text-muted);

      border: 1px solid var(--border-card);

      border-radius: 6px;

      padding: 4px 8px;

      font-size: 12px;

      cursor: pointer;

      transition: all 0.15s;

    }

    .ag-btn-icon:hover {

      color: #fff;

      border-color: rgba(255, 255, 255, 0.3);

      background: rgba(255, 255, 255, 0.1);

    }

    .ag-badge-active {

      display: inline-block;

      padding: 4px 9px;

      border-radius: 6px;

      font-size: 11.5px;

      font-weight: 600;

      color: #34d399;

      background: rgba(16, 185, 129, 0.12);

      border: 1px solid rgba(16, 185, 129, 0.35);

    }

  `;
}
function renderAccountPoolSection(summaries, nowMs = Date.now()) {
    const stats = (0, accountQuota_1.computePoolStats)(summaries);
    const isUsable = (a) => !a.isForbidden &&
        !a.isDisabled &&
        ((a.effectiveGeminiPct !== null && a.effectiveGeminiPct > 0) ||
            (a.g4Pct !== null && a.g4Pct > 0));
    const g4List = summaries.filter((a) => classifyAccountPoolFilters(a).includes('g4'));
    const proList = summaries.filter((a) => classifyAccountPoolFilters(a).includes('pro'));
    const freeList = summaries.filter((a) => classifyAccountPoolFilters(a).includes('free'));
    const g4Total = g4List.length;
    const proTotal = proList.length;
    const freeTotal = freeList.length;
    const g4Usable = g4List.filter(isUsable).length;
    const proUsable = proList.filter(isUsable).length;
    const freeUsable = freeList.filter(isUsable).length;
    const coolingCount = summaries.filter((a) => a.isRateLimited && !a.isDisabled && !a.isForbidden).length;
    const rowsHtml = summaries.length === 0
        ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">未检测到本地账号，请点击右上角「➕ 导入账号」</td></tr>`
        : summaries
            .map((acc) => {
            const filterList = classifyAccountPoolFilters(acc).join(' ');
            const emoji = (0, accountQuota_1.getAccountStatusEmoji)(acc);
            const rowClasses = [
                'ag-pool-row',
                acc.isCurrent ? 'ag-row-current' : '',
                acc.isRateLimited ? 'ag-row-cooling' : '',
            ]
                .filter(Boolean)
                .join(' ');
            const tierClass = acc.hasGemini4
                ? 'ag-tier-tag ag-tier-g4'
                : acc.isFreeTier
                    ? 'ag-tier-tag ag-tier-free'
                    : acc.isPaidTier
                        ? 'ag-tier-tag ag-tier-pro'
                        : 'ag-tier-tag';
            const currentBadge = acc.isCurrent
                ? '<span class="ag-pill ag-pill-current">⭐ 当前 IDE</span>'
                : '';
            const customLabel = acc.custom_label
                ? `<span class="ag-pill" style="background:rgba(255,255,255,0.08);color:#cbd5e1;">${escapeHtml(acc.custom_label)}</span>`
                : '';
            const updatedStr = acc.quotaUpdatedAt
                ? `同步于 ${escapeHtml((0, accountQuota_1.formatShortLocalResetTime)(new Date(acc.quotaUpdatedAt * 1000).toISOString(), nowMs))}`
                : '';
            const safeId = escapeHtml(acc.id);
            const safeEmail = escapeHtml(acc.email);
            const actionHtml = acc.isCurrent
                ? `

                <div class="ag-actions-cell">

                  <span class="ag-badge-active">✓ 当前激活</span>

                  <button class="ag-btn-icon" data-action="refresh-one" data-account-id="${safeId}" title="刷新此账号最新云端额度">↻</button>

                </div>

              `
                : `

                <div class="ag-actions-cell">

                  <button class="ag-btn-switch" data-action="switch-acc" data-account-id="${safeId}" title="一键切换到 ${safeEmail}">⚡ 切换</button>

                  <button class="ag-btn-icon" data-action="refresh-one" data-account-id="${safeId}" title="单独刷新 ${safeEmail} 的最新额度">↻</button>

                </div>

              `;
            return `

              <tr class="${rowClasses}" data-filters="${escapeHtml(filterList)}">

                <td>

                  <div class="ag-acc-main">

                    <span>${emoji}</span>

                    <span>${safeEmail}</span>

                    ${currentBadge}

                    ${customLabel}

                  </div>

                  <div class="ag-acc-meta">

                    <span class="${tierClass}">${escapeHtml(acc.tierDisplay)}</span>

                    ${acc.hasGemini4
                ? '<span class="ag-pill ag-pill-g4">G4 Argon + Opus 5.5</span>'
                : acc.hasGemini38
                    ? '<span style="color:#94a3b8;">Gemini 3.8 + Opus 4.6</span>'
                    : ''}

                    ${updatedStr ? `<span>· ${updatedStr}</span>` : ''}

                  </div>

                </td>

                <td>${renderG4Cell(acc, nowMs)}</td>

                <td>${renderGemini38Cell(acc, nowMs)}</td>

                <td>${renderClaudeCell(acc, nowMs)}</td>

                <td>${actionHtml}</td>

              </tr>

            `;
        })
            .join('');
    return `

    <div class="ag-pool-card">

      <div class="ag-pool-header">

        <div class="ag-pool-title-wrap">

          <div class="ag-pool-title">

            <span>👥 账号池剩余额度总览 & 一键切号</span>

          </div>

          <div class="ag-pool-badges">

            <span class="ag-stat-chip">共 ${stats.total} 个账号</span>

            <span class="ag-stat-chip ag-stat-chip-g4">🔥 G4 Pro 可用: ${g4Usable} / ${g4Total}</span>

            <span class="ag-stat-chip ag-stat-chip-ok">⚡ 普通 Pro 可用: ${proUsable} / ${proTotal}</span>

            <span class="ag-stat-chip ag-stat-chip-free">🆓 免费 Free: ${freeUsable} / ${freeTotal}</span>

            ${coolingCount > 0 ? `<span class="ag-stat-chip ag-stat-chip-warn">⏳ 限流冷却: ${coolingCount} 个</span>` : ''}

          </div>

        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">

          <button class="btn-action btn-primary" onclick="postCmd('refreshAllQuotas')">🔄 刷新全池额度</button>

          <button class="btn-action" onclick="postCmd('importAccount')">➕ 导入账号</button>

        </div>

      </div>

      <div class="ag-pool-toolbar">

        <div class="ag-filter-tabs">

          <button class="ag-filter-btn active" data-pool-filter="all" onclick="setPoolFilter('all')">全部 (${stats.total})</button>

          <button class="ag-filter-btn" data-pool-filter="g4" onclick="setPoolFilter('g4')">🔥 G4 Pro (${g4Total})</button>

          <button class="ag-filter-btn" data-pool-filter="pro" onclick="setPoolFilter('pro')">⚡ 普通 Pro (${proTotal})</button>

          <button class="ag-filter-btn" data-pool-filter="free" onclick="setPoolFilter('free')">🆓 免费 Free (${freeTotal})</button>

        </div>

        <div style="font-size:11.5px;color:var(--text-muted);">

          Gemini 4 Argon 为独立周限额池（不与 Gemini 3.8 共享）；非当前账号的 Argon 余量需切入一次后才能读取

        </div>

      </div>

      <div class="ag-table-wrap">

        <table class="ag-pool-table">

          <thead>

            <tr>

              <th>账号 / 真实档位</th>

              <th>Gemini 4 Argon (独立周池)</th>

              <th>Gemini 3.8 &amp; 生图 (剩余 / 刷新时间)</th>

              <th>Claude Opus (剩余 / 刷新时间)</th>

              <th>操作</th>

            </tr>

          </thead>

          <tbody>

            ${rowsHtml}

          </tbody>

        </table>

      </div>

    </div>

  `;
}
//# sourceMappingURL=dashboardAccountPool.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fractionToPct = fractionToPct;
exports.modelToPct = modelToPct;
exports.isExplicitGemini4ModelName = isExplicitGemini4ModelName;
exports.isGemini4CapableModelName = isGemini4CapableModelName;
exports.isGemini38ModelName = isGemini38ModelName;
exports.isClaudeModelName = isClaudeModelName;
exports.isOpusModelName = isOpusModelName;
exports.isOpus55ModelName = isOpus55ModelName;
exports.isImageModelName = isImageModelName;
exports.normalizeQuotaGroups = normalizeQuotaGroups;
exports.extractQuotaFamiliesFromRaw = extractQuotaFamiliesFromRaw;
exports.formatCountdownHuman = formatCountdownHuman;
exports.formatCountdownCompact = formatCountdownCompact;
exports.formatShortLocalResetTime = formatShortLocalResetTime;
exports.computeEffectiveWindow = computeEffectiveWindow;
exports.summarizeAccount = summarizeAccount;
exports.sortGroupRank = sortGroupRank;
exports.sortAccountSummaries = sortAccountSummaries;
exports.computePoolStats = computePoolStats;
exports.runBoundedBatchRefresh = runBoundedBatchRefresh;
exports.getAccountStatusEmoji = getAccountStatusEmoji;
exports.formatAccountQuickPickDisplay = formatAccountQuickPickDisplay;
function clamp01(val) {
    if (isNaN(val))
        return 0;
    return Math.max(0, Math.min(1, val));
}
function fractionToPct(fraction) {
    if (fraction === null || fraction === undefined || isNaN(fraction)) {
        return null;
    }
    return Math.round(clamp01(fraction) * 100);
}
function modelToPct(model) {
    if (!model)
        return null;
    const obs = typeof model.observed_remaining_fraction === 'number'
        ? model.observed_remaining_fraction
        : typeof model.observedRemainingFraction === 'number'
            ? model.observedRemainingFraction
            : undefined;
    if (typeof obs === 'number' && !isNaN(obs)) {
        return Math.round(clamp01(obs) * 100);
    }
    if (typeof model.percentage === 'number' && !isNaN(model.percentage)) {
        return Math.round(Math.max(0, Math.min(100, model.percentage)));
    }
    return null;
}
/** 显式 Gemini 4 模型名识别（"Gemini 4 Argon (High)" / "gemini-4-argon-trial" / Argon 代号 / m400..m405） */
function isExplicitGemini4ModelName(name) {
    return /gemini[\s\-_.]*4|argon|\bm40[0-5]\b/i.test(name || '');
}
/**
 * 账号是否具备 Gemini 4 Argon + Claude 5.5 世代模型能力：
 * Google Antigravity 的 Gemini 4 Argon 白名单账号在 fetchAvailableModels 中以
 * claude-opus-5-5-* / claude-sonnet-5-5-*（或显式 gemini-4 / argon / m26 / m400..m405）为 1:1 指纹。
 */
function isGemini4CapableModelName(name) {
    return /gemini[\s\-_.]*4|argon|\bm40[0-5]\b|opus[\s\-_.]*5[\s\-_.]*5|sonnet[\s\-_.]*5[\s\-_.]*5/i.test(name || '');
}
function isGemini38ModelName(name) {
    return /gemini[\s\-_.]*3[\s\-_.]*8|gemini[\s\-_.]*3[\s\-_.]*1[\s\-_.]*pro/i.test(name || '');
}
function isClaudeModelName(name) {
    return /claude/i.test(name || '');
}
function isOpusModelName(name) {
    return /opus/i.test(name || '');
}
function isOpus55ModelName(name) {
    return /opus[\s\-_.]*5[\s\-_.]*5/i.test(name || '');
}
function isImageModelName(name) {
    return /image/i.test(name || '');
}
function normalizeRawBucketFields(raw, fallbackId = '') {
    if (!raw || typeof raw !== 'object')
        return null;
    const bucketId = String(raw.bucket_id ?? raw.bucketId ?? fallbackId ?? '').trim();
    const rawFrac = typeof raw.remaining_fraction === 'number'
        ? raw.remaining_fraction
        : typeof raw.remainingFraction === 'number'
            ? raw.remainingFraction
            : typeof raw.percentage === 'number'
                ? raw.percentage / 100
                : null;
    if (rawFrac === null || isNaN(rawFrac)) {
        return null;
    }
    let win = String(raw.window || '').toLowerCase();
    if (win !== '5h' && win !== 'weekly') {
        if (/weekly|week|7d/i.test(bucketId) || /weekly|week|7d/i.test(win)) {
            win = 'weekly';
        }
        else {
            win = '5h';
        }
    }
    const resetTime = typeof raw.reset_time === 'string'
        ? raw.reset_time
        : typeof raw.resetTime === 'string'
            ? raw.resetTime
            : '';
    return {
        bucket_id: bucketId,
        window: win,
        remaining_fraction: clamp01(rawFrac),
        reset_time: resetTime,
    };
}
/**
 * 兼容数组结构与对象/字典结构的 quota_groups（同时兼容 snake_case 与 camelCase 字段）：
 * 1) 标准数组: [{ display_name: "Gemini Models", buckets: [{ bucket_id: "gemini-5h", window: "5h", remaining_fraction, reset_time }] }]
 * 2) 字典映射: { "gemini-5h": { remaining_fraction: 0.9, reset_time: "..." }, "gemini-weekly": { ... }, "3p-5h": { ... } }
 * 3) 分组字典: { "gemini": { display_name: "...", buckets: [...] } }
 */
function normalizeQuotaGroups(rawGroups) {
    if (!rawGroups) {
        return [];
    }
    if (Array.isArray(rawGroups)) {
        const out = [];
        for (const item of rawGroups) {
            if (!item || typeof item !== 'object')
                continue;
            if (Array.isArray(item.buckets)) {
                const displayName = String(item.display_name ?? item.displayName ?? '');
                const buckets = [];
                for (const b of item.buckets) {
                    const nb = normalizeRawBucketFields(b);
                    if (nb)
                        buckets.push(nb);
                }
                out.push({ display_name: displayName, buckets });
            }
            else {
                const parsed = normalizeSingleBucket(item.bucket_id ?? item.bucketId ?? '', item);
                if (parsed) {
                    appendBucketToGroups(out, parsed.groupName, parsed.bucket);
                }
            }
        }
        return out;
    }
    if (typeof rawGroups === 'object') {
        const out = [];
        for (const [key, val] of Object.entries(rawGroups)) {
            if (!val || typeof val !== 'object')
                continue;
            if (Array.isArray(val.buckets)) {
                const displayName = String(val.display_name ?? val.displayName ?? key);
                const buckets = [];
                for (const b of val.buckets) {
                    const nb = normalizeRawBucketFields(b);
                    if (nb)
                        buckets.push(nb);
                }
                out.push({ display_name: displayName, buckets });
            }
            else {
                const parsed = normalizeSingleBucket(val.bucket_id ?? val.bucketId ?? key, val);
                if (parsed) {
                    appendBucketToGroups(out, parsed.groupName, parsed.bucket);
                }
            }
        }
        return out;
    }
    return [];
}
function normalizeSingleBucket(rawBucketId, val) {
    const bucket = normalizeRawBucketFields(val, rawBucketId);
    if (!bucket)
        return null;
    const lower = bucket.bucket_id.toLowerCase();
    let groupName = String(val.display_name ?? val.displayName ?? '');
    if (!groupName || /limit remaining/i.test(groupName)) {
        if (/gemini[\s\-_.]*4|argon|\bg4\b|\bm40[0-5]\b/.test(lower)) {
            groupName = 'Gemini 4 Models';
        }
        else if (/gemini/.test(lower)) {
            groupName = 'Gemini Models';
        }
        else if (/3p|claude|gpt|opus|sonnet/.test(lower)) {
            groupName = 'Claude and GPT models';
        }
        else {
            groupName = bucket.bucket_id || 'Gemini Models';
        }
    }
    return { groupName, bucket };
}
function appendBucketToGroups(groups, groupName, bucket) {
    const existing = groups.find((g) => g.display_name.toLowerCase() === groupName.toLowerCase());
    if (existing) {
        existing.buckets.push(bucket);
    }
    else {
        groups.push({ display_name: groupName, buckets: [bucket] });
    }
}
/**
 * 把 quota_groups（数组或字典）归纳为配额族：Gemini / Gemini 4 / Claude-GPT。
 */
function extractQuotaFamiliesFromRaw(rawGroups) {
    const groups = normalizeQuotaGroups(rawGroups);
    if (!groups.length) {
        return [];
    }
    const families = [];
    for (const group of groups) {
        const name = (group.display_name || '').toLowerCase();
        let groupKey = null;
        if (name.includes('gemini') || /\bg4\b|argon/.test(name)) {
            groupKey = /gemini[\s\-_.]*4|\bg4\b|argon/.test(name) ? 'gemini-4' : 'gemini';
        }
        else if (name.includes('claude') ||
            name.includes('gpt') ||
            name.includes('3p') ||
            name.includes('opus') ||
            name.includes('sonnet')) {
            groupKey = 'claude-gpt';
        }
        for (const bucket of group.buckets || []) {
            const bucketId = (bucket.bucket_id || '').toLowerCase();
            let key = groupKey;
            if (!key) {
                if (/gemini[\s\-_.]*4|\bg4\b|argon|\bm40[0-5]\b/.test(bucketId)) {
                    key = 'gemini-4';
                }
                else if (bucketId.includes('gemini')) {
                    key = 'gemini';
                }
                else if (/3p|claude|gpt|opus|sonnet/.test(bucketId)) {
                    key = 'claude-gpt';
                }
            }
            else if (key === 'gemini' && /gemini[\s\-_.]*4|\bg4\b|argon|\bm40[0-5]\b/.test(bucketId)) {
                key = 'gemini-4';
            }
            if (!key)
                continue;
            const displayName = key === 'gemini-4' ? 'Gemini 4' : key === 'gemini' ? 'Gemini' : 'Claude/GPT';
            let fam = families.find((f) => f.key === key);
            if (!fam) {
                fam = {
                    key,
                    displayName,
                    fiveHour: null,
                    weekly: null,
                };
                families.push(fam);
            }
            const win = (bucket.window || '').toLowerCase();
            const isWeekly = win === 'weekly' || (!win && /weekly|week|7d/.test(bucketId));
            const is5h = win === '5h' || (!isWeekly && (/5h|five/.test(bucketId) || win === ''));
            if (is5h && fam.fiveHour === null && typeof bucket.remaining_fraction === 'number') {
                fam.fiveHour = clamp01(bucket.remaining_fraction);
                fam.fiveHourReset = bucket.reset_time || undefined;
            }
            else if (isWeekly &&
                fam.weekly === null &&
                typeof bucket.remaining_fraction === 'number') {
                fam.weekly = clamp01(bucket.remaining_fraction);
                fam.weeklyReset = bucket.reset_time || undefined;
            }
        }
    }
    return families;
}
function safeParseTimeMs(iso) {
    if (!iso || typeof iso !== 'string')
        return null;
    const ms = Date.parse(iso);
    return isNaN(ms) ? null : ms;
}
function formatCountdownHuman(resetTimeIso, nowMs = Date.now()) {
    if (!resetTimeIso) {
        return '未知';
    }
    const target = safeParseTimeMs(resetTimeIso);
    if (target === null) {
        return resetTimeIso;
    }
    const diffMs = target - nowMs;
    if (diffMs <= 0) {
        return '已重置';
    }
    const totalMinutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return `${days}天${remHours}小时后`;
    }
    if (hours > 0) {
        return `${hours}小时${mins}分后`;
    }
    return `${Math.max(1, mins)}分钟后`;
}
/** 紧凑倒计时（用于单行 QuickPick 徽章，如 "3h30m" / "3d5h" / "45m" / "已重置"） */
function formatCountdownCompact(resetTimeIso, nowMs = Date.now()) {
    if (!resetTimeIso) {
        return '--';
    }
    const target = safeParseTimeMs(resetTimeIso);
    if (target === null) {
        return '--';
    }
    const diffMs = target - nowMs;
    if (diffMs <= 0) {
        return '已重置';
    }
    const totalMinutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return `${days}d${remHours}h`;
    }
    if (hours > 0) {
        return `${hours}h${mins}m`;
    }
    return `${Math.max(1, mins)}m`;
}
/** 短格式本地时间（同一天显示 HH:mm，跨天显示 MM-DD HH:mm） */
function formatShortLocalResetTime(isoString, nowMs = Date.now()) {
    const target = safeParseTimeMs(isoString);
    if (target === null) {
        return '';
    }
    const date = new Date(target);
    const now = new Date(nowMs);
    const pad = (n) => n.toString().padStart(2, '0');
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const sameDay = date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    if (sameDay) {
        return hm;
    }
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}
/**
 * 计算有效可用百分比 min(5h, weekly) 与对应重置时间：
 * - 当两个窗口都 <= 0% 时，必须等最晚重置的那个窗口恢复才可用（取 max reset_time）
 * - 当仅 weekly <= 0%（哪怕 5h=99%）时，有效可用为 0%，重置时间取 weeklyReset！
 * - 当仅 5h <= 0% 时，有效可用为 0%，重置时间取 fiveHourReset！
 * - 当 > 0% 可用时：若 5h < 100%（正在消耗 5h 窗口）优先展示 5h 重置时间；
 *   若 5h == 100% 且 weekly < 100%（5h 未动、周限额有消耗）展示 weekly 重置时间；
 *   否则取 fiveHourReset || weeklyReset。
 */
function computeEffectiveWindow(fiveHourPct, weeklyPct, fiveHourReset, weeklyReset) {
    if (fiveHourPct === null && weeklyPct === null) {
        return { effectivePct: null, effectiveResetTime: undefined, limitReason: null };
    }
    const effectivePct = fiveHourPct !== null && weeklyPct !== null
        ? Math.min(fiveHourPct, weeklyPct)
        : fiveHourPct !== null
            ? fiveHourPct
            : weeklyPct;
    const fiveZero = fiveHourPct !== null && fiveHourPct <= 0;
    const weekZero = weeklyPct !== null && weeklyPct <= 0;
    if (fiveZero && weekZero) {
        const t5 = safeParseTimeMs(fiveHourReset);
        const tw = safeParseTimeMs(weeklyReset);
        let laterReset = weeklyReset || fiveHourReset;
        if (t5 !== null && tw !== null) {
            laterReset = tw >= t5 ? weeklyReset : fiveHourReset;
        }
        return {
            effectivePct: 0,
            effectiveResetTime: laterReset || undefined,
            limitReason: 'both',
        };
    }
    if (weekZero) {
        return {
            effectivePct: 0,
            effectiveResetTime: weeklyReset || fiveHourReset || undefined,
            limitReason: 'weekly',
        };
    }
    if (fiveZero) {
        return {
            effectivePct: 0,
            effectiveResetTime: fiveHourReset || weeklyReset || undefined,
            limitReason: '5h',
        };
    }
    // Usable (> 0%)
    let effectiveResetTime;
    if (fiveHourPct !== null && fiveHourPct < 100 && fiveHourReset) {
        effectiveResetTime = fiveHourReset;
    }
    else if (weeklyPct !== null && weeklyPct < 100 && weeklyReset) {
        effectiveResetTime = weeklyReset;
    }
    else {
        effectiveResetTime = fiveHourReset || weeklyReset || undefined;
    }
    return {
        effectivePct,
        effectiveResetTime,
        limitReason: null,
    };
}
/**
 * 当 quota_groups 缺失时，根据模型的 quota_bucket_id 或 reset_time 推断其属于 5h 还是 weekly 窗口。
 * 5h 窗口距离刷新的时间永远 <= 5 小时；超过 6 小时的重置时间必为 weekly 窗口（如 GCP 7天周期）。
 */
function inferModelWindow(model, refTimeMs) {
    const bucketId = String(model.quota_bucket_id ?? model.quotaBucketId ?? '').toLowerCase();
    if (bucketId.includes('weekly') || bucketId.includes('7d')) {
        return 'weekly';
    }
    if (bucketId.includes('5h')) {
        return '5h';
    }
    const resetIso = model.reset_time ?? model.resetTime;
    const resetMs = safeParseTimeMs(resetIso);
    if (resetMs !== null && resetMs - refTimeMs > 6 * 3600 * 1000) {
        return 'weekly';
    }
    return '5h';
}
function pickPrimaryGeminiModel(models) {
    if (!models.length)
        return null;
    const nonImage = models.filter((m) => !isImageModelName(m.name) && !isExplicitGemini4ModelName(m.name));
    return (nonImage.find((m) => /gemini[\s\-_.]*3[\s\-_.]*8[\s\-_.]*flash[\s\-_.]*high/i.test(m.name)) ||
        nonImage.find((m) => /gemini[\s\-_.]*3[\s\-_.]*8/i.test(m.name)) ||
        nonImage.find((m) => /gemini[\s\-_.]*3[\s\-_.]*1[\s\-_.]*pro/i.test(m.name)) ||
        nonImage.find((m) => /gemini[\s\-_.]*2[\s\-_.]*5[\s\-_.]*pro/i.test(m.name)) ||
        nonImage.find((m) => /gemini/i.test(m.name)) ||
        null);
}
function pickPrimaryClaudeModel(models) {
    if (!models.length)
        return null;
    return (models.find((m) => isOpus55ModelName(m.name)) ||
        models.find((m) => isOpusModelName(m.name)) ||
        models.find((m) => isClaudeModelName(m.name)) ||
        null);
}
function resolveTier(account, quota, models, families, hasGemini4, hasGemini38, hasClaude, hasImageOnly) {
    const rawTier = (quota?.subscription_tier || '').trim();
    const lower = rawTier.toLowerCase();
    if (lower.includes('ultra')) {
        return { tierKind: 'ultra', tierDisplay: 'Ultra', isPaidTier: true, isFreeTier: false };
    }
    if (lower.includes('pro')) {
        return { tierKind: 'pro', tierDisplay: 'Pro', isPaidTier: true, isFreeTier: false };
    }
    if (lower.includes('plus')) {
        return { tierKind: 'plus', tierDisplay: 'Plus', isPaidTier: true, isFreeTier: false };
    }
    if (lower.includes('gcp') ||
        lower.includes('cloud') ||
        lower.includes('standard') ||
        lower.includes('enterprise')) {
        return { tierKind: 'gcp', tierDisplay: 'GCP', isPaidTier: true, isFreeTier: false };
    }
    if (lower.includes('starter')) {
        const label = hasImageOnly ? 'Free(仅生图)' : 'Free';
        return { tierKind: 'free', tierDisplay: label, isPaidTier: false, isFreeTier: true };
    }
    // 当 subscription_tier 为 "free-tier" 或空（null/""）时：
    // 旧版 agy-switch 曾把 currentTier.id="free-tier" 写入拥有 3.8/Claude/G4 的付费或 GCP 账号；
    // 真正的 Free Starter 缺乏 G4/M26/Opus 5.5，且无 3.8/3-1-pro/claude/5h 桶。
    const has5hBucket = families.some((f) => f.fiveHour !== null);
    const hasPaidModelSignal = hasGemini4 || hasGemini38 || hasClaude || has5hBucket;
    if (lower === 'free-tier' || lower === 'free' || lower === '') {
        if (hasPaidModelSignal) {
            const isGcpAccount = Boolean(account.is_gcp_tos) ||
                (lower === '' &&
                    !has5hBucket &&
                    (!account.project_id || account.project_id !== 'aicode-consumers'));
            if (isGcpAccount) {
                return { tierKind: 'gcp', tierDisplay: 'GCP', isPaidTier: true, isFreeTier: false };
            }
            if (hasGemini4 || has5hBucket) {
                return { tierKind: 'pro', tierDisplay: 'Pro', isPaidTier: true, isFreeTier: false };
            }
            return { tierKind: 'paid', tierDisplay: 'Paid', isPaidTier: true, isFreeTier: false };
        }
        if (lower.includes('free') || models.length > 0) {
            const label = hasImageOnly ? 'Free(仅生图)' : 'Free';
            return { tierKind: 'free', tierDisplay: label, isPaidTier: false, isFreeTier: true };
        }
        return { tierKind: 'unknown', tierDisplay: '未同步', isPaidTier: false, isFreeTier: false };
    }
    return { tierKind: 'paid', tierDisplay: rawTier, isPaidTier: true, isFreeTier: false };
}
/**
 * 将单个账号原始数据解析为结构化的 AccountSummary（含 5h/周有效配额、G4/Claude/生图、重置时间与档位）。
 */
function summarizeAccount(account, nowMs = Date.now()) {
    const quota = account.quota || null;
    const models = Array.isArray(quota?.models) ? quota.models : [];
    const families = extractQuotaFamiliesFromRaw(quota?.quota_groups);
    const geminiFam = families.find((f) => f.key === 'gemini') || null;
    const g4Fam = families.find((f) => f.key === 'gemini-4') || null;
    const claudeFam = families.find((f) => f.key === 'claude-gpt') || null;
    // 模型能力检测（同时检查 name 与 display_name）
    const modelIdent = (m) => `${m.name || ''} ${m.display_name || m.displayName || ''}`;
    const hasExplicitG4Model = models.some((m) => isExplicitGemini4ModelName(modelIdent(m)));
    const hasOpus55 = models.some((m) => isOpus55ModelName(modelIdent(m)));
    const hasOpus = hasOpus55 || models.some((m) => isOpusModelName(modelIdent(m)));
    const hasClaude = Boolean(claudeFam) || hasOpus || models.some((m) => isClaudeModelName(modelIdent(m)));
    const hasGemini4 = Boolean(g4Fam) ||
        hasExplicitG4Model ||
        models.some((m) => isGemini4CapableModelName(modelIdent(m)));
    const hasGemini38 = models.some((m) => isGemini38ModelName(modelIdent(m))) ||
        (Boolean(geminiFam) && models.length === 0 && !quota?.is_forbidden);
    const refTimeMs = typeof quota?.last_updated === 'number' && quota.last_updated > 0
        ? quota.last_updated * 1000
        : nowMs;
    // 1. Gemini 3.8 / 基础 Gemini 5h & 周配额
    let gemini5hPct = geminiFam ? fractionToPct(geminiFam.fiveHour) : null;
    let geminiWeeklyPct = geminiFam ? fractionToPct(geminiFam.weekly) : null;
    let gemini5hResetTime = geminiFam?.fiveHourReset;
    let geminiWeeklyResetTime = geminiFam?.weeklyReset;
    if (gemini5hPct === null && geminiWeeklyPct === null && models.length > 0) {
        const primaryGemini = pickPrimaryGeminiModel(models);
        if (primaryGemini) {
            const pct = modelToPct(primaryGemini);
            const win = inferModelWindow(primaryGemini, refTimeMs);
            const rIso = primaryGemini.reset_time || primaryGemini.resetTime || undefined;
            if (win === 'weekly') {
                geminiWeeklyPct = pct;
                geminiWeeklyResetTime = rIso;
            }
            else {
                gemini5hPct = pct;
                gemini5hResetTime = rIso;
            }
        }
    }
    const geminiEff = computeEffectiveWindow(gemini5hPct, geminiWeeklyPct, gemini5hResetTime, geminiWeeklyResetTime);
    // 2. Claude / 3P 5h & 周配额
    let claude5hPct = claudeFam ? fractionToPct(claudeFam.fiveHour) : null;
    let claudeWeeklyPct = claudeFam ? fractionToPct(claudeFam.weekly) : null;
    let claude5hResetTime = claudeFam?.fiveHourReset;
    let claudeWeeklyResetTime = claudeFam?.weeklyReset;
    if (claude5hPct === null && claudeWeeklyPct === null && models.length > 0) {
        const primaryClaude = pickPrimaryClaudeModel(models);
        if (primaryClaude) {
            const pct = modelToPct(primaryClaude);
            const win = inferModelWindow(primaryClaude, refTimeMs);
            const rIso = primaryClaude.reset_time || primaryClaude.resetTime || undefined;
            if (win === 'weekly') {
                claudeWeeklyPct = pct;
                claudeWeeklyResetTime = rIso;
            }
            else {
                claude5hPct = pct;
                claude5hResetTime = rIso;
            }
        }
    }
    const claudeEff = computeEffectiveWindow(claude5hPct, claudeWeeklyPct, claude5hResetTime, claudeWeeklyResetTime);
    // 3. Gemini 4 配额
    let g4FiveHourPct = null;
    let g4WeeklyPct = null;
    let g4Pct = null;
    let g4ResetTime;
    let g4SharesGeminiPool = false;
    if (g4Fam) {
        g4FiveHourPct = fractionToPct(g4Fam.fiveHour);
        g4WeeklyPct = fractionToPct(g4Fam.weekly);
        const g4Eff = computeEffectiveWindow(g4FiveHourPct, g4WeeklyPct, g4Fam.fiveHourReset, g4Fam.weeklyReset);
        g4Pct = g4Eff.effectivePct;
        g4ResetTime = g4Eff.effectiveResetTime;
    }
    else if (hasExplicitG4Model) {
        const g4Model = models.find((m) => isExplicitGemini4ModelName(modelIdent(m)));
        const rawPct = modelToPct(g4Model);
        const win = inferModelWindow(g4Model, refTimeMs);
        if (win === 'weekly') {
            g4WeeklyPct = rawPct;
        }
        else {
            g4FiveHourPct = rawPct;
        }
        const rIso = g4Model.reset_time || g4Model.resetTime || undefined;
        const sharesGemini = String(g4Model.quota_bucket_id ?? g4Model.quotaBucketId ?? '')
            .toLowerCase()
            .startsWith('gemini');
        if (sharesGemini && geminiWeeklyPct !== null && rawPct !== null) {
            g4Pct = Math.min(rawPct, geminiWeeklyPct);
            g4ResetTime =
                geminiWeeklyPct <= 0
                    ? geminiWeeklyResetTime || rIso
                    : rIso || geminiEff.effectiveResetTime;
        }
        else {
            g4Pct = rawPct;
            g4ResetTime = rIso;
        }
    }
    // 注：Pro 账号的 Gemini 4 Argon 为独立周限额桶 (gemini-argon-wtu-weekly)，不与 Gemini 3.8 共享配额池。
    // 4. 生图模型配额 (gemini-3.1-flash-image 等)
    let imagePct = null;
    let imageResetTime;
    const imgModel = models.find((m) => isImageModelName(modelIdent(m)));
    if (imgModel) {
        const rawImgPct = modelToPct(imgModel);
        const rIso = imgModel.reset_time || imgModel.resetTime || undefined;
        const bucketId = String(imgModel.quota_bucket_id ?? imgModel.quotaBucketId ?? '').toLowerCase();
        const sharesGeminiWeekly = (bucketId === '' || bucketId.startsWith('gemini')) && geminiWeeklyPct !== null;
        if (rawImgPct !== null && sharesGeminiWeekly) {
            imagePct = Math.min(rawImgPct, geminiWeeklyPct);
            imageResetTime =
                geminiWeeklyPct <= 0
                    ? geminiWeeklyResetTime || rIso
                    : rIso || geminiEff.effectiveResetTime;
        }
        else {
            imagePct = rawImgPct;
            imageResetTime = rIso;
        }
    }
    const hasImageOnly = !hasGemini4 && !hasGemini38 && !hasClaude && imgModel !== undefined;
    // 5. 档位与状态标记
    const isForbidden = Boolean(quota?.is_forbidden);
    const isDisabled = Boolean(account.disabled);
    const tierInfo = resolveTier(account, quota, models, families, hasGemini4, hasGemini38, hasClaude, hasImageOnly);
    const effectiveGeminiPct = isForbidden ? null : geminiEff.effectivePct;
    const effectiveClaudePct = isForbidden ? null : claudeEff.effectivePct;
    const finalG4Pct = isForbidden ? null : g4Pct;
    const isRateLimited = !isForbidden &&
        ((effectiveGeminiPct !== null && effectiveGeminiPct <= 0) ||
            (effectiveGeminiPct === null && finalG4Pct !== null && finalG4Pct <= 0));
    const isClaudeRateLimited = !isForbidden && effectiveClaudePct !== null && effectiveClaudePct <= 0;
    const capabilityTags = [];
    if (hasGemini4)
        capabilityTags.push('G4');
    if (hasOpus55) {
        capabilityTags.push('Opus 5.5');
    }
    else if (hasOpus) {
        capabilityTags.push('Opus');
    }
    else if (hasClaude) {
        capabilityTags.push('Claude');
    }
    if (hasGemini38)
        capabilityTags.push('3.8');
    return {
        ...account,
        isCurrent: Boolean(account.is_current),
        isDisabled,
        isForbidden,
        isRateLimited,
        isClaudeRateLimited,
        tierKind: tierInfo.tierKind,
        tierDisplay: tierInfo.tierDisplay,
        isPaidTier: tierInfo.isPaidTier,
        isFreeTier: tierInfo.isFreeTier,
        hasGemini4,
        hasGemini38,
        hasClaude,
        hasOpus,
        hasOpus55,
        capabilityTags,
        gemini5hPct,
        geminiWeeklyPct,
        effectiveGeminiPct,
        gemini5hResetTime,
        geminiWeeklyResetTime,
        geminiResetTime: geminiEff.effectiveResetTime,
        geminiLimitReason: geminiEff.limitReason,
        g4Pct: finalG4Pct,
        g4FiveHourPct,
        g4WeeklyPct,
        g4SharesGeminiPool,
        g4ResetTime,
        claude5hPct,
        claudeWeeklyPct,
        effectiveClaudePct,
        claude5hResetTime,
        claudeWeeklyResetTime,
        claudeResetTime: claudeEff.effectiveResetTime,
        claudeLimitReason: claudeEff.limitReason,
        imagePct: isForbidden ? null : imagePct,
        imageResetTime,
        quotaUpdatedAt: quota?.last_updated,
    };
}
function tierWeight(kind) {
    switch (kind) {
        case 'ultra':
            return 5;
        case 'pro':
            return 4;
        case 'plus':
            return 3;
        case 'gcp':
            return 2;
        case 'paid':
            return 1;
        default:
            return 0;
    }
}
function sortGroupRank(acc) {
    if (acc.isCurrent)
        return 0;
    if (acc.isForbidden || acc.isDisabled)
        return 5;
    if (acc.isFreeTier)
        return 4;
    const usable = (acc.effectiveGeminiPct !== null && acc.effectiveGeminiPct > 0) ||
        (acc.g4Pct !== null && acc.g4Pct > 0);
    if (acc.isPaidTier && usable)
        return 1;
    if (acc.isPaidTier && acc.isRateLimited)
        return 2;
    return 3;
}
/**
 * 智能账号排序：
 * 0. 当前正在使用的账号置顶
 * 1. 可用付费账号（🔥 G4 + Opus 5.5 账号最优先，其次按有效 Gemini 额度 > 档位权重 > Claude 有效额度 降序）
 * 2. 限流冷却中的付费账号（0%，按 G4 能力优先、最早恢复时间升序）
 * 3. 未同步配额账号
 * 4. Free Starter 免费账号（按剩余额度降序、最早恢复时间升序）
 * 5. 封禁 / 禁用账号置底
 */
function sortAccountSummaries(accounts) {
    return [...accounts].sort((a, b) => {
        const rankA = sortGroupRank(a);
        const rankB = sortGroupRank(b);
        if (rankA !== rankB) {
            return rankA - rankB;
        }
        // 组 1：可用付费账号
        if (rankA === 1) {
            if (a.hasGemini4 !== b.hasGemini4) {
                return a.hasGemini4 ? -1 : 1;
            }
            const effA = a.effectiveGeminiPct ?? a.g4Pct ?? 0;
            const effB = b.effectiveGeminiPct ?? b.g4Pct ?? 0;
            if (effA !== effB) {
                return effB - effA;
            }
            const twA = tierWeight(a.tierKind);
            const twB = tierWeight(b.tierKind);
            if (twA !== twB) {
                return twB - twA;
            }
            const clA = a.effectiveClaudePct ?? 0;
            const clB = b.effectiveClaudePct ?? 0;
            if (clA !== clB) {
                return clB - clA;
            }
            return a.email.localeCompare(b.email);
        }
        // 组 2：限流冷却付费账号 -> G4 优先，其次最快恢复优先
        if (rankA === 2) {
            if (a.hasGemini4 !== b.hasGemini4) {
                return a.hasGemini4 ? -1 : 1;
            }
            const resetA = safeParseTimeMs(a.geminiResetTime) ?? Number.MAX_SAFE_INTEGER;
            const resetB = safeParseTimeMs(b.geminiResetTime) ?? Number.MAX_SAFE_INTEGER;
            if (resetA !== resetB) {
                return resetA - resetB;
            }
            return tierWeight(b.tierKind) - tierWeight(a.tierKind);
        }
        // 组 4：Free Starter 账号 -> 有额度的在前，0% 按恢复时间排序
        if (rankA === 4) {
            const effA = a.effectiveGeminiPct ?? -1;
            const effB = b.effectiveGeminiPct ?? -1;
            if (effA !== effB) {
                return effB - effA;
            }
            const resetA = safeParseTimeMs(a.geminiResetTime) ?? Number.MAX_SAFE_INTEGER;
            const resetB = safeParseTimeMs(b.geminiResetTime) ?? Number.MAX_SAFE_INTEGER;
            if (resetA !== resetB) {
                return resetA - resetB;
            }
        }
        return a.email.localeCompare(b.email);
    });
}
function computePoolStats(summaries) {
    let usableGemini = 0;
    let usablePaidGemini = 0;
    let usableG4 = 0;
    let totalG4 = 0;
    let rateLimited = 0;
    let forbidden = 0;
    for (const s of summaries) {
        if (s.isForbidden || s.isDisabled) {
            forbidden++;
            continue;
        }
        if (s.hasGemini4) {
            totalG4++;
            const g4Usable = s.g4Pct !== null
                ? s.g4Pct > 0
                : (s.effectiveGeminiPct ?? 0) > 0 || (s.effectiveClaudePct ?? 0) > 0;
            if (g4Usable) {
                usableG4++;
            }
        }
        if ((s.effectiveGeminiPct ?? 0) > 0) {
            usableGemini++;
            if (s.isPaidTier) {
                usablePaidGemini++;
            }
        }
        else if (s.isRateLimited) {
            rateLimited++;
        }
    }
    return {
        total: summaries.length,
        usableGemini,
        usablePaidGemini,
        usableG4,
        totalG4,
        rateLimited,
        forbidden,
    };
}
/**
 * 有界并发批量刷新调度器（默认 5 个并发 Worker）：
 * 单个账号异常或超时绝对不会中断整批刷新，且实时回调 (completed, total, email)。
 */
async function runBoundedBatchRefresh(items, refreshFn, options) {
    const total = items.length;
    if (total === 0) {
        return { total: 0, succeeded: 0, failed: 0 };
    }
    const concurrency = Math.min(total, Math.max(1, options?.concurrency ?? 5));
    let nextIndex = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const worker = async () => {
        while (nextIndex < total) {
            const idx = nextIndex++;
            const item = items[idx];
            try {
                const res = await refreshFn(item);
                if (res && res.success) {
                    succeeded++;
                }
                else {
                    failed++;
                }
            }
            catch {
                failed++;
            }
            finally {
                completed++;
                if (options?.onProgress) {
                    try {
                        options.onProgress(completed, total, item.email);
                    }
                    catch { }
                }
            }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { total, succeeded, failed };
}
function getAccountStatusEmoji(acc) {
    if (acc.isForbidden || acc.isDisabled) {
        return '🔴';
    }
    if (acc.isRateLimited) {
        return '🔴';
    }
    if (acc.isFreeTier || acc.effectiveGeminiPct === null) {
        return '⚪';
    }
    if (acc.effectiveGeminiPct >= 50) {
        return '🟢';
    }
    return '🟡';
}
function formatAccountQuickPickDisplay(acc, nowMs = Date.now()) {
    const statusEmoji = getAccountStatusEmoji(acc);
    const g4Prefix = acc.hasGemini4 ? '🔥 ' : '';
    const label = `${statusEmoji} ${g4Prefix}${acc.email}${acc.isCurrent ? '  (当前)' : ''}`;
    const tierTag = acc.hasGemini4
        ? `[🔥G4${acc.hasOpus55 ? '+Opus5.5' : ''} · ${acc.tierDisplay}]`
        : `[${acc.tierDisplay}${acc.hasOpus ? ' · Opus' : ''}]`;
    let description;
    if (acc.isForbidden) {
        description = `🚫 账号受限/无权限 (Forbidden) · [${acc.tierDisplay}]`;
    }
    else if (acc.isDisabled) {
        description = `⏸ 已禁用 · ${tierTag}`;
    }
    else if (acc.isRateLimited) {
        const limitLabel = acc.geminiLimitReason === 'weekly'
            ? '周限流'
            : acc.geminiLimitReason === '5h'
                ? '5h限流'
                : '限流';
        const countdown = acc.geminiResetTime
            ? `${formatCountdownCompact(acc.geminiResetTime, nowMs)}后`
            : '等待';
        const localTime = acc.geminiResetTime
            ? ` ${formatShortLocalResetTime(acc.geminiResetTime, nowMs)}恢复`
            : '恢复';
        const headName = '3.8';
        const g4PrefixInfo = acc.hasGemini4 && acc.g4Pct !== null
            ? `G4: ${acc.g4Pct}%(周${acc.g4ResetTime ? ` ⏳${formatCountdownCompact(acc.g4ResetTime, nowMs)}` : ''}) · `
            : '';
        description = `${tierTag} · ${g4PrefixInfo}${headName}: 🔴 0% (${limitLabel} · ⏳${countdown}${localTime})`;
    }
    else if (acc.isFreeTier) {
        const gPart = acc.effectiveGeminiPct !== null ? `生图/Lite: ${acc.effectiveGeminiPct}%(周)` : '未同步';
        const rPart = acc.geminiResetTime
            ? ` · ⏳${formatCountdownCompact(acc.geminiResetTime, nowMs)}后重置`
            : '';
        description = `[${acc.tierDisplay}] ${gPart}${rPart}`;
    }
    else {
        const g4Seg = acc.hasGemini4 && acc.g4Pct !== null
            ? `G4: ${acc.g4Pct}%(周${acc.g4ResetTime ? ` ⏳${formatCountdownCompact(acc.g4ResetTime, nowMs)}` : ''}) · `
            : acc.hasGemini4
                ? 'G4: 独立池 · '
                : '';
        let gPart = '3.8: 未同步';
        if (acc.gemini5hPct !== null && acc.geminiWeeklyPct !== null) {
            gPart = `3.8: ${acc.gemini5hPct}%(5h)/${acc.geminiWeeklyPct}%(周)`;
        }
        else if (acc.gemini5hPct !== null) {
            gPart = `3.8: ${acc.gemini5hPct}%(5h)`;
        }
        else if (acc.geminiWeeklyPct !== null) {
            gPart = `3.8: ${acc.geminiWeeklyPct}%(周)`;
        }
        let rPart = '';
        if (acc.gemini5hPct !== null && acc.gemini5hPct < 100 && acc.gemini5hResetTime) {
            rPart = ` · ⏳5h:${formatCountdownCompact(acc.gemini5hResetTime, nowMs)}后重置`;
        }
        else if (acc.geminiWeeklyResetTime) {
            rPart = ` · ⏳周:${formatCountdownCompact(acc.geminiWeeklyResetTime, nowMs)}后重置`;
        }
        else if (acc.gemini5hResetTime) {
            rPart = ` · ⏳5h:${formatCountdownCompact(acc.gemini5hResetTime, nowMs)}后重置`;
        }
        const clLabelShort = acc.hasOpus55 ? 'Opus5.5' : 'Claude';
        const clPart = acc.effectiveClaudePct !== null
            ? ` · ${clLabelShort}: ${acc.effectiveClaudePct}%`
            : '';
        description = `${tierTag} · ${g4Seg}${gPart}${rPart}${clPart}`;
    }
    // Detail: 完整明细（G4 独立周限额、Gemini 3.8 5h & 周 + 重置倒计时、Claude 5h & 周 + 重置倒计时、生图、更新时间）
    const detailSegments = [];
    if (acc.isForbidden) {
        detailSegments.push('该账号已被 Google 限制访问 Antigravity 配额');
    }
    else {
        if (acc.hasGemini4) {
            if (acc.g4Pct !== null) {
                const rg4 = acc.g4ResetTime
                    ? ` (⏳${formatCountdownHuman(acc.g4ResetTime, nowMs)} / ${formatShortLocalResetTime(acc.g4ResetTime, nowMs)})`
                    : '';
                detailSegments.push(`🔥G4 Argon(独立周池): ${acc.g4Pct}%${rg4}`);
            }
            else {
                detailSegments.push('🔥G4 Argon: 支持 (独立周限额池，切换激活后自动读取精确余量)');
            }
        }
        const gTitle = 'Gemini 3.8';
        const gBits = [];
        if (acc.gemini5hPct !== null) {
            const r5 = acc.gemini5hResetTime
                ? ` (⏳${formatCountdownHuman(acc.gemini5hResetTime, nowMs)} / ${formatShortLocalResetTime(acc.gemini5hResetTime, nowMs)})`
                : '';
            gBits.push(`5h ${acc.gemini5hPct}%${r5}`);
        }
        if (acc.geminiWeeklyPct !== null) {
            const rw = acc.geminiWeeklyResetTime
                ? ` (⏳${formatCountdownHuman(acc.geminiWeeklyResetTime, nowMs)} / ${formatShortLocalResetTime(acc.geminiWeeklyResetTime, nowMs)})`
                : '';
            gBits.push(`周 ${acc.geminiWeeklyPct}%${rw}`);
        }
        if (gBits.length > 0) {
            detailSegments.push(`${gTitle}: ${gBits.join(' · ')}`);
        }
        if (acc.claude5hPct !== null || acc.claudeWeeklyPct !== null) {
            const clLabel = acc.hasOpus55 ? 'Claude(Opus 5.5)' : acc.hasOpus ? 'Claude(Opus 4.6)' : 'Claude';
            const clVal = acc.claude5hPct !== null && acc.claudeWeeklyPct !== null
                ? `${acc.claude5hPct}%(5h)/${acc.claudeWeeklyPct}%(周)`
                : `${acc.effectiveClaudePct ?? '--'}%`;
            const clReset = acc.isClaudeRateLimited && acc.claudeResetTime
                ? ` (🔴 ⏳${formatCountdownHuman(acc.claudeResetTime, nowMs)}恢复)`
                : acc.claudeResetTime
                    ? ` (⏳${formatCountdownHuman(acc.claudeResetTime, nowMs)}重置)`
                    : '';
            detailSegments.push(`${clLabel}: ${clVal}${clReset}`);
        }
        if (acc.imagePct !== null) {
            detailSegments.push(`生图: ${acc.imagePct}%`);
        }
    }
    if (acc.quotaUpdatedAt) {
        const syncIso = new Date(acc.quotaUpdatedAt * 1000).toISOString();
        detailSegments.push(`更新 ${formatShortLocalResetTime(syncIso, nowMs)}`);
    }
    return {
        statusEmoji,
        label,
        description,
        detail: detailSegments.length > 0 ? `   ${detailSegments.join('  |  ')}` : '',
    };
}
//# sourceMappingURL=accountQuota.js.map
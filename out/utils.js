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
exports.formatTokens = formatTokens;
exports.formatPercent = formatPercent;
exports.formatTimeRemaining = formatTimeRemaining;
exports.formatDateLocal = formatDateLocal;
exports.getAntigravityToolsDir = getAntigravityToolsDir;
exports.getProxyUrl = getProxyUrl;
exports.resolveAgySwitchPath = resolveAgySwitchPath;
exports.extractQuotaFamilies = extractQuotaFamilies;
exports.pickPrimaryGeminiFamily = pickPrimaryGeminiFamily;
exports.pickGemini4Family = pickGemini4Family;
exports.isGemini4ModelName = isGemini4ModelName;
exports.extractGemini4Usage = extractGemini4Usage;
exports.escapeHtml = escapeHtml;
exports.localDateStr = localDateStr;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const vscode = __importStar(require("vscode"));
const accountQuota_1 = require("./accountQuota");
function formatTokens(num) {
    if (num === undefined || num === null || isNaN(num)) {
        return '0';
    }
    if (num >= 1_000_000_000) {
        return (num / 1_000_000_000).toFixed(2) + 'B';
    }
    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(1) + 'M';
    }
    if (num >= 1_000) {
        return (num / 1_000).toFixed(1) + 'K';
    }
    return num.toLocaleString();
}
function formatPercent(fraction) {
    if (fraction === undefined || fraction === null || isNaN(fraction)) {
        return '--';
    }
    // Math.round to match official Antigravity settings page (e.g. 21%, 86%)
    return Math.round(fraction * 100) + '%';
}
function formatTimeRemaining(resetTimeIso, nowMs) {
    return (0, accountQuota_1.formatCountdownHuman)(resetTimeIso, nowMs);
}
function formatDateLocal(isoString) {
    if (!isoString) {
        return '';
    }
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) {
            return isoString;
        }
        const pad = (n) => n.toString().padStart(2, '0');
        const m = pad(date.getMonth() + 1);
        const d = pad(date.getDate());
        const h = pad(date.getHours());
        const min = pad(date.getMinutes());
        return `${date.getFullYear()}-${m}-${d} ${h}:${min}`;
    }
    catch {
        return isoString;
    }
}
function getAntigravityToolsDir() {
    return path.join(os.homedir(), '.antigravity_tools');
}
/**
 * 网络代理地址：优先用户配置 antigravityStatus.proxyUrl，
 * 否则继承环境变量 HTTP(S)_PROXY。不再硬编码 127.0.0.1:7897 ——
 * 用户没开代理时，硬编码会导致每个请求都先等一次 CONNECT 失败。
 */
function getProxyUrl() {
    try {
        const configured = vscode.workspace
            .getConfiguration('antigravityStatus')
            .get('proxyUrl', '');
        if (configured && configured.trim() !== '') {
            return configured.trim();
        }
    }
    catch { }
    return (process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        null);
}
// agy-switch 路径解析结果缓存：未找到时负缓存 60s，
// 避免每次 fetchStatus（默认 5 秒一次）都阻塞式 execSync('where agy-switch')。
let agySwitchPathCache = null;
function resolveAgySwitchPath(customPath) {
    const custom = (customPath || '').trim();
    if (agySwitchPathCache && agySwitchPathCache.custom === custom) {
        if (agySwitchPathCache.path) {
            return agySwitchPathCache.path;
        }
        if (Date.now() - agySwitchPathCache.ts < 60_000) {
            return null;
        }
    }
    let resolved = null;
    if (custom !== '') {
        if (fs.existsSync(custom)) {
            resolved = custom;
        }
    }
    if (!resolved) {
        const candidatePaths = [
            'D:\\agy-switch\\agy-switch.exe',
            'C:\\agy-switch\\agy-switch.exe',
            path.join(os.homedir(), 'agy-switch', 'agy-switch.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'agy-switch', 'agy-switch.exe'),
            path.join(process.env.APPDATA || '', 'agy-switch', 'agy-switch.exe'),
            path.join(os.homedir(), '.gemini', 'bin', 'agy-switch.exe'),
        ];
        for (const candidate of candidatePaths) {
            if (candidate && fs.existsSync(candidate)) {
                resolved = candidate;
                break;
            }
        }
    }
    if (!resolved) {
        try {
            const { execSync } = require('child_process');
            const cmd = process.platform === 'win32' ? 'where agy-switch' : 'which agy-switch';
            const output = execSync(cmd, {
                stdio: ['pipe', 'pipe', 'ignore'],
                encoding: 'utf-8',
                timeout: 3000,
            });
            const firstLine = output.trim().split(/\r?\n/)[0];
            if (firstLine && fs.existsSync(firstLine)) {
                resolved = firstLine;
            }
        }
        catch {
            // ignore
        }
    }
    agySwitchPathCache = { path: resolved, ts: Date.now(), custom };
    return resolved;
}
/**
 * 把 quota_groups 归纳为配额族（同时支持数组格式与字典映射格式）。
 * 关键修复：多个 Gemini 组（例如未来出现 "Gemini 4 Models" 独立组）时，
 * 原实现会互相覆盖只剩最后一个；现在按族分别保留。
 */
function extractQuotaFamilies(groups) {
    return (0, accountQuota_1.extractQuotaFamiliesFromRaw)(groups);
}
/** 状态栏主显族：优先基础 Gemini；只有 Gemini 4 时直接用它 */
function pickPrimaryGeminiFamily(families) {
    return (families.find((f) => f.key === 'gemini') ||
        families.find((f) => f.key === 'gemini-4') ||
        null);
}
/** 独立的 Gemini 4 族（仅当与基础 Gemini 并存时才需要追加显示） */
function pickGemini4Family(families) {
    const hasBase = families.some((f) => f.key === 'gemini');
    const g4 = families.find((f) => f.key === 'gemini-4') || null;
    return hasBase ? g4 : g4;
}
/** Gemini 4 模型名识别（"Gemini 4 Argon (High)" / "gemini-4-argon-trial" / Argon 代号） */
function isGemini4ModelName(name) {
    return (0, accountQuota_1.isExplicitGemini4ModelName)(name);
}
/** 从模型用量明细中汇总 Gemini 4 的消耗（当前 Google 未提供 G4 独立配额时的可见指标） */
function extractGemini4Usage(models) {
    const list = (models || []).filter((m) => isGemini4ModelName(m.model));
    return {
        totalTokens: list.reduce((s, m) => s + (m.total_tokens || 0), 0),
        requestCount: list.reduce((s, m) => s + (m.request_count || 0), 0),
        models: list.map((m) => m.model),
    };
}
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/** 本地 YYYY-MM-DD（偏移 offsetDays 天），用于匹配 stats.hourly 的日期前缀 */
function localDateStr(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
//# sourceMappingURL=utils.js.map
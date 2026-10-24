import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { QuotaFamily, QuotaGroup, TokenStatsModel } from './types';

export function formatTokens(num: number | undefined | null): string {
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

export function formatPercent(fraction: number | undefined | null): string {
  if (fraction === undefined || fraction === null || isNaN(fraction)) {
    return '--';
  }
  // Math.round to match official Antigravity settings page (e.g. 21%, 86%)
  return Math.round(fraction * 100) + '%';
}

export function formatTimeRemaining(resetTimeIso: string | undefined | null): string {
  if (!resetTimeIso) {
    return '未知';
  }
  try {
    const target = new Date(resetTimeIso).getTime();
    if (isNaN(target)) {
      return resetTimeIso;
    }
    const diffMs = target - Date.now();
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
    return `${mins}分钟后`;
  } catch {
    return resetTimeIso;
  }
}

export function formatDateLocal(isoString: string | undefined | null): string {
  if (!isoString) {
    return '';
  }
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      return isoString;
    }
    const pad = (n: number) => n.toString().padStart(2, '0');
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `${date.getFullYear()}-${m}-${d} ${h}:${min}`;
  } catch {
    return isoString;
  }
}

export function getAntigravityToolsDir(): string {
  return path.join(os.homedir(), '.antigravity_tools');
}

/**
 * 网络代理地址：优先用户配置 antigravityStatus.proxyUrl，
 * 否则继承环境变量 HTTP(S)_PROXY。不再硬编码 127.0.0.1:7897 ——
 * 用户没开代理时，硬编码会导致每个请求都先等一次 CONNECT 失败。
 */
export function getProxyUrl(): string | null {
  try {
    const configured = vscode.workspace
      .getConfiguration('antigravityStatus')
      .get<string>('proxyUrl', '');
    if (configured && configured.trim() !== '') {
      return configured.trim();
    }
  } catch {}
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

// agy-switch 路径解析结果缓存：未找到时负缓存 60s，
// 避免每次 fetchStatus（默认 5 秒一次）都阻塞式 execSync('where agy-switch')。
let agySwitchPathCache: { path: string | null; ts: number; custom: string } | null = null;

export function resolveAgySwitchPath(customPath?: string): string | null {
  const custom = (customPath || '').trim();

  if (agySwitchPathCache && agySwitchPathCache.custom === custom) {
    if (agySwitchPathCache.path) {
      return agySwitchPathCache.path;
    }
    if (Date.now() - agySwitchPathCache.ts < 60_000) {
      return null;
    }
  }

  let resolved: string | null = null;

  if (custom !== '') {
    if (fs.existsSync(custom)) {
      resolved = custom;
    }
  }

  if (!resolved) {
    const candidatePaths: string[] = [
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
      const { execSync } = require('child_process') as typeof import('child_process');
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
    } catch {
      // ignore
    }
  }

  agySwitchPathCache = { path: resolved, ts: Date.now(), custom };
  return resolved;
}

/**
 * 把 quota_groups 归纳为配额族。
 * 关键修复：多个 Gemini 组（例如未来出现 "Gemini 4 Models" 独立组）时，
 * 原实现会互相覆盖只剩最后一个；现在按族分别保留。
 */
export function extractQuotaFamilies(
  groups: QuotaGroup[] | null | undefined
): QuotaFamily[] {
  if (!groups || !groups.length) {
    return [];
  }

  const families: QuotaFamily[] = [];

  for (const group of groups) {
    const name = (group.display_name || '').toLowerCase();
    let key: QuotaFamily['key'] | null = null;

    if (name.includes('gemini')) {
      key = /gemini[\s\-_]*4/.test(name) ? 'gemini-4' : 'gemini';
    } else if (name.includes('claude') || name.includes('gpt') || name.includes('3p')) {
      key = 'claude-gpt';
    }

    if (!key) {
      continue;
    }

    let fiveHour: number | null = null;
    let weekly: number | null = null;
    let fiveHourReset: string | undefined;
    let weeklyReset: string | undefined;

    for (const bucket of group.buckets || []) {
      // bucket_id 兜底识别（如 gemini-4-5h），display_name 不规范时仍能归类
      const bucketId = (bucket.bucket_id || '').toLowerCase();
      if (key === 'gemini' && /gemini[\s\-_]*4/.test(bucketId)) {
        key = 'gemini-4';
      }
      if (bucket.window === '5h') {
        fiveHour = bucket.remaining_fraction;
        fiveHourReset = bucket.reset_time;
      } else if (bucket.window === 'weekly') {
        weekly = bucket.remaining_fraction;
        weeklyReset = bucket.reset_time;
      }
    }

    const displayName =
      key === 'gemini-4' ? 'Gemini 4' : key === 'gemini' ? 'Gemini' : 'Claude/GPT';

    const existing = families.find((f) => f.key === key);
    if (existing) {
      if (fiveHour !== null && existing.fiveHour === null) {
        existing.fiveHour = fiveHour;
        existing.fiveHourReset = fiveHourReset;
      }
      if (weekly !== null && existing.weekly === null) {
        existing.weekly = weekly;
        existing.weeklyReset = weeklyReset;
      }
    } else {
      families.push({ key, displayName, fiveHour, weekly, fiveHourReset, weeklyReset });
    }
  }

  return families;
}

/** 状态栏主显族：优先基础 Gemini；只有 Gemini 4 时直接用它 */
export function pickPrimaryGeminiFamily(families: QuotaFamily[]): QuotaFamily | null {
  return (
    families.find((f) => f.key === 'gemini') ||
    families.find((f) => f.key === 'gemini-4') ||
    null
  );
}

/** 独立的 Gemini 4 族（仅当与基础 Gemini 并存时才需要追加显示） */
export function pickGemini4Family(families: QuotaFamily[]): QuotaFamily | null {
  const hasBase = families.some((f) => f.key === 'gemini');
  const g4 = families.find((f) => f.key === 'gemini-4') || null;
  return hasBase ? g4 : g4;
}

/** Gemini 4 模型名识别（"Gemini 4 Argon (High)" / "gemini-4-argon-trial" / Argon 代号） */
export function isGemini4ModelName(name: string | undefined | null): boolean {
  return /gemini[\s\-_.]*4|argon/i.test(name || '');
}

export interface Gemini4Usage {
  totalTokens: number;
  requestCount: number;
  models: string[];
}

/** 从模型用量明细中汇总 Gemini 4 的消耗（当前 Google 未提供 G4 独立配额时的可见指标） */
export function extractGemini4Usage(
  models: TokenStatsModel[] | null | undefined
): Gemini4Usage {
  const list = (models || []).filter((m) => isGemini4ModelName(m.model));
  return {
    totalTokens: list.reduce((s, m) => s + (m.total_tokens || 0), 0),
    requestCount: list.reduce((s, m) => s + (m.request_count || 0), 0),
    models: list.map((m) => m.model),
  };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 本地 YYYY-MM-DD（偏移 offsetDays 天），用于匹配 stats.hourly 的日期前缀 */
export function localDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

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
    return '0%';
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

export function resolveAgySwitchPath(customPath?: string): string | null {
  if (customPath && customPath.trim() !== '') {
    const trimmed = customPath.trim();
    if (fs.existsSync(trimmed)) {
      return trimmed;
    }
  }

  const candidatePaths: string[] = [
    'D:\\agy-switch\\agy-switch.exe',
    'C:\\agy-switch\\agy-switch.exe',
    path.join(os.homedir(), 'agy-switch', 'agy-switch.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'agy-switch', 'agy-switch.exe'),
    path.join(process.env.APPDATA || '', 'agy-switch', 'agy-switch.exe'),
    path.join(os.homedir(), '.gemini', 'bin', 'agy-switch.exe'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Check PATH
  try {
    const cmd = process.platform === 'win32' ? 'where agy-switch' : 'which agy-switch';
    const output = execSync(cmd, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' });
    const firstLine = output.trim().split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch {
    // ignore
  }

  return null;
}

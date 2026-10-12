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
exports.resolveAgySwitchPath = resolveAgySwitchPath;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
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
        return '0%';
    }
    // Math.round to match official Antigravity settings page (e.g. 21%, 86%)
    return Math.round(fraction * 100) + '%';
}
function formatTimeRemaining(resetTimeIso) {
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
    }
    catch {
        return resetTimeIso;
    }
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
function resolveAgySwitchPath(customPath) {
    if (customPath && customPath.trim() !== '') {
        const trimmed = customPath.trim();
        if (fs.existsSync(trimmed)) {
            return trimmed;
        }
    }
    const candidatePaths = [
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
        const output = (0, child_process_1.execSync)(cmd, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' });
        const firstLine = output.trim().split(/\r?\n/)[0];
        if (firstLine && fs.existsSync(firstLine)) {
            return firstLine;
        }
    }
    catch {
        // ignore
    }
    return null;
}
//# sourceMappingURL=utils.js.map
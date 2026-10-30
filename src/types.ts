export interface QuotaBucket {
  bucket_id: string;
  window: string;
  remaining_fraction: number;
  reset_time: string;
}

export interface QuotaGroup {
  display_name: string;
  buckets: QuotaBucket[];
}

export interface ModelQuota {
  name: string;
  percentage: number;
  reset_time: string;
  observed_remaining_fraction?: number;
  quota_bucket_id?: string;
  display_name?: string;
}

export interface AccountQuota {
  last_updated?: number;
  subscription_tier?: string | null;
  is_forbidden?: boolean;
  forbidden_reason?: string | null;
  models?: ModelQuota[];
  quota_groups?: QuotaGroup[] | Record<string, any> | null;
}

export interface AccountInfo {
  id: string;
  email: string;
  name: string;
  custom_label?: string | null;
  disabled?: boolean;
  is_current?: boolean;
  last_used?: number | null;
  project_id?: string | null;
  is_gcp_tos?: boolean;
  quota?: AccountQuota | null;
}

export type AccountTierKind = 'ultra' | 'pro' | 'plus' | 'gcp' | 'paid' | 'free' | 'unknown';

export type QuotaLimitReason = '5h' | 'weekly' | 'both' | null;

export interface AccountSummary extends AccountInfo {
  isCurrent: boolean;
  isDisabled: boolean;
  isForbidden: boolean;
  isRateLimited: boolean;
  isClaudeRateLimited: boolean;

  tierKind: AccountTierKind;
  tierDisplay: string;
  isPaidTier: boolean;
  isFreeTier: boolean;

  hasGemini4: boolean;
  hasGemini38: boolean;
  hasClaude: boolean;
  hasOpus: boolean;
  hasOpus55: boolean;
  capabilityTags: string[];

  gemini5hPct: number | null;
  geminiWeeklyPct: number | null;
  effectiveGeminiPct: number | null;
  gemini5hResetTime?: string;
  geminiWeeklyResetTime?: string;
  geminiResetTime?: string;
  geminiLimitReason: QuotaLimitReason;

  g4Pct: number | null;
  g4FiveHourPct: number | null;
  g4WeeklyPct: number | null;
  g4SharesGeminiPool: boolean;
  g4ResetTime?: string;

  claude5hPct: number | null;
  claudeWeeklyPct: number | null;
  effectiveClaudePct: number | null;
  claude5hResetTime?: string;
  claudeWeeklyResetTime?: string;
  claudeResetTime?: string;
  claudeLimitReason: QuotaLimitReason;

  imagePct: number | null;
  imageResetTime?: string;

  quotaUpdatedAt?: number;
}

export interface AccountPoolStats {
  total: number;
  usableGemini: number;
  usablePaidGemini: number;
  usableG4: number;
  totalG4: number;
  rateLimited: number;
  forbidden: number;
}

export interface BatchQuotaRefreshResult {
  total: number;
  succeeded: number;
  failed: number;
}

export interface TokenStatsToday {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  request_count: number;
}

export interface TokenStatsDailyEntry extends TokenStatsToday {
  date: string;
}

export interface TokenStatsHourlyEntry extends TokenStatsToday {
  hour: string;
}

export interface TokenStatsRecentPerformance {
  body_tokens_per_second?: number;
  first_text_seconds?: number;
  sample_count?: number;
}

export interface TokenStatsModel {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  request_count: number;
}

export type StatsRangeKey = 'today' | 'yesterday' | '3d' | '7d' | '30d';

export interface TokenStats {
  today?: TokenStatsToday;
  yesterday?: TokenStatsToday;
  last_3_days?: TokenStatsToday;
  last_7_days?: TokenStatsToday;
  last_30_days?: TokenStatsToday;
  daily?: TokenStatsDailyEntry[];
  hourly?: TokenStatsHourlyEntry[];
  recent_performance?: TokenStatsRecentPerformance;
  by_model_today?: TokenStatsModel[];
  by_model_yesterday?: TokenStatsModel[];
  by_model_3_days?: TokenStatsModel[];
  by_model_7_days?: TokenStatsModel[];
  /** agy-switch 的 30 天模型明细键名 */
  by_model?: TokenStatsModel[];
  generated_at?: number;
}

export interface AntigravityStatus {
  account: AccountInfo | null;
  stats: TokenStats | null;
  isAgyRunning: boolean;
  agyPid: number | null;
  lastUpdated: Date;
  error: string | null;
}

/**
 * 从 quota_groups 中归纳出的"配额族"：Gemini(基础)、Gemini 4、Claude/GPT。
 * Antigravity 后续为 Gemini 4 拆分独立配额组时，状态栏/仪表盘均按族展示。
 */
export interface QuotaFamily {
  key: 'gemini' | 'gemini-4' | 'claude-gpt';
  displayName: string;
  fiveHour: number | null;
  weekly: number | null;
  fiveHourReset?: string;
  weeklyReset?: string;
}

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
}

export interface AccountQuota {
  last_updated?: number;
  subscription_tier?: string | null;
  is_forbidden?: boolean;
  models?: ModelQuota[];
  quota_groups?: QuotaGroup[] | null;
}

export interface AccountInfo {
  id: string;
  email: string;
  name: string;
  custom_label?: string | null;
  disabled?: boolean;
  is_current?: boolean;
  last_used?: number | null;
  quota?: AccountQuota | null;
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

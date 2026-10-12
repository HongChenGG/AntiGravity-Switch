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

export interface TokenStats {
  today?: TokenStatsToday;
  yesterday?: TokenStatsToday;
  last_7_days?: TokenStatsToday;
  recent_performance?: TokenStatsRecentPerformance;
  by_model_today?: TokenStatsModel[];
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

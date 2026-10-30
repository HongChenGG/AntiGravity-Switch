import * as assert from 'assert';
import {
  computeEffectiveWindow,
  computePoolStats,
  extractQuotaFamiliesFromRaw,
  formatAccountQuickPickDisplay,
  formatCountdownCompact,
  formatCountdownHuman,
  formatShortLocalResetTime,
  fractionToPct,
  getAccountStatusEmoji,
  isClaudeModelName,
  isExplicitGemini4ModelName,
  isGemini38ModelName,
  isGemini4CapableModelName,
  isImageModelName,
  isOpus55ModelName,
  isOpusModelName,
  modelToPct,
  normalizeQuotaGroups,
  runBoundedBatchRefresh,
  sortAccountSummaries,
  sortGroupRank,
  summarizeAccount,
} from '../accountQuota';
import { AccountInfo, QuotaGroup } from '../types';

type TestCase = {
  name: string;
  fn: () => void | Promise<void>;
};

const registeredTests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  registeredTests.push({ name, fn });
}

const BASE_NOW_MS = Date.parse('2026-10-30T10:00:00.000Z');
const isoAfterHours = (hours: number, extraMinutes = 0): string =>
  new Date(BASE_NOW_MS + (hours * 60 + extraMinutes) * 60 * 1000).toISOString();

function makeAccount(overrides: Partial<AccountInfo> & { id: string; email: string }): AccountInfo {
  return {
    name: overrides.id,
    is_current: false,
    disabled: false,
    ...overrides,
  };
}

// ============================================================================
// 1. computeEffectiveWindow & summarizeAccount (min(5h, weekly) trap)
// ============================================================================

test('1.1 computeEffectiveWindow & summarizeAccount: 5h=99% (3h) + weekly=0% (20h) triggers weekly 0% trap and picks weekly reset timestamp', () => {
  const reset5h = isoAfterHours(3);
  const resetWeekly = isoAfterHours(20);

  const eff = computeEffectiveWindow(99, 0, reset5h, resetWeekly);
  assert.strictEqual(eff.effectivePct, 0);
  assert.strictEqual(eff.limitReason, 'weekly');
  assert.strictEqual(eff.effectiveResetTime, resetWeekly);

  const acc = makeAccount({
    id: 'weekly-trapped-pro',
    email: 'trapped@example.com',
    quota: {
      subscription_tier: 'Google AI Pro',
      models: [
        {
          name: 'gemini-3.8-flash-high',
          percentage: 99,
          observed_remaining_fraction: 0.99,
          reset_time: reset5h,
        },
      ],
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            {
              bucket_id: 'gemini-5h',
              window: '5h',
              remaining_fraction: 0.99,
              reset_time: reset5h,
            },
            {
              bucket_id: 'gemini-weekly',
              window: 'weekly',
              remaining_fraction: 0,
              reset_time: resetWeekly,
            },
          ],
        },
      ],
    },
  });

  const summary = summarizeAccount(acc, BASE_NOW_MS);
  assert.strictEqual(summary.gemini5hPct, 99);
  assert.strictEqual(summary.geminiWeeklyPct, 0);
  assert.strictEqual(summary.effectiveGeminiPct, 0);
  assert.strictEqual(summary.isRateLimited, true);
  assert.strictEqual(summary.geminiLimitReason, 'weekly');
  assert.strictEqual(summary.geminiResetTime, resetWeekly);
  assert.notStrictEqual(summary.geminiResetTime, reset5h);
});

test('1.2 computeEffectiveWindow: 5h=0% + weekly>0%, both=0% (picks later reset), and usable windows', () => {
  const r2h = isoAfterHours(2);
  const r40h = isoAfterHours(40);

  // Only 5h exhausted
  const fiveExhausted = computeEffectiveWindow(0, 82, r2h, r40h);
  assert.strictEqual(fiveExhausted.effectivePct, 0);
  assert.strictEqual(fiveExhausted.limitReason, '5h');
  assert.strictEqual(fiveExhausted.effectiveResetTime, r2h);

  // Both exhausted -> must wait for the LATER reset timestamp
  const bothExhausted = computeEffectiveWindow(0, 0, r2h, r40h);
  assert.strictEqual(bothExhausted.effectivePct, 0);
  assert.strictEqual(bothExhausted.limitReason, 'both');
  assert.strictEqual(bothExhausted.effectiveResetTime, r40h);

  // Both exhausted when 5h reset is later than weekly reset
  const r1h = isoAfterHours(1);
  const r4h = isoAfterHours(4);
  const bothFiveLater = computeEffectiveWindow(0, 0, r4h, r1h);
  assert.strictEqual(bothFiveLater.effectivePct, 0);
  assert.strictEqual(bothFiveLater.limitReason, 'both');
  assert.strictEqual(bothFiveLater.effectiveResetTime, r4h);

  // Usable: 5h < 100% prioritizes 5h reset; 5h == 100% & weekly < 100% shows weekly reset
  const usable5hConsumed = computeEffectiveWindow(75, 90, r2h, r40h);
  assert.strictEqual(usable5hConsumed.effectivePct, 75);
  assert.strictEqual(usable5hConsumed.limitReason, null);
  assert.strictEqual(usable5hConsumed.effectiveResetTime, r2h);

  const usableWeeklyConsumed = computeEffectiveWindow(100, 64, r2h, r40h);
  assert.strictEqual(usableWeeklyConsumed.effectivePct, 64);
  assert.strictEqual(usableWeeklyConsumed.limitReason, null);
  assert.strictEqual(usableWeeklyConsumed.effectiveResetTime, r40h);

  // Both null
  const empty = computeEffectiveWindow(null, null);
  assert.strictEqual(empty.effectivePct, null);
  assert.strictEqual(empty.effectiveResetTime, undefined);
  assert.strictEqual(empty.limitReason, null);
});

// ============================================================================
// 2. Independent Gemini 4 Argon Quota Group + claude-opus-5-5 Cohort Detection
// ============================================================================

test('2.1 G4 Argon + Opus 5.5 account: gemini-argon-wtu-weekly (34%) is independent from Gemini 3.8 pool (min(88, 95) = 88%)', () => {
  const reset5h = isoAfterHours(4);
  const resetWeekly = isoAfterHours(96);
  const resetArgon = isoAfterHours(120);

  const groups: QuotaGroup[] = [
    {
      display_name: 'Gemini Models',
      buckets: [
        {
          bucket_id: 'gemini-5h',
          window: '5h',
          remaining_fraction: 0.88,
          reset_time: reset5h,
        },
        {
          bucket_id: 'gemini-weekly',
          window: 'weekly',
          remaining_fraction: 0.95,
          reset_time: resetWeekly,
        },
      ],
    },
    {
      display_name: 'Claude and GPT models',
      buckets: [
        {
          bucket_id: '3p-5h',
          window: '5h',
          remaining_fraction: 1.0,
          reset_time: reset5h,
        },
        {
          bucket_id: '3p-weekly',
          window: 'weekly',
          remaining_fraction: 1.0,
          reset_time: resetWeekly,
        },
      ],
    },
    {
      display_name: 'Gemini 4 Argon',
      buckets: [
        {
          bucket_id: 'gemini-argon-wtu-weekly',
          window: 'weekly',
          remaining_fraction: 0.342,
          reset_time: resetArgon,
        },
      ],
    },
  ];

  const argonAcc = makeAccount({
    id: 'g4-argon-pro',
    email: 'argon-vip@example.com',
    quota: {
      subscription_tier: 'Google AI Pro',
      models: [
        {
          name: 'claude-opus-5-5-high',
          display_name: 'Claude Opus 5.5 (High)',
          percentage: 100,
          observed_remaining_fraction: 1.0,
          reset_time: reset5h,
        },
        {
          name: 'gemini-3.8-flash-high',
          percentage: 88,
          observed_remaining_fraction: 0.88,
          reset_time: reset5h,
        },
      ],
      quota_groups: groups,
    },
  });

  const summary = summarizeAccount(argonAcc, BASE_NOW_MS);
  assert.strictEqual(summary.hasGemini4, true);
  assert.strictEqual(summary.hasOpus55, true);
  assert.strictEqual(summary.hasOpus, true);
  assert.strictEqual(summary.hasClaude, true);
  assert.strictEqual(summary.hasGemini38, true);
  assert.strictEqual(summary.g4Pct, 34);
  assert.strictEqual(summary.g4WeeklyPct, 34);
  assert.strictEqual(summary.g4FiveHourPct, null);
  assert.strictEqual(summary.g4SharesGeminiPool, false);
  assert.strictEqual(summary.g4ResetTime, resetArgon);
  assert.strictEqual(summary.gemini5hPct, 88);
  assert.strictEqual(summary.geminiWeeklyPct, 95);
  assert.strictEqual(summary.effectiveGeminiPct, 88);
  assert.strictEqual(summary.effectiveClaudePct, 100);
  assert.deepStrictEqual(summary.capabilityTags, ['G4', 'Opus 5.5', '3.8']);

  // Prove independence when Gemini 3.8 weekly is 0%: g4Pct stays 34% and does not drop to 0%!
  const argonWith38Exhausted = summarizeAccount(
    makeAccount({
      ...argonAcc,
      id: 'g4-argon-38-zero',
      email: 'argon-38zero@example.com',
      quota: {
        ...argonAcc.quota,
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.9, window: '5h', reset_time: reset5h },
          'gemini-weekly': { remaining_fraction: 0, window: 'weekly', reset_time: resetWeekly },
          '3p-5h': { remaining_fraction: 1.0, window: '5h', reset_time: reset5h },
          'gemini-argon-wtu-weekly': {
            remaining_fraction: 0.342,
            window: 'weekly',
            reset_time: resetArgon,
          },
        },
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(argonWith38Exhausted.effectiveGeminiPct, 0);
  assert.strictEqual(argonWith38Exhausted.g4Pct, 34);
});

test('2.2 Standard Pro account (claude-opus-4-6-thinking M26 + gemini-3.8-flash-high): hasGemini4=false, hasOpus=true, hasOpus55=false, hasGemini38=true', () => {
  const reset5h = isoAfterHours(4);
  const resetWeekly = isoAfterHours(72);

  const stdPro = makeAccount({
    id: 'std-pro-m26',
    email: 'std-pro@example.com',
    quota: {
      subscription_tier: 'Google AI Pro',
      models: [
        {
          name: 'claude-opus-4-6-thinking',
          display_name: 'Claude Opus 4.6 (Thinking) [M26]',
          percentage: 90,
          observed_remaining_fraction: 0.9,
          reset_time: reset5h,
        },
        {
          name: 'gemini-3.8-flash-high',
          display_name: 'Gemini 3.8 Flash High',
          percentage: 85,
          observed_remaining_fraction: 0.85,
          reset_time: reset5h,
        },
      ],
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.85, reset_time: reset5h },
            {
              bucket_id: 'gemini-weekly',
              window: 'weekly',
              remaining_fraction: 0.92,
              reset_time: resetWeekly,
            },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 0.9, reset_time: reset5h },
          ],
        },
      ],
    },
  });

  const summary = summarizeAccount(stdPro, BASE_NOW_MS);
  assert.strictEqual(summary.hasGemini4, false);
  assert.strictEqual(summary.hasOpus, true);
  assert.strictEqual(summary.hasOpus55, false);
  assert.strictEqual(summary.hasGemini38, true);
  assert.strictEqual(summary.g4Pct, null);
  assert.deepStrictEqual(summary.capabilityTags, ['Opus', '3.8']);
});

// ============================================================================
// 3. True Paid vs Free Starter Tier Resolution (resolveTier via summarizeAccount)
// ============================================================================

test('3.1 Antigravity Starter Quota resolves to Free tier (including image-only Free variant)', () => {
  const starter = summarizeAccount(
    makeAccount({
      id: 'starter-1',
      email: 'starter@example.com',
      quota: {
        subscription_tier: 'Antigravity Starter Quota',
        models: [
          {
            name: 'gemini-2.5-flash-lite',
            percentage: 100,
            reset_time: isoAfterHours(120),
          },
        ],
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(starter.isFreeTier, true);
  assert.strictEqual(starter.isPaidTier, false);
  assert.strictEqual(starter.tierKind, 'free');
  assert.strictEqual(starter.tierDisplay, 'Free');

  const imageOnlyStarter = summarizeAccount(
    makeAccount({
      id: 'starter-img',
      email: 'starter-img@example.com',
      quota: {
        subscription_tier: 'Antigravity Starter Quota',
        models: [
          {
            name: 'gemini-3.1-flash-image',
            percentage: 80,
            reset_time: isoAfterHours(120),
          },
        ],
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(imageOnlyStarter.isFreeTier, true);
  assert.strictEqual(imageOnlyStarter.tierKind, 'free');
  assert.strictEqual(imageOnlyStarter.tierDisplay, 'Free(仅生图)');
});

test('3.2 Legacy "free-tier" or null subscription_tier with 5h bucket / Opus 4.6 / is_gcp_tos resolves to pro or gcp (isPaidTier=true)', () => {
  const reset5h = isoAfterHours(3);
  const resetWeekly = isoAfterHours(100);

  // Legacy "free-tier" with 5h bucket -> Pro
  const legacyPro = summarizeAccount(
    makeAccount({
      id: 'legacy-pro',
      email: 'legacy-pro@example.com',
      project_id: 'aicode-consumers',
      is_gcp_tos: false,
      quota: {
        subscription_tier: 'free-tier',
        models: [
          { name: 'claude-opus-4-6-thinking', percentage: 100, reset_time: reset5h },
          { name: 'gemini-3.8-flash-high', percentage: 95, reset_time: reset5h },
        ],
        quota_groups: [
          {
            display_name: 'Gemini Models',
            buckets: [
              { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.95, reset_time: reset5h },
            ],
          },
        ],
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(legacyPro.tierKind, 'pro');
  assert.strictEqual(legacyPro.isPaidTier, true);
  assert.strictEqual(legacyPro.isFreeTier, false);

  // Legacy "free-tier" with is_gcp_tos: true and claude-opus-4-6-thinking -> GCP
  const legacyGcpTos = summarizeAccount(
    makeAccount({
      id: 'legacy-gcp-tos',
      email: 'gcp-tos@example.com',
      is_gcp_tos: true,
      quota: {
        subscription_tier: 'free-tier',
        models: [
          { name: 'claude-opus-4-6-thinking', percentage: 100, reset_time: resetWeekly },
        ],
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(legacyGcpTos.tierKind, 'gcp');
  assert.strictEqual(legacyGcpTos.isPaidTier, true);
  assert.strictEqual(legacyGcpTos.isFreeTier, false);

  // Null subscription_tier without 5h bucket + custom GCP project_id + paid model -> GCP
  const nullTierGcp = summarizeAccount(
    makeAccount({
      id: 'null-tier-gcp',
      email: 'null-gcp@example.com',
      project_id: 'my-enterprise-gcp-123',
      quota: {
        subscription_tier: null,
        models: [
          {
            name: 'claude-opus-4-6-thinking',
            percentage: 88,
            quota_bucket_id: '3p-weekly',
            reset_time: resetWeekly,
          },
        ],
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(nullTierGcp.tierKind, 'gcp');
  assert.strictEqual(nullTierGcp.isPaidTier, true);
  assert.strictEqual(nullTierGcp.isFreeTier, false);

  // Null subscription_tier WITH 5h bucket -> Pro
  const nullTierPro = summarizeAccount(
    makeAccount({
      id: 'null-tier-pro',
      email: 'null-pro@example.com',
      project_id: 'aicode-consumers',
      quota: {
        subscription_tier: null,
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.77, window: '5h', reset_time: reset5h },
        },
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(nullTierPro.tierKind, 'pro');
  assert.strictEqual(nullTierPro.isPaidTier, true);
  assert.strictEqual(nullTierPro.isFreeTier, false);

  // True legacy "free-tier" WITHOUT any paid signals -> remains Free
  const trueFreeLegacy = summarizeAccount(
    makeAccount({
      id: 'true-free-legacy',
      email: 'true-free@example.com',
      quota: {
        subscription_tier: 'free-tier',
        models: [
          {
            name: 'gemini-2.5-flash-lite',
            percentage: 50,
            quota_bucket_id: 'lite-weekly',
            reset_time: resetWeekly,
          },
        ],
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(trueFreeLegacy.tierKind, 'free');
  assert.strictEqual(trueFreeLegacy.isFreeTier, true);
  assert.strictEqual(trueFreeLegacy.isPaidTier, false);

  // Explicit Ultra / Plus / Unknown tiers
  const ultra = summarizeAccount(
    makeAccount({
      id: 'ultra-1',
      email: 'ultra@example.com',
      quota: { subscription_tier: 'Google AI Ultra' },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(ultra.tierKind, 'ultra');
  assert.strictEqual(ultra.isPaidTier, true);

  const plus = summarizeAccount(
    makeAccount({
      id: 'plus-1',
      email: 'plus@example.com',
      quota: { subscription_tier: 'Google AI Plus' },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(plus.tierKind, 'plus');
  assert.strictEqual(plus.isPaidTier, true);

  const unsynced = summarizeAccount(
    makeAccount({ id: 'unsynced-1', email: 'unsynced@example.com', quota: null }),
    BASE_NOW_MS
  );
  assert.strictEqual(unsynced.tierKind, 'unknown');
  assert.strictEqual(unsynced.isPaidTier, false);
  assert.strictEqual(unsynced.isFreeTier, false);
});

// ============================================================================
// 4. Reset Countdown Formatting (formatCountdownHuman & formatCountdownCompact)
// ============================================================================

test('4.1 formatCountdownHuman & formatCountdownCompact: days+hours, hours+minutes, minutes, past, and missing/invalid', () => {
  // Days + hours: 3d 18h (+ 20m truncated to hours in day view)
  const target3d18h = isoAfterHours(3 * 24 + 18, 20);
  assert.strictEqual(formatCountdownHuman(target3d18h, BASE_NOW_MS), '3天18小时后');
  assert.strictEqual(formatCountdownCompact(target3d18h, BASE_NOW_MS), '3d18h');

  // Hours + minutes: 3h 16m
  const target3h16m = isoAfterHours(3, 16);
  assert.strictEqual(formatCountdownHuman(target3h16m, BASE_NOW_MS), '3小时16分后');
  assert.strictEqual(formatCountdownCompact(target3h16m, BASE_NOW_MS), '3h16m');

  // Minutes: 15m
  const target15m = isoAfterHours(0, 15);
  assert.strictEqual(formatCountdownHuman(target15m, BASE_NOW_MS), '15分钟后');
  assert.strictEqual(formatCountdownCompact(target15m, BASE_NOW_MS), '15m');

  // Sub-minute positive remaining (< 60s) clamps to 1m
  const target20s = new Date(BASE_NOW_MS + 20 * 1000).toISOString();
  assert.strictEqual(formatCountdownHuman(target20s, BASE_NOW_MS), '1分钟后');
  assert.strictEqual(formatCountdownCompact(target20s, BASE_NOW_MS), '1m');

  // Past or exact current timestamp -> 已重置
  const pastIso = new Date(BASE_NOW_MS - 60 * 1000).toISOString();
  const exactNowIso = new Date(BASE_NOW_MS).toISOString();
  assert.strictEqual(formatCountdownHuman(pastIso, BASE_NOW_MS), '已重置');
  assert.strictEqual(formatCountdownCompact(pastIso, BASE_NOW_MS), '已重置');
  assert.strictEqual(formatCountdownHuman(exactNowIso, BASE_NOW_MS), '已重置');
  assert.strictEqual(formatCountdownCompact(exactNowIso, BASE_NOW_MS), '已重置');

  // Missing / empty / invalid
  assert.strictEqual(formatCountdownHuman(undefined, BASE_NOW_MS), '未知');
  assert.strictEqual(formatCountdownHuman(null, BASE_NOW_MS), '未知');
  assert.strictEqual(formatCountdownHuman('', BASE_NOW_MS), '未知');
  assert.strictEqual(formatCountdownHuman('invalid-iso-text', BASE_NOW_MS), 'invalid-iso-text');

  assert.strictEqual(formatCountdownCompact(undefined, BASE_NOW_MS), '--');
  assert.strictEqual(formatCountdownCompact(null, BASE_NOW_MS), '--');
  assert.strictEqual(formatCountdownCompact('', BASE_NOW_MS), '--');
  assert.strictEqual(formatCountdownCompact('invalid-iso-text', BASE_NOW_MS), '--');
});

// ============================================================================
// 5. Smart Account Sorting (sortAccountSummaries) & Pool Stats (computePoolStats)
// ============================================================================

test('5.1 sortAccountSummaries & computePoolStats: full priority ordering and accurate pool metrics', () => {
  const reset1h = isoAfterHours(1);
  const reset3h = isoAfterHours(3);
  const reset12h = isoAfterHours(12);
  const reset72h = isoAfterHours(72);

  // 1) Current active account (even if rate-limited, must always be #1)
  const currentAcc = summarizeAccount(
    makeAccount({
      id: 'current',
      email: 'z-current@example.com',
      is_current: true,
      quota: {
        subscription_tier: 'Google AI Pro',
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0, window: '5h', reset_time: reset3h },
        },
      },
    }),
    BASE_NOW_MS
  );

  // 2) Usable G4 + Opus 5.5 Pro accounts (60% and 92% -> 92% before 60%, and both before 99% non-G4!)
  const usableG4High = summarizeAccount(
    makeAccount({
      id: 'g4-92',
      email: 'g4-high@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'claude-opus-5-5-high', percentage: 100, reset_time: reset3h }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.92, window: '5h', reset_time: reset3h },
          'gemini-argon-wtu-weekly': {
            remaining_fraction: 0.8,
            window: 'weekly',
            reset_time: reset72h,
          },
        },
      },
    }),
    BASE_NOW_MS
  );

  const usableG4Mid = summarizeAccount(
    makeAccount({
      id: 'g4-60',
      email: 'g4-mid@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'claude-opus-5-5-high', percentage: 100, reset_time: reset3h }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.6, window: '5h', reset_time: reset3h },
          'gemini-argon-wtu-weekly': {
            remaining_fraction: 0.45,
            window: 'weekly',
            reset_time: reset72h,
          },
        },
      },
    }),
    BASE_NOW_MS
  );

  // 3) Usable non-G4 3.8 Pro accounts (99% then 70%)
  const usable38High = summarizeAccount(
    makeAccount({
      id: 'pro38-99',
      email: 'pro38-high@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'gemini-3.8-flash-high', percentage: 99, reset_time: reset3h }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.99, window: '5h', reset_time: reset3h },
        },
      },
    }),
    BASE_NOW_MS
  );

  const usable38Low = summarizeAccount(
    makeAccount({
      id: 'pro38-70',
      email: 'pro38-low@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'gemini-3.8-flash-high', percentage: 70, reset_time: reset3h }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.7, window: '5h', reset_time: reset3h },
        },
      },
    }),
    BASE_NOW_MS
  );

  // 4) Rate-limited (0%) Paid accounts:
  //    Note: a G4 account whose BOTH 3.8 and G4 pools are 0% has rank 2 (rate-limited),
  //    and sorts ahead of non-G4 rate-limited accounts; non-G4 rate-limited sort by earliest reset time!
  const limitedG4 = summarizeAccount(
    makeAccount({
      id: 'lim-g4',
      email: 'lim-g4@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'claude-opus-5-5-high', percentage: 0, reset_time: reset12h }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0, window: '5h', reset_time: reset12h },
          'gemini-argon-wtu-weekly': {
            remaining_fraction: 0,
            window: 'weekly',
            reset_time: reset72h,
          },
        },
      },
    }),
    BASE_NOW_MS
  );

  const limited38Early = summarizeAccount(
    makeAccount({
      id: 'lim-38-1h',
      email: 'lim-early@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0, window: '5h', reset_time: reset1h },
        },
      },
    }),
    BASE_NOW_MS
  );

  const limited38Late = summarizeAccount(
    makeAccount({
      id: 'lim-38-12h',
      email: 'lim-late@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.95, window: '5h', reset_time: reset3h },
          'gemini-weekly': { remaining_fraction: 0, window: 'weekly', reset_time: reset12h },
        },
      },
    }),
    BASE_NOW_MS
  );

  // 5) Free Starter account
  const freeStarter = summarizeAccount(
    makeAccount({
      id: 'free-1',
      email: 'free@example.com',
      quota: {
        subscription_tier: 'Antigravity Starter Quota',
        models: [{ name: 'gemini-2.5-flash-lite', percentage: 100, reset_time: reset72h }],
      },
    }),
    BASE_NOW_MS
  );

  // 6) Forbidden & Disabled accounts (bottom)
  const forbiddenAcc = summarizeAccount(
    makeAccount({
      id: 'forbidden-1',
      email: 'a-forbidden@example.com',
      quota: {
        subscription_tier: 'Google AI Pro',
        is_forbidden: true,
        forbidden_reason: '403 Forbidden',
      },
    }),
    BASE_NOW_MS
  );

  const disabledAcc = summarizeAccount(
    makeAccount({
      id: 'disabled-1',
      email: 'b-disabled@example.com',
      disabled: true,
      quota: {
        subscription_tier: 'Google AI Pro',
        quota_groups: {
          'gemini-5h': { remaining_fraction: 1.0, window: '5h', reset_time: reset3h },
        },
      },
    }),
    BASE_NOW_MS
  );

  const shuffled = [
    forbiddenAcc,
    freeStarter,
    limited38Late,
    usable38Low,
    disabledAcc,
    usableG4Mid,
    limited38Early,
    usable38High,
    limitedG4,
    currentAcc,
    usableG4High,
  ];
  const originalSnapshot = shuffled.map((a) => a.id);

  const sorted = sortAccountSummaries(shuffled);

  // Verify input immutability
  assert.deepStrictEqual(
    shuffled.map((a) => a.id),
    originalSnapshot
  );

  // Verify exact smart priority order
  assert.deepStrictEqual(
    sorted.map((a) => a.id),
    [
      'current',
      'g4-92',
      'g4-60',
      'pro38-99',
      'pro38-70',
      'lim-g4',
      'lim-38-1h',
      'lim-38-12h',
      'free-1',
      'a-forbidden',
      'b-disabled',
    ].map((expectedId) => {
      // Map email-sorted rank 5 IDs accurately
      if (expectedId === 'a-forbidden') return 'forbidden-1';
      if (expectedId === 'b-disabled') return 'disabled-1';
      return expectedId;
    })
  );

  assert.strictEqual(sortGroupRank(currentAcc), 0);
  assert.strictEqual(sortGroupRank(usableG4High), 1);
  assert.strictEqual(sortGroupRank(limitedG4), 2);
  assert.strictEqual(sortGroupRank(freeStarter), 4);
  assert.strictEqual(sortGroupRank(forbiddenAcc), 5);
  assert.strictEqual(sortGroupRank(disabledAcc), 5);

  // Verify computePoolStats across the 11 accounts:
  // - total: 11
  // - forbidden/disabled: 2 (forbiddenAcc + disabledAcc)
  // - totalG4 (active): 3 (usableG4High, usableG4Mid, limitedG4)
  // - usableG4: 2 (usableG4High, usableG4Mid)
  // - usableGemini (>0%, including Free): 5 (g4-92, g4-60, pro38-99, pro38-70, free-1)
  // - usablePaidGemini (>0% & paid): 4 (g4-92, g4-60, pro38-99, pro38-70)
  // - rateLimited (active 0%): 4 (currentAcc, limitedG4, limited38Early, limited38Late)
  const stats = computePoolStats(sorted);
  assert.deepStrictEqual(stats, {
    total: 11,
    usableGemini: 5,
    usablePaidGemini: 4,
    usableG4: 2,
    totalG4: 3,
    rateLimited: 4,
    forbidden: 2,
  });
});

// ============================================================================
// 6. Bounded Concurrency Batch Refresh (runBoundedBatchRefresh)
// ============================================================================

test('6.1 runBoundedBatchRefresh: enforces default max concurrency <= 5, isolates errors, and reports progress', async () => {
  const items = Array.from({ length: 14 }, (_, i) => ({
    id: `acc-${i + 1}`,
    email: `user${i + 1}@example.com`,
  }));

  let activeWorkers = 0;
  let peakActiveWorkers = 0;
  const progressEvents: Array<{ completed: number; total: number; email: string }> = [];

  const result = await runBoundedBatchRefresh(
    items,
    async (item) => {
      activeWorkers++;
      if (activeWorkers > peakActiveWorkers) {
        peakActiveWorkers = activeWorkers;
      }

      await new Promise((resolve) => setTimeout(resolve, 15));

      activeWorkers--;

      // Mix of success, soft failure ({ success: false }), and hard rejection
      if (item.id === 'acc-3' || item.id === 'acc-11') {
        return { success: false };
      }
      if (item.id === 'acc-7' || item.id === 'acc-13') {
        throw new Error(`Simulated network timeout for ${item.email}`);
      }
      return { success: true };
    },
    {
      onProgress: (completed, total, email) => {
        progressEvents.push({ completed, total, email });
        // Also ensure throwing inside onProgress never crashes the batch worker
        if (completed === 5) {
          throw new Error('UI callback glitch');
        }
      },
    }
  );

  assert.ok(
    peakActiveWorkers <= 5,
    `Expected peak concurrency <= 5, got ${peakActiveWorkers}`
  );
  assert.strictEqual(peakActiveWorkers, 5);
  assert.strictEqual(activeWorkers, 0);
  assert.deepStrictEqual(result, {
    total: 14,
    succeeded: 10,
    failed: 4,
  });
  assert.strictEqual(progressEvents.length, 14);
  assert.deepStrictEqual(
    progressEvents.map((e) => e.completed),
    Array.from({ length: 14 }, (_, i) => i + 1)
  );
  assert.ok(progressEvents.every((e) => e.total === 14));
});

test('6.2 runBoundedBatchRefresh: handles empty list and custom concurrency bound', async () => {
  const emptyRes = await runBoundedBatchRefresh([], async () => ({ success: true }));
  assert.deepStrictEqual(emptyRes, { total: 0, succeeded: 0, failed: 0 });

  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `c-${i}`,
    email: `c${i}@example.com`,
  }));
  let active = 0;
  let maxActive = 0;
  const customRes = await runBoundedBatchRefresh(
    items,
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { success: true };
    },
    { concurrency: 2 }
  );
  assert.strictEqual(maxActive, 2);
  assert.deepStrictEqual(customRes, { total: 6, succeeded: 6, failed: 0 });
});

// ============================================================================
// 7. Helper & Formatting Edge Cases (Public API Completeness)
// ============================================================================

test('7.1 Model & fraction helpers, quota normalization, and QuickPick display formatting', () => {
  assert.strictEqual(fractionToPct(null), null);
  assert.strictEqual(fractionToPct(undefined), null);
  assert.strictEqual(fractionToPct(NaN), null);
  assert.strictEqual(fractionToPct(0.342), 34);
  assert.strictEqual(fractionToPct(1.5), 100);
  assert.strictEqual(fractionToPct(-0.2), 0);

  assert.strictEqual(modelToPct(null), null);
  assert.strictEqual(
    modelToPct({
      name: 'gemini-3.8-flash-high',
      percentage: 90,
      observed_remaining_fraction: 0.456,
      reset_time: '',
    }),
    46
  );

  assert.strictEqual(isExplicitGemini4ModelName('Gemini 4 Argon (High)'), true);
  assert.strictEqual(isExplicitGemini4ModelName('m402'), true);
  assert.strictEqual(isExplicitGemini4ModelName('claude-opus-5-5-high'), false);
  assert.strictEqual(isGemini4CapableModelName('claude-opus-5-5-high'), true);
  assert.strictEqual(isGemini4CapableModelName('claude-opus-4-6-thinking'), false);
  assert.strictEqual(isGemini38ModelName('gemini-3.8-flash-high'), true);
  assert.strictEqual(isGemini38ModelName('gemini-3-1-pro'), true);
  assert.strictEqual(isClaudeModelName('claude-sonnet-4-5'), true);
  assert.strictEqual(isOpusModelName('claude-opus-4-6-thinking'), true);
  assert.strictEqual(isOpus55ModelName('claude-opus-5-5-high'), true);
  assert.strictEqual(isOpus55ModelName('claude-opus-4-6-thinking'), false);
  assert.strictEqual(isImageModelName('gemini-3.1-flash-image'), true);

  // Dictionary normalization + family extraction
  const normalized = normalizeQuotaGroups({
    'gemini-5h': { remainingFraction: 0.8, resetTime: isoAfterHours(2) },
    'gemini-argon-wtu-weekly': { remainingFraction: 0.5, resetTime: isoAfterHours(80) },
    '3p-5h': { percentage: 75, resetTime: isoAfterHours(3) },
  });
  assert.strictEqual(normalized.length, 3);
  const fams = extractQuotaFamiliesFromRaw(normalized);
  assert.strictEqual(fams.find((f) => f.key === 'gemini')?.fiveHour, 0.8);
  assert.strictEqual(fams.find((f) => f.key === 'gemini-4')?.weekly, 0.5);
  assert.strictEqual(fams.find((f) => f.key === 'claude-gpt')?.fiveHour, 0.75);

  // QuickPick display + status emoji + short local reset time
  const resetIso = isoAfterHours(2);
  assert.ok(formatShortLocalResetTime(resetIso, BASE_NOW_MS).length >= 5);
  assert.strictEqual(formatShortLocalResetTime('bad-date', BASE_NOW_MS), '');

  const summary = summarizeAccount(
    makeAccount({
      id: 'qp-g4',
      email: 'qp@example.com',
      is_current: true,
      quota: {
        subscription_tier: 'Google AI Pro',
        last_updated: Math.floor(BASE_NOW_MS / 1000),
        models: [{ name: 'claude-opus-5-5-high', percentage: 100, reset_time: resetIso }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.88, window: '5h', reset_time: resetIso },
          'gemini-weekly': {
            remaining_fraction: 0.95,
            window: 'weekly',
            reset_time: isoAfterHours(96),
          },
          'gemini-argon-wtu-weekly': {
            remaining_fraction: 0.34,
            window: 'weekly',
            reset_time: isoAfterHours(120),
          },
        },
      },
    }),
    BASE_NOW_MS
  );
  assert.strictEqual(getAccountStatusEmoji(summary), '🟢');
  const qp = formatAccountQuickPickDisplay(summary, BASE_NOW_MS);
  assert.ok(qp.label.includes('🔥 qp@example.com  (当前)'));
  assert.ok(qp.description.includes('G4: 34%'));
  assert.ok(qp.description.includes('3.8: 88%(5h)/95%(周)'));
  assert.ok(qp.detail.includes('🔥G4 Argon(独立周池): 34%'));
});

test('8.1 Dashboard Account Pool HTML renderer: renders G4 independent pool, reset countdowns, switch actions, and escapes XSS', () => {
  const {
    classifyAccountPoolFilters,
    getAccountPoolStyles,
    renderAccountPoolSection,
  } = require('../dashboardAccountPool') as typeof import('../dashboardAccountPool');

  assert.ok(getAccountPoolStyles().includes('.ag-pool-table'));
  assert.ok(renderAccountPoolSection([], BASE_NOW_MS).includes('未检测到本地账号'));

  const g4Current = summarizeAccount(
    makeAccount({
      id: 'acc-g4-cur',
      email: 'hollimas723@gmail.com',
      is_current: true,
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'claude-opus-5-5-high', percentage: 100, reset_time: isoAfterHours(4) }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.88, window: '5h', reset_time: isoAfterHours(3) },
          'gemini-weekly': {
            remaining_fraction: 0.95,
            window: 'weekly',
            reset_time: isoAfterHours(144),
          },
          '3p-5h': { remaining_fraction: 1.0, window: '5h', reset_time: isoAfterHours(4) },
          '3p-weekly': {
            remaining_fraction: 1.0,
            window: 'weekly',
            reset_time: isoAfterHours(160),
          },
          'gemini-argon-wtu-weekly': {
            remaining_fraction: 0.148,
            window: 'weekly',
            reset_time: isoAfterHours(165),
          },
        },
      },
    }),
    BASE_NOW_MS
  );

  const coolingXss = summarizeAccount(
    makeAccount({
      id: 'id"><script>alert(1)</script>',
      email: 'cool<xss>@gmail.com',
      is_current: false,
      quota: {
        subscription_tier: 'Google AI Pro',
        models: [{ name: 'gemini-3.8-flash-high', percentage: 99, reset_time: isoAfterHours(2) }],
        quota_groups: {
          'gemini-5h': { remaining_fraction: 0.99, window: '5h', reset_time: isoAfterHours(2) },
          'gemini-weekly': {
            remaining_fraction: 0,
            window: 'weekly',
            reset_time: isoAfterHours(14),
          },
        },
      },
    }),
    BASE_NOW_MS
  );

  assert.deepStrictEqual(classifyAccountPoolFilters(g4Current), ['all', 'g4']);
  assert.deepStrictEqual(classifyAccountPoolFilters(coolingXss), ['all', 'pro']);

  const html = renderAccountPoolSection([g4Current, coolingXss], BASE_NOW_MS);
  assert.ok(html.includes('🔥 G4 独立周池'));
  assert.ok(html.includes('15%'));
  assert.ok(html.includes('✓ 当前激活'));
  assert.ok(html.includes('🔴 周限额耗尽'));
  assert.ok(html.includes('data-action="switch-acc"'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

async function runAll(): Promise<void> {
  let passed = 0;
  for (const t of registeredTests) {
    try {
      await t.fn();
      passed++;
    } catch (err) {
      console.error(`FAIL: ${t.name}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`ALL TESTS PASSED (${passed} tests)`);
}

void runAll();

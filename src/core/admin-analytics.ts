// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/admin-analytics.ts, emitted by
// `pnpm --filter @jotnow/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { z } from 'zod';

/**
 * The `/admin` dashboard's wire contract (`plans/admin-analytics.md` §5).
 *
 * Three independent sources answer one request: Postgres (product), Lemon
 * Squeezy (revenue) and Cloudflare Web Analytics (traffic). Only `product` is
 * guaranteed — it is computed by `public.admin_analytics_product(p_days, p_day_to)`,
 * whose jsonb this schema mirrors verbatim so the Edge Function passes it
 * through after validating it. The two provider sections are discriminated
 * unions on `status`, because a provider that is not configured, or that is
 * down, must degrade its own card and never the response: the function
 * validates against this schema before it replies, so a provider *shape drift*
 * becomes `status: 'error'` rather than a 500.
 *
 * Everything here is an aggregate. No note body, title, Recall query or Recall
 * answer is read, counted by content, or returned — the privacy page's
 * promise that no analytics profile is built from note content is a property
 * of this shape, not of the UI that renders it.
 *
 * `supabase/functions/admin-analytics/schema.ts` is the server's mirror of
 * this file: the Deno/npm boundary keeps Edge Functions from importing
 * `@jotnow/core` (see `_shared/tidy-clarify.ts` for the same arrangement), so
 * the two must be changed together.
 */

/** A UTC calendar date, `YYYY-MM-DD`. Every bucket in this file is a UTC day. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A countable quantity. Never negative, never fractional. */
const count = z.number().int().nonnegative();

/** Integer cents. Signed, because a refund-heavy window can net negative. */
const cents = z.number().int();

export const AdminAnalyticsDaySeriesSchema = z.array(z.object({ date: isoDate, count }));
export type AdminAnalyticsDaySeries = z.infer<typeof AdminAnalyticsDaySeriesSchema>;

/**
 * How many UTC days the dashboard asks for, ending today inclusive. The UI
 * offers 7/30/90; the function accepts the whole 1..365 band so a URL or a
 * future control is not a protocol change. The upper bound is what stops a
 * caller turning one admin request into a year-long provider sweep.
 */
export const AdminAnalyticsRequestSchema = z.object({
  days: z.number().int().min(1).max(365),
});
export type AdminAnalyticsRequest = z.infer<typeof AdminAnalyticsRequestSchema>;

export const AdminAnalyticsProductSchema = z.object({
  users: z.object({
    total: count,
    confirmed: count,
    new_in_range: count,
    signups_by_day: AdminAnalyticsDaySeriesSchema,
  }),
  /**
   * Activity is a union of last-write timestamps (`notes.updated_at`,
   * `api_keys.last_used_at`, `auth.users.last_sign_in_at`) and true event
   * timestamps. Only the latest value of each survives, so **past days
   * undercount** and the UI says so under the chart.
   */
  active: z.object({ by_day: AdminAnalyticsDaySeriesSchema, wau: count, mau: count }),
  notes: z.object({
    live: count,
    trashed: count,
    created_in_range: count,
    by_day: z.array(z.object({ date: isoDate, web: count, mcp: count, cli: count, vscode: count })),
    /** `percentile_cont`, so genuinely fractional — not a count. */
    per_user: z.object({ p50: z.number().nonnegative(), p90: z.number().nonnegative() }),
  }),
  plans: z.object({ free: count, pro: count }),
  recall: z.object({
    in_range: count,
    users_in_range: count,
    by_day: AdminAnalyticsDaySeriesSchema,
  }),
  tidy: z.object({
    in_range: count,
    by_day: z.array(
      z.object({ date: isoDate, applied: count, failed: count, reverted: count, running: count }),
    ),
  }),
  /** The *current billing period* per user, not the range — dictation is metered per period. */
  dictation: z.object({ seconds_current_period: count, users_current_period: count }),
  mcp: z.object({
    keys_live: count,
    keys_used_7d: count,
    keys_used_30d: count,
    users_with_key: count,
  }),
  /** All-time, monotonically narrowing: each step is a subset of the one before it. */
  funnel: z.object({
    signed_up: count,
    created_note: count,
    connected_agent: count,
    asked_recall: count,
    pro: count,
  }),
  /**
   * The last eight signup weeks (Monday-start, UTC), newest last. `active[k]`
   * is how many of that cohort showed an activity signal in week k after
   * signup, and `null` means that week has not happened yet — a distinct
   * state from zero, which the grid renders as blank rather than as 0%.
   * Always eight entries so the row aligns with the header.
   */
  cohorts: z
    .array(
      z.object({
        week: isoDate,
        size: count,
        active: z.array(count.nullable()).length(8),
      }),
    )
    .max(8),
});
export type AdminAnalyticsProduct = z.infer<typeof AdminAnalyticsProductSchema>;

/**
 * `unconfigured` means the deployment holds no credential for the provider —
 * an expected state, not a fault, and the card says which secret to set.
 * `error` carries a short code or one sentence; a provider body is never
 * echoed, because it can contain the credential's own error text.
 */
export const AdminAnalyticsRevenueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unconfigured') }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({
    status: z.literal('ok'),
    /**
     * True when any returned object is a Lemon Squeezy test object. Lemon
     * Squeezy separates test and live data by API key, not by a request flag,
     * so this badge is the only thing between "revenue" and a test-key
     * rehearsal (prod holds test keys on purpose today).
     */
    test_mode: z.boolean(),
    /**
     * True when a bounded read stopped short of the provider's data: an
     * endpoint whose `meta.page.lastPage` was past the page budget, or more
     * distinct prices than the lookup budget. The totals below are then a
     * FLOOR, not the truth, and the page says so — a capped sweep that
     * reported a small number as final is the failure mode the bound exists
     * to avoid, and hiding it would trade an unbounded loop for a quiet lie.
     */
    truncated: z.boolean(),
    currency: z.string(),
    mrr_cents: cents,
    subscriptions: z.object({
      on_trial: count,
      active: count,
      past_due: count,
      paused: count,
      unpaid: count,
      cancelled: count,
      expired: count,
    }),
    new_in_range: count,
    churned_in_range: count,
    new_by_day: AdminAnalyticsDaySeriesSchema,
    churned_by_day: AdminAnalyticsDaySeriesSchema,
    revenue_in_range_cents: cents,
    refunded_in_range_cents: cents,
    invoices_paid_in_range: count,
  }),
]);
export type AdminAnalyticsRevenue = z.infer<typeof AdminAnalyticsRevenueSchema>;

export const AdminAnalyticsTrafficSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unconfigured') }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({
    status: z.literal('ok'),
    /**
     * The range that was requested, echoed back. It is NOT narrowed to the
     * days that had traffic: Web Analytics retention is plan-dependent, and
     * an empty day is indistinguishable from an aged-out one, so the section
     * returns the full window and the page carries a footnote saying that
     * days before the retention window are empty rather than zero.
     */
    from: isoDate,
    to: isoDate,
    by_day: z.array(z.object({ date: isoDate, page_views: count, visits: count })),
    by_host: z.array(z.object({ host: z.string(), page_views: count, visits: count })),
    top_paths: z.array(
      z.object({ host: z.string(), path: z.string(), page_views: count, visits: count }),
    ),
    top_referrers: z.array(z.object({ referrer: z.string(), visits: count })),
  }),
]);
export type AdminAnalyticsTraffic = z.infer<typeof AdminAnalyticsTrafficSchema>;

export const AdminAnalyticsSchema = z.object({
  generated_at: z.string().datetime({ offset: true }),
  range: z.object({ days: z.number().int().min(1).max(365), from: isoDate, to: isoDate }),
  product: AdminAnalyticsProductSchema,
  revenue: AdminAnalyticsRevenueSchema,
  traffic: AdminAnalyticsTrafficSchema,
});
export type AdminAnalytics = z.infer<typeof AdminAnalyticsSchema>;

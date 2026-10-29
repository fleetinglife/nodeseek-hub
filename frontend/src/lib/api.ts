export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && url !== "/login") window.dispatchEvent(new Event("unauthorized"))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(typeof data.detail === "string" ? data.detail : res.statusText)
  return data as T
}

export const api = {
  get: <T>(u: string) => request<T>("GET", u),
  post: <T = { ok: boolean }>(u: string, b: unknown = {}) => request<T>("POST", u, b),
  put: <T = { ok: boolean }>(u: string, b: unknown) => request<T>("PUT", u, b),
}

export type RunStatus = "ok" | "error" | "running"

export interface LoginFlow {
  id?: string
  phase: "idle" | "automatic" | "needs_manual" | "verifying" | "success" | "error" | "canceled" | "expired"
  message?: string
  expires_at?: number | null
  width?: number
  height?: number
}

export interface Me {
  llm: { configured: boolean; model: string }
  has_account: boolean
  has_tg: boolean
  pending_drafts: number
}

export interface RunBrief {
  id: number
  status: RunStatus
  started_at: string
  finished_at: string | null
  summary: string
}

export interface Job {
  name: string
  label: string
  module: string
  running: boolean
  next_run: string | null
  next_ts: number | null
  last: RunBrief | null
  history: RunBrief[]
}

export interface Run extends RunBrief {
  job: string
  log: string
}

export interface Deal {
  post_id: number
  title: string
  merchant: string | null
  model: string | null
  premium: number | null
  currency: string | null
  premium_cny: number | null
  /** 1 = premium worked out from asking price − remaining value */
  premium_est: number
  price: number | null
  price_cny: number | null
  discount: number | null
  deal_date: string
  views: number
  replies: number
  llm_note: string | null
}

export interface PriceOverview {
  days: number
  dates: string[]
  kpi: {
    deals: number
    deals_prev: number
    posts: number
    median: number | null
    median_prev: number | null
    priced: number
  }
  daily: { date: string; deals: number; median: number | null }[]
  window: number
  series: { key: string; count: number; median: number; points: { date: string; value: number; day: number | null; n: number }[] }[]
  deals: Deal[]
  heat: { merchant: string; model: string | null; posts: number; views: number; replies: number; deals: number }[]
  merchants: string[]
  watermark: number | null
}

export interface TopicRef {
  post_id: number
  title: string
  category: string
  published_at: string
  author?: string
}

export interface Keyword {
  word: string
  heat: number
  count: number
  post_ids: number[]
  delta: number | null
  new: boolean
  posts: TopicRef[]
}

export interface HotOverview {
  win: "1h" | "24h"
  snapshot: { id: number; created_at: string; post_count: number; summary: string } | null
  keywords: Keyword[]
  hourly: { hour: string; by_cat: Record<string, number>; total: number }[]
  latest: TopicRef[]
  history: { id: number; created_at: string; post_count: number }[]
  categories: Record<string, string>
  total_topics: number
}

export interface Draft {
  id: number
  kind: "post" | "comment"
  target_id: number | null
  target_title: string | null
  category: string | null
  title: string | null
  content: string
  source: string
  status: "pending" | "published" | "discarded" | "failed"
  result: string
  created_at: string
  published_at: string | null
}

export interface UpgradeStatus {
  today: { day: string; ok: number; at: string; message: string } | null
  checkins: { day: string; ok: number; at: string; message: string }[]
  streak: number
  today_counts: Record<string, number>
  has_account: boolean
}

export interface NotifyConfig {
  tg_api: string
  tg_chat_id: string
  has_token: boolean
  modules: Record<string, boolean>
  labels: Record<string, string>
  history: { id: number; at: string; module: string; text: string; ok: number; error: string }[]
}

export interface Config {
  ns: {
    base: string
    username: string
    auto_cf: boolean
    has_password: boolean
    has_session: boolean
    logged_in_at: string | null
  }
  price: { enabled: boolean; time: string; max_pages: number; lookback_days: number; cold_pages: number; usd_rate: number; delay: number }
  hot: { enabled: boolean; rss_url: string; categories: string[]; poll_minutes: number; hourly: boolean; daily_time: string; top_n: number }
  upgrade: {
    checkin: { enabled: boolean; time: string; random: boolean }
    post: { enabled: boolean; times: string[]; category: string; news_feeds: string[]; use_hot: boolean; style: string }
    comment: {
      enabled: boolean
      times: string[]
      per_run: number
      daily_max: number
      categories: string[]
      keywords: string[]
      style: string
    }
  }
  cleanup: { time: string; topics_days: number; runs_days: number; drafts_days: number; notifications_days: number; trade_days: number }
}

export interface SettingsResponse {
  config: Config
  categories: Record<string, string>
  stats: { rows: Record<string, number>; bytes: number }
}

export const nsLink = (postId: number) => `https://www.nodeseek.com/post-${postId}-1`

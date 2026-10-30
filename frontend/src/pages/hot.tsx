import { useMemo, useState } from "react"
import { ArrowUpRight, ChevronDown, Flame } from "lucide-react"
import { api, nsLink, type HotOverview, type Keyword } from "@/lib/api"
import { useData, useNow } from "@/lib/hooks"
import { parseServerTime } from "@/lib/time"
import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/page-header"
import { Segmented } from "@/components/segmented"
import { StackedColumns } from "@/components/charts/stacked-columns"
import { JobPanel } from "@/components/jobs"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

const WINDOWS = [
  { id: "1h", label: "最近 1 小时" },
  { id: "24h", label: "最近 24 小时" },
] as const

// colour follows the board, never its rank: a fixed slot per board, the rest fold into 其他
const CAT_SLOT: Record<string, number> = { daily: 1, tech: 2, info: 3, trade: 4, carpool: 5 }

function ago(at: string, now: number) {
  const s = now - parseServerTime(at)
  if (s < 90) return "刚刚"
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

export default function HotPage() {
  const [win, setWin] = useState<"1h" | "24h">("1h")
  const { data, loading, refresh } = useData(() => api.get<HotOverview>(`/hot?win=${win}`), 60000, [win])
  const now = useNow(30000)

  return (
    <>
      <PageHeader
        title="热度话题"
        description="订阅所选板块的 RSS，由 LLM 每小时和每天各归纳一次大家在讨论什么。"
        actions={<Segmented label="时间窗口" value={win} onChange={setWin} options={[...WINDOWS]} />}
      />

      {!data || loading ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <Skeleton className="h-[520px] rounded-xl" />
          <Skeleton className="h-[520px] rounded-xl" />
        </div>
      ) : (
          <div>
          {data.snapshot?.summary && (
            <figure className="mb-8 max-w-[68ch]">
              <blockquote className="text-[17px] leading-relaxed text-pretty">{data.snapshot.summary}</blockquote>
              <figcaption className="num-stable mt-2 text-[13px] text-muted-foreground">
                基于 {data.snapshot.post_count} 个新帖 · {ago(data.snapshot.created_at, now)}分析
              </figcaption>
            </figure>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <KeywordBoard key={`${win}-${data.snapshot?.id}`} keywords={data.keywords} win={win} hasSnapshot={!!data.snapshot} />
            <div className="flex flex-col gap-6">
              <Rhythm data={data} />
              <Latest data={data} now={now} />
            </div>
          </div>
        </div>
      )}

      <JobPanel module="hot" onRan={refresh} />
    </>
  )
}

/**
 * The page's one loud element: keywords set as type whose size and weight follow their heat,
 * so the ranking reads before any number does.
 */
function KeywordBoard({ keywords, win, hasSnapshot }: { keywords: Keyword[]; win: string; hasSnapshot: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  // "新" only means something when most words carried over from the previous analysis
  const showNew = keywords.filter((k) => k.new).length <= keywords.length / 2
  if (!keywords.length) {
    return (
      <Empty className="rounded-xl border border-dashed bg-card py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Flame />
          </EmptyMedia>
          <EmptyTitle>{hasSnapshot ? "这段时间没有明显热点" : "还没有热度分析"}</EmptyTitle>
          <EmptyDescription>
            {hasSnapshot
              ? "帖子比较分散，LLM 没有归纳出集中的话题。"
              : `RSS 入库后，${win === "1h" ? "每小时第 3 分钟" : "每天定时"}分析一次。也可以在下方手动运行。`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <section aria-labelledby="kw-title" className="rounded-xl border bg-card">
      <div className="flex items-baseline justify-between px-5 pt-5 pb-2 md:px-6">
        <h2 id="kw-title" className="text-base font-semibold">
          热度关键词
        </h2>
        <span className="text-[13px] text-muted-foreground">按热度排序 · 点开看相关帖子</span>
      </div>
      <ol>
        {keywords.map((k, i) => {
          const isOpen = open === k.word
          return (
            <li key={k.word} className="animate-rise border-t first:border-t-0" style={{ animationDelay: `${i * 45}ms` }}>
              <button
                onClick={() => setOpen(isOpen ? null : k.word)}
                aria-expanded={isOpen}
                className="group grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-4 sm:grid-cols-[28px_minmax(0,1fr)_auto] sm:gap-x-3 sm:px-5 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none md:px-6"
              >
                <span className="num-stable self-start pt-[0.35em] text-right text-[13px] text-muted-foreground">{i + 1}</span>
                <span className="min-w-0">
                  <span className={cn("block text-[14px] leading-snug break-words", i < 3 && "font-semibold")}>
                    {k.word}
                  </span>
                  <span className="mt-1.5 block h-[2px] overflow-hidden rounded-full bg-muted">
                    <span
                      className="animate-grow-x block h-full rounded-full bg-foreground"
                      style={{ width: `${k.heat}%`, animationDelay: `${120 + i * 45}ms` }}
                    />
                  </span>
                </span>
                <span className="flex items-center gap-2 self-start pt-[0.3em] sm:gap-3">
                  <Delta k={k} showNew={showNew} />
                  <span className="num-stable text-right text-[13px] whitespace-nowrap text-muted-foreground sm:w-12">{k.count} 帖</span>
                  <ChevronDown
                    aria-hidden
                    className={cn("size-4 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")}
                  />
                </span>
              </button>
              <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out", isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                <div className="overflow-hidden">
                  <ul className="space-y-0.5 pr-5 pb-3 pl-[60px] md:pr-6">
                    {k.posts.length === 0 && <li className="py-1 text-[13px] text-muted-foreground">相关帖子已被清理</li>}
                    {k.posts.map((p) => (
                      <li key={p.post_id}>
                        <a
                          href={nsLink(p.post_id)}
                          target="_blank"
                          rel="noreferrer"
                          tabIndex={isOpen ? 0 : -1}
                          className="group/link flex items-center gap-1.5 rounded-sm py-1 text-[13.5px] text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                        >
                          <span className="truncate">{p.title}</span>
                          <ArrowUpRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Delta({ k, showNew }: { k: Keyword; showNew: boolean }) {
  if (k.new && !showNew) return <span className="hidden w-8 sm:block" />
  if (k.new) return <span className="rounded-full bg-foreground px-1.5 py-px text-[11px] font-medium text-background">新</span>
  if (k.delta === null || Math.abs(k.delta) < 3) return <span className="hidden w-8 sm:block" />
  return (
    <span className={cn("num-stable w-8 text-right text-[12px]", k.delta > 0 ? "text-foreground" : "text-muted-foreground")}>
      {k.delta > 0 ? "↑" : "↓"}
      {Math.abs(k.delta)}
    </span>
  )
}

function Rhythm({ data }: { data: HotOverview }) {
  const { colors, names, stacks, total } = useMemo(() => {
    const colors: Record<string, string> = {}
    const names: Record<string, string> = {}
    for (const [slug, slot] of Object.entries(CAT_SLOT)) {
      colors[slug] = `var(--series-${slot})`
      names[slug] = data.categories[slug] ?? slug
    }
    colors.other = "var(--muted-foreground)"
    names.other = "其他"
    const stacks = data.hourly.map((h) => {
      const parts: { key: string; value: number }[] = []
      let other = 0
      for (const [c, n] of Object.entries(h.by_cat)) {
        if (CAT_SLOT[c]) parts.push({ key: c, value: n })
        else other += n
      }
      if (other) parts.push({ key: "other", value: other })
      return { label: h.hour.slice(11), title: `${h.hour.slice(5, 10).replace("-", "/")} ${h.hour.slice(11)}:00`, parts }
    })
    return { colors, names, stacks, total: data.hourly.reduce((a, h) => a + h.total, 0) }
  }, [data])
  const present = new Set(data.hourly.flatMap((h) => Object.keys(h.by_cat)).map((c) => (CAT_SLOT[c] ? c : "other")))

  return (
    <section aria-labelledby="rhythm-title" className="rounded-xl border bg-card p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="rhythm-title" className="text-base font-semibold">
          发帖节奏
        </h2>
        <span className="num-stable text-[13px] text-muted-foreground">24 小时 · {total} 帖</span>
      </div>
      <ul className="mb-3 flex flex-wrap gap-x-3.5 gap-y-1" aria-label="图例">
        {Object.keys(colors)
          .filter((k) => present.has(k))
          .map((k) => (
            <li key={k} className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: colors[k] }} />
              {names[k]}
            </li>
          ))}
      </ul>
      <StackedColumns data={stacks} colors={colors} names={names} ariaLabel="最近 24 小时每小时新帖数，按板块堆叠" />
    </section>
  )
}

function Latest({ data, now }: { data: HotOverview; now: number }) {
  return (
    <section aria-labelledby="latest-title" className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-baseline justify-between px-5 pt-5 pb-3">
        <h2 id="latest-title" className="text-base font-semibold">
          最新帖子
        </h2>
        <span className="num-stable text-[13px] text-muted-foreground">库里共 {data.total_topics.toLocaleString("zh-CN")} 帖</span>
      </div>
      {data.latest.length === 0 ? (
        <p className="px-5 pb-8 text-sm text-muted-foreground">RSS 还没有拉到帖子。</p>
      ) : (
        <div className="relative min-h-0 flex-1 border-t">
        <ul className="absolute inset-0 divide-y overflow-auto [mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)] pb-6">
          {data.latest.slice(0, 30).map((p) => (
            <li key={p.post_id}>
              <a
                href={nsLink(p.post_id)}
                target="_blank"
                rel="noreferrer"
                className="flex items-baseline gap-3 px-5 py-2 text-[13.5px] transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {data.categories[p.category] ?? p.category} · {ago(p.published_at, now)}
                </span>
              </a>
            </li>
          ))}
        </ul>
        </div>
      )}
    </section>
  )
}

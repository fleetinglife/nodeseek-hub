import { useEffect, useState, type ReactNode } from "react"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"
import { api, type Config, type SettingsResponse } from "@/lib/api"
import { bytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/page-header"
import { TimePicker } from "@/components/time-picker"
import { JobPanel } from "@/components/jobs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const SECTIONS = [
  { id: "s-ns", label: "NodeSeek 账号" },
  { id: "s-price", label: "价格走势" },
  { id: "s-hot", label: "热度话题" },
  { id: "s-upgrade", label: "升级" },
  { id: "s-cleanup", label: "数据清理" },
]
// shown in the password box when a password is saved; never sent back to the server
const MASK = "\u2022".repeat(8)

const TABLE_NAME: Record<string, string> = {
  trade_posts: "交易帖",
  topics: "RSS 帖子",
  hot_snapshots: "热度分析",
  drafts: "草稿",
  runs: "运行记录",
  notifications: "通知记录",
}

type Path = (string | number)[]

function setIn<T>(obj: T, path: Path, value: unknown): T {
  const [k, ...rest] = path
  const copy: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) }
  copy[k] = rest.length ? setIn(copy[k], rest, value) : value
  return copy
}

export default function SettingsPage() {
  const [res, setRes] = useState<SettingsResponse | null>(null)
  const [cfg, setCfg] = useState<Config | null>(null)
  const [password, setPassword] = useState("")
  const [loggingIn, setLoggingIn] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = () =>
    api.get<SettingsResponse>("/settings").then((r) => {
      setRes(r)
      setCfg(r.config)
      setPassword(r.config.ns.has_password ? MASK : "")
    })
  useEffect(() => {
    load()
    window.addEventListener("nodeseek-login-complete", load)
    return () => window.removeEventListener("nodeseek-login-complete", load)
  }, [])

  if (!res || !cfg) return <Skeleton className="h-[640px] rounded-xl" />

  const set = (path: Path, v: unknown) => setCfg((c) => (c ? setIn(c, path, v) : c))
  const dirty = JSON.stringify(cfg) !== JSON.stringify(res.config) || (password !== "" && password !== MASK)
  const cats = res.categories

  async function save() {
    setSaving(true)
    try {
      const { has_password: _p, logged_in_at: _l, has_session: _s, ...ns } = cfg!.ns
      const r = await api.put<{ ok: boolean; config: Config }>("/settings", {
        ...cfg,
        ns: { ...ns, ...(password && password !== MASK ? { password } : {}) },
      })
      setRes({ ...res!, config: r.config })
      setCfg(r.config)
      setPassword(r.config.ns.has_password ? MASK : "")
      toast.success("设置已保存", { description: "定时任务已按新时间重新排好。" })
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function testLogin() {
    if (dirty && !(await save())) return
    setLoggingIn(true)
    try {
      await api.post("/ns/login/start")
      window.dispatchEvent(new Event("nodeseek-login-start"))
      toast.info("已开始自动登录", { description: "自动处理失败时，会弹出窗口让你完成验证。" })
    } catch (e) {
      toast.error("登录启动失败", { description: (e as Error).message, duration: 20000 })
    } finally {
      setLoggingIn(false)
    }
  }

  return (
    <>
      <PageHeader title="设置" description="各模块的时间和参数。面板密码和 LLM 在 backend/.env 里配置。" />

      <nav aria-label="设置分区" className="-mx-1 mb-6 flex gap-1 overflow-x-auto px-1">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#/settings`}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }}
            className="shrink-0 rounded-full border bg-card px-3 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div className="space-y-8">
        <Section id="s-ns" title="NodeSeek 账号" hint="签到和发布用这个账号。先自动验证并登录，失败时会提示你在窗口里完成验证；成功后保存会话，失效时再重新登录。">
          <Row label="用户名">
            <Input
              value={cfg.ns.username}
              onChange={(e) => set(["ns", "username"], e.target.value)}
              autoComplete="off"
              className="h-8 w-full md:w-[260px]"
            />
          </Row>
          <Row label="密码" hint="加密保存。">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              onFocus={(e) => password === MASK && e.target.select()}
              className="h-8 w-full md:w-[260px]"
            />
          </Row>
          <Row
            label="登录状态"
            hint={
              cfg.ns.has_session
                ? `已登录，${cfg.ns.logged_in_at} 登录。`
                : "还没有登录过。第一次签到或发布时会自动登录，也可以现在测试一次。"
            }
          >
            <Button
              variant="outline"
              onClick={testLogin}
              disabled={loggingIn || saving || !cfg.ns.username || !password}
            >
              {loggingIn && <Spinner />}
              {cfg.ns.has_session ? "重新登录" : "测试登录"}
            </Button>
          </Row>
          <Row
            label="自动过 Cloudflare 挑战"
            hint="抓取页面被 Cloudflare 拦截时，用同一个浏览器拿 cf_clearance。"
          >
            <Switch checked={cfg.ns.auto_cf} onCheckedChange={(v) => set(["ns", "auto_cf"], v)} aria-label="自动过 Cloudflare 挑战" />
          </Row>
        </Section>

        <Section id="s-price" title="价格走势" enabled={cfg.price.enabled} onEnabled={(v) => set(["price", "enabled"], v)}>
          <Row label="每晚抓取时间">
            <TimeInput value={cfg.price.time} onChange={(v) => set(["price", "time"], v)} />
          </Row>
          <Row label="回看天数" hint="重新扫描最近几天出现过的帖子，补上之后才改成「已出」的成交。">
            <Num value={cfg.price.lookback_days} onChange={(v) => set(["price", "lookback_days"], v)} unit="天" />
          </Row>
          <Row label="最多翻页" hint="每晚的上限，防止水位线丢失时一直翻下去。">
            <Num value={cfg.price.max_pages} onChange={(v) => set(["price", "max_pages"], v)} unit="页" />
          </Row>
          <Row label="首次抓取" hint="第一次运行没有水位线，只取前几页。">
            <Num value={cfg.price.cold_pages} onChange={(v) => set(["price", "cold_pages"], v)} unit="页" />
          </Row>
          <Row label="请求间隔" hint="每翻一页、每读一个详情之间等待的时间。">
            <Num value={cfg.price.delay} onChange={(v) => set(["price", "delay"], v)} unit="秒" />
          </Row>
          <Row label="美元汇率" hint="写「刀」「$」的溢价按这个汇率折成人民币。">
            <Num value={cfg.price.usd_rate} onChange={(v) => set(["price", "usd_rate"], v)} step={0.01} unit="元" />
          </Row>
        </Section>

        <Section id="s-hot" title="热度话题" enabled={cfg.hot.enabled} onEnabled={(v) => set(["hot", "enabled"], v)}>
          <Row label="监控的板块" hint="只有这些板块的帖子会入库和参与分析。" stack>
            <Chips all={cats} value={cfg.hot.categories} onChange={(v) => set(["hot", "categories"], v)} />
          </Row>
          <Row label="RSS 地址" stack>
            <Input value={cfg.hot.rss_url} onChange={(e) => set(["hot", "rss_url"], e.target.value)} />
          </Row>
          <Row label="拉取间隔">
            <Num value={cfg.hot.poll_minutes} onChange={(v) => set(["hot", "poll_minutes"], v)} unit="分钟" />
          </Row>
          <Row label="每小时分析" hint="每小时第 3 分钟，分析最近 1 小时的帖子。">
            <Switch checked={cfg.hot.hourly} onCheckedChange={(v) => set(["hot", "hourly"], v)} aria-label="每小时分析" />
          </Row>
          <Row label="每日分析时间" hint="分析最近 24 小时，开了通知会推送到 Telegram。">
            <TimeInput value={cfg.hot.daily_time} onChange={(v) => set(["hot", "daily_time"], v)} />
          </Row>
          <Row label="关键词数量">
            <Num value={cfg.hot.top_n} onChange={(v) => set(["hot", "top_n"], v)} unit="个" />
          </Row>
        </Section>

        <Section id="s-upgrade" title="升级" hint="帖子和评论只生成草稿，发布前都要你在「升级」页确认。">
          <Sub title="签到" enabled={cfg.upgrade.checkin.enabled} onEnabled={(v) => set(["upgrade", "checkin", "enabled"], v)}>
            <Row label="签到时间">
              <TimeInput value={cfg.upgrade.checkin.time} onChange={(v) => set(["upgrade", "checkin", "time"], v)} />
            </Row>
            <Row label="随机鸡腿" hint="关闭则每次固定 5 个。">
              <Switch checked={cfg.upgrade.checkin.random} onCheckedChange={(v) => set(["upgrade", "checkin", "random"], v)} aria-label="随机鸡腿" />
            </Row>
          </Sub>

          <Sub title="帖子草稿" enabled={cfg.upgrade.post.enabled} onEnabled={(v) => set(["upgrade", "post", "enabled"], v)}>
            <Row label="写草稿的时间" hint="最多 4 个，每个时间写一篇。" stack>
              <TimeList value={cfg.upgrade.post.times} max={4} onChange={(v) => set(["upgrade", "post", "times"], v)} />
            </Row>
            <Row label="发到哪个板块">
              <Select value={cfg.upgrade.post.category} onValueChange={(v) => set(["upgrade", "post", "category"], v)}>
                <SelectTrigger size="sm" className="w-[88px]" aria-label="发帖板块">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(cats).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="新闻源" hint="RSS 或 Atom 地址，一行一个。LLM 从最近 36 小时没写过的新闻里挑。" stack>
              <Lines value={cfg.upgrade.post.news_feeds} onChange={(v) => set(["upgrade", "post", "news_feeds"], v)} placeholder="https://example.com/feed.xml" />
            </Row>
            <Row label="也写今日热点" hint="把 24 小时热度关键词作为素材。">
              <Switch checked={cfg.upgrade.post.use_hot} onCheckedChange={(v) => set(["upgrade", "post", "use_hot"], v)} aria-label="也写今日热点" />
            </Row>
            <Row label="写作要求" hint="给 LLM 的额外要求，比如语气、长度、避开的话题。" stack>
              <Textarea value={cfg.upgrade.post.style} onChange={(e) => set(["upgrade", "post", "style"], e.target.value)} className="min-h-[64px]" />
            </Row>
          </Sub>

          <Sub title="评论草稿" enabled={cfg.upgrade.comment.enabled} onEnabled={(v) => set(["upgrade", "comment", "enabled"], v)}>
            <Row label="写草稿的时间" stack>
              <TimeList value={cfg.upgrade.comment.times} max={8} onChange={(v) => set(["upgrade", "comment", "times"], v)} />
            </Row>
            <Row label="每次最多">
              <Num value={cfg.upgrade.comment.per_run} onChange={(v) => set(["upgrade", "comment", "per_run"], v)} unit="条" />
            </Row>
            <Row label="每天最多">
              <Num value={cfg.upgrade.comment.daily_max} onChange={(v) => set(["upgrade", "comment", "daily_max"], v)} unit="条" />
            </Row>
            <Row label="从哪些板块挑帖子" stack>
              <Chips all={cats} value={cfg.upgrade.comment.categories} onChange={(v) => set(["upgrade", "comment", "categories"], v)} />
            </Row>
            <Row label="话题关键词" hint="只评论标题含这些词的帖子，一行一个；留空则不限。" stack>
              <Lines value={cfg.upgrade.comment.keywords} onChange={(v) => set(["upgrade", "comment", "keywords"], v)} placeholder={"DMIT\nCloudflare"} />
            </Row>
            <Row label="写作要求" stack>
              <Textarea value={cfg.upgrade.comment.style} onChange={(e) => set(["upgrade", "comment", "style"], e.target.value)} className="min-h-[64px]" />
            </Row>
          </Sub>
        </Section>

        <Section id="s-cleanup" title="数据清理" hint="每天定时删除过期数据。填 0 表示永久保留。">
          <Row label="清理时间">
            <TimeInput value={cfg.cleanup.time} onChange={(v) => set(["cleanup", "time"], v)} />
          </Row>
          <Row label="RSS 帖子和热度分析" hint={`现在 ${res.stats.rows.topics.toLocaleString("zh-CN")} 帖、${res.stats.rows.hot_snapshots} 次分析`}>
            <Num value={cfg.cleanup.topics_days} onChange={(v) => set(["cleanup", "topics_days"], v)} unit="天" />
          </Row>
          <Row label="交易帖" hint={`现在 ${res.stats.rows.trade_posts.toLocaleString("zh-CN")} 帖。价格走势靠它，建议永久保留。`}>
            <Num value={cfg.cleanup.trade_days} onChange={(v) => set(["cleanup", "trade_days"], v)} unit="天" />
          </Row>
          <Row label="已处理的草稿" hint={`现在 ${res.stats.rows.drafts} 条，待发布的不会被删`}>
            <Num value={cfg.cleanup.drafts_days} onChange={(v) => set(["cleanup", "drafts_days"], v)} unit="天" />
          </Row>
          <Row label="运行记录">
            <Num value={cfg.cleanup.runs_days} onChange={(v) => set(["cleanup", "runs_days"], v)} unit="天" />
          </Row>
          <Row label="通知记录">
            <Num value={cfg.cleanup.notifications_days} onChange={(v) => set(["cleanup", "notifications_days"], v)} unit="天" />
          </Row>
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-5 py-3.5 text-[13px] text-muted-foreground md:px-6">
            <span>数据库 {bytes(res.stats.bytes)}</span>
            {Object.entries(res.stats.rows).map(([k, n]) => (
              <span key={k} className="num-stable">
                {TABLE_NAME[k] ?? k} {n.toLocaleString("zh-CN")}
              </span>
            ))}
          </div>
        </Section>
      </div>

      <JobPanel module="settings" title="清理任务" />

      {/* save bar: slides up only when something changed */}
      <div
        aria-hidden={!dirty}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] transition-all duration-300 ease-out",
          dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-6 opacity-0",
        )}
      >
        <div className="flex w-full max-w-[560px] items-center gap-3 rounded-xl border bg-popover/95 py-2.5 pr-2.5 pl-4 shadow-xl backdrop-blur">
          <span className="flex-1 text-[13.5px]">有未保存的改动</span>
          <Button variant="ghost" tabIndex={dirty ? 0 : -1} onClick={() => (setCfg(res.config), setPassword(res.config.ns.has_password ? MASK : ""))} disabled={saving}>
            撤销
          </Button>
          <Button tabIndex={dirty ? 0 : -1} onClick={save} disabled={saving}>
            {saving && <Spinner />}
            保存设置
          </Button>
        </div>
      </div>
      <div className="h-16" />
    </>
  )
}

function Section({
  id,
  title,
  hint,
  enabled,
  onEnabled,
  children,
}: {
  id: string
  title: string
  hint?: string
  enabled?: boolean
  onEnabled?: (v: boolean) => void
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={id + "-t"} className="scroll-mt-20 overflow-hidden rounded-xl border bg-card">
      <header className="flex items-start gap-4 px-5 pt-5 pb-4 md:px-6">
        <div className="min-w-0 flex-1">
          <h2 id={id + "-t"} className="text-base font-semibold">
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>}
        </div>
        {onEnabled && (
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {enabled ? "已启用" : "已停用"}
            <Switch checked={!!enabled} onCheckedChange={onEnabled} aria-label={`启用${title}`} />
          </label>
        )}
      </header>
      <div className={cn("divide-y border-t transition-opacity", enabled === false && "opacity-50")}>{children}</div>
    </section>
  )
}

function Sub({ title, enabled, onEnabled, children }: { title: string; enabled: boolean; onEnabled: (v: boolean) => void; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-4 bg-muted/40 px-5 py-2.5 md:px-6">
        <h3 className="flex-1 text-[13.5px] font-semibold">{title}</h3>
        <Switch checked={enabled} onCheckedChange={onEnabled} aria-label={`启用${title}`} />
      </div>
      <div className={cn("divide-y border-t transition-opacity", !enabled && "opacity-50")}>{children}</div>
    </div>
  )
}

/** label + explanation on the left, the control on the right; `stack` puts a wide control below. */
function Row({ label, hint, stack, children }: { label: string; hint?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={cn("gap-x-6 gap-y-2.5 px-5 py-3.5 md:px-6", stack ? "flex flex-col" : "flex flex-wrap items-center justify-between")}>
      <div className="min-w-0 md:max-w-[52ch]">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[13px] text-muted-foreground">{hint}</div>}
      </div>
      <div className={cn(stack ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  )
}

/** Number with its unit inside the same box, so every control on the right shares one edge. */
function Num({ value, onChange, unit, step = 1 }: { value: number; onChange: (v: number) => void; unit?: string; step?: number }) {
  return (
    <label className="flex h-8 w-[88px] cursor-text items-center rounded-md border border-input bg-background px-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        className="num-stable h-full min-w-0 flex-1 bg-transparent pl-2 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {unit && <span className="shrink-0 pr-2.5 text-[13px] text-muted-foreground">{unit}</span>}
    </label>
  )
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <TimePicker value={value} onChange={onChange} />
}

function TimeList({ value, onChange, max }: { value: string[]; onChange: (v: string[]) => void; max: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((t, i) => (
        <div key={i} className="flex items-center">
          <TimePicker
            label={`时间 ${i + 1}`}
            value={t}
            onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))}
            className="w-[64px] rounded-r-none"
          />
          <button
            type="button"
            aria-label={`删除 ${t}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="grid h-8 w-7 place-items-center rounded-r-md border border-l-0 border-input bg-background text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {value.length < max && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, "12:00"])}>
          <Plus />
          添加时间
        </Button>
      )}
    </div>
  )
}

function Chips({ all, value, onChange }: { all: Record<string, string>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group">
      {Object.entries(all).map(([k, label]) => {
        const on = value.includes(k)
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}
            className={cn(
              "h-8 rounded-full border px-3 text-[13px] transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97]",
              on ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function Lines({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join("\n"))
  useEffect(() => {
    if (value.join("\n") !== text.split("\n").map((s) => s.trim()).filter(Boolean).join("\n")) setText(value.join("\n"))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <Textarea
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))
      }}
      className="min-h-[72px] font-mono text-[12.5px]"
      spellCheck={false}
    />
  )
}

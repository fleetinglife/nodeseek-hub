import { useEffect, useState, type ComponentType } from "react"
import { Bell, ChevronsUp, Flame, LogOut, Moon, Settings2, Sun, TrendingUp } from "lucide-react"
import { api, type Me } from "@/lib/api"
import { useData } from "@/lib/hooks"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { Toaster } from "@/components/ui/sonner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { ConfirmProvider, useConfirm } from "@/components/confirm"
import { LogoMark } from "@/components/logo"
import { LoginAssistant } from "@/components/login-assistant"
import LoginPage from "@/pages/login"
import PricePage from "@/pages/price"
import HotPage from "@/pages/hot"
import UpgradePage from "@/pages/upgrade"
import NotifyPage from "@/pages/notify"
import SettingsPage from "@/pages/settings"

const PAGES: { id: string; label: string; icon: ComponentType<{ className?: string }>; view: ComponentType }[] = [
  { id: "price", label: "价格走势", icon: TrendingUp, view: PricePage },
  { id: "hot", label: "热度话题", icon: Flame, view: HotPage },
  { id: "upgrade", label: "升级", icon: ChevronsUp, view: UpgradePage },
  { id: "notify", label: "通知", icon: Bell, view: NotifyPage },
  { id: "settings", label: "设置", icon: Settings2, view: SettingsPage },
]

const pageFromHash = () => {
  const id = location.hash.replace(/^#\/?/, "")
  return PAGES.some((p) => p.id === id.split("?")[0]) ? id.split("?")[0] : "price"
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    const off = () => setAuthed(false)
    window.addEventListener("unauthorized", off)
    api.get("/me").then(
      () => setAuthed(true),
      () => setAuthed(false),
    )
    return () => window.removeEventListener("unauthorized", off)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <ConfirmProvider>
        {authed === null ? null : authed ? (
          <Shell onLogout={() => setAuthed(false)} />
        ) : (
          <LoginPage onDone={() => setAuthed(true)} />
        )}
        <Toaster position="bottom-right" />
      </ConfirmProvider>
    </TooltipProvider>
  )
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState(pageFromHash)

  useEffect(() => {
    const on = () => setPage(pageFromHash())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])

  const { data: me } = useData(() => api.get<Me>("/me"), 15000, [page])
  const go = (id: string) => {
    location.hash = "/" + id
    window.scrollTo({ top: 0 })
  }
  const confirm = useConfirm()
  const logout = async () => {
    const ok = await confirm({
      title: "退出登录？",
      description: "退出后需要重新输入面板密码。定时任务照常运行。",
      action: "退出登录",
      variant: "default",
    })
    if (!ok) return
    await api.post("/logout")
    onLogout()
  }
  const View = PAGES.find((p) => p.id === page)!.view

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-2.5 px-4 sm:px-6">
          <LogoMark className="size-6" />
          <span className="font-semibold">NS 聚合</span>
          <span className="text-[13px] text-muted-foreground">NodeSeek 行情与动态</span>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="退出登录" onClick={logout}>
                  <LogOut />
                </Button>
              </TooltipTrigger>
              <TooltipContent>退出登录</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1240px] px-4 sm:px-6 lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-8">
        <nav
          aria-label="主导航"
          className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 py-2 sm:-mx-6 sm:px-6 lg:sticky lg:top-14 lg:mx-0 lg:flex-col lg:self-start lg:overflow-visible lg:border-0 lg:px-0 lg:py-8"
        >
          {PAGES.map((p) => (
            <button
              key={p.id}
              onClick={() => go(p.id)}
              aria-current={page === p.id ? "page" : undefined}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-left text-sm text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                "aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground",
              )}
            >
              <p.icon className="size-4" />
              {p.label}
              {p.id === "upgrade" && !!me?.pending_drafts && (
                <span
                  aria-label={`${me.pending_drafts} 条草稿待发布`}
                  className="num-stable ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground lg:ml-auto"
                >
                  {me.pending_drafts}
                </span>
              )}
            </button>
          ))}
        </nav>

        <main className="min-w-0 pt-6 pb-16 lg:pt-8">
          <LoginAssistant />
          {me && !me.llm.configured && (
            <p role="alert" className="mb-6 rounded-lg border border-warning/40 bg-warning/8 px-4 py-2.5 text-[13px]">
              还没有配置 LLM：在 <code className="font-mono">backend/.env</code> 里写上 <code className="font-mono">LLM_API_KEY</code> 后重启。价格归一、热度分析和草稿都要用到它。
            </p>
          )}
          <div key={page} className="animate-in fade-in-0 duration-300">
            <View />
          </div>
        </main>
      </div>
    </div>
  )
}

/** Light <-> dark. Until clicked, the page follows the system setting. */
function ThemeToggle() {
  const { resolved, setTheme } = useTheme()
  const next = resolved === "dark" ? "light" : "dark"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={next === "dark" ? "切换到深色" : "切换到浅色"} onClick={() => setTheme(next)}>
          {resolved === "dark" ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{next === "dark" ? "深色模式" : "浅色模式"}</TooltipContent>
    </Tooltip>
  )
}

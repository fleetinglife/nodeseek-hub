import { useEffect, useRef, useState, type MouseEvent } from "react"
import { toast } from "sonner"
import { api, type LoginFlow } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const active = (f: LoginFlow) => ["automatic", "needs_manual", "verifying"].includes(f.phase)

export function LoginAssistant() {
  const [flow, setFlow] = useState<LoginFlow>({ phase: "idle" })
  const [open, setOpen] = useState(false)
  const [screen, setScreen] = useState<string>()
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [now, setNow] = useState(Date.now())
  const seen = useRef("")

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let busy = false
    const poll = async () => {
      if (busy || disposed) return
      busy = true
      try {
        const next = await api.get<LoginFlow>("/ns/login/status")
        if (disposed) return
        setFlow(next)
        const key = `${next.id}:${next.phase}`
        if (key !== seen.current) {
          seen.current = key
          if (next.phase === "needs_manual") {
            setOpen(true)
            toast.info("需要你完成登录验证", { description: "在弹出的窗口里点击验证并登录，窗口保留 10 分钟。" })
          } else if (next.phase === "success") {
            setOpen(false)
            toast.success("NodeSeek 登录成功", { description: "经过验证的会话已保存。" })
            window.dispatchEvent(new Event("nodeseek-login-complete"))
          } else if (["error", "expired", "canceled"].includes(next.phase)) {
            setOpen(false)
            toast[next.phase === "canceled" ? "info" : "error"](next.message || "登录未完成")
          }
        }
        timer = setTimeout(poll, active(next) ? 1500 : 5000)
      } catch {
        if (!disposed) timer = setTimeout(poll, 5000)
      } finally {
        busy = false
      }
    }
    const refresh = () => { clearTimeout(timer); void poll() }
    void poll()
    window.addEventListener("nodeseek-login-start", refresh)
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("nodeseek-login-start", refresh) }
  }, [])

  useEffect(() => {
    if (!open || flow.phase !== "needs_manual" || !flow.id) {
      setScreen(undefined)
      setText("")
      return
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let previous: string | undefined
    const frame = async () => {
      try {
        const response = await fetch(`/api/ns/login/${flow.id}/screen`, { cache: "no-store" })
        if (response.status === 401) window.dispatchEvent(new Event("unauthorized"))
        if (response.ok) {
          const blob = await response.blob()
          if (disposed) return
          const url = URL.createObjectURL(blob)
          setScreen(url)
          if (previous) URL.revokeObjectURL(previous)
          previous = url
        }
      } catch { /* status polling handles expired/canceled windows */ }
      if (!disposed) timer = setTimeout(frame, 800)
    }
    void frame()
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { disposed = true; clearTimeout(timer); clearInterval(clock); if (previous) URL.revokeObjectURL(previous) }
  }, [open, flow.id, flow.phase])

  async function send(action: unknown) {
    if (!flow.id || sending) return
    setSending(true)
    try { await api.post(`/ns/login/${flow.id}/input`, action) }
    catch (e) { toast.error((e as Error).message) }
    finally { setSending(false) }
  }
  const click = (e: MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) * (flow.width || e.currentTarget.naturalWidth) / rect.width)
    const y = Math.floor((e.clientY - rect.top) * (flow.height || e.currentTarget.naturalHeight) / rect.height)
    void send({ kind: "click", x, y })
  }
  async function cancel() {
    try { await api.post(`/ns/login/${flow.id}/cancel`) }
    catch (e) { toast.error((e as Error).message) }
  }

  if (!active(flow)) return null
  const remaining = Math.max(0, Math.ceil(((flow.expires_at || 0) * 1000 - now) / 1000))
  return (
    <>
      <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <span className="flex-1">{flow.phase === "needs_manual" ? "NodeSeek 登录需要人工验证。" : "正在自动验证并登录 NodeSeek…"}</span>
        {flow.phase === "needs_manual" && <Button size="sm" onClick={() => setOpen(true)}>打开验证窗口</Button>}
        <Button size="sm" variant="ghost" onClick={cancel}>取消登录</Button>
      </div>
      <Dialog open={open && flow.phase === "needs_manual"} onOpenChange={setOpen}>
        <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>完成 NodeSeek 登录验证</DialogTitle>
            <DialogDescription>
              先点击画面中的验证框，再点击登录。需要输入时，先点画面中的输入框，再用下方工具输入。
              登录成功后自动保存并关闭。剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}。
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{flow.message}</p>
          <Button variant="outline" size="sm" onClick={() => setZoom(!zoom)}>{zoom ? "适应窗口" : "放大画面"}</Button>
          <div className="max-h-[65dvh] min-h-48 overflow-auto rounded-md border bg-white">
            {screen ? <img src={screen} alt="服务器上的 NodeSeek 登录窗口，点击画面即可操作" draggable={false}
              onClick={click} style={zoom ? { width: flow.width, maxWidth: "none" } : undefined}
              className="block h-auto w-full cursor-pointer select-none" />
              : <p className="p-8 text-center text-sm text-slate-600">正在连接登录窗口…</p>}
          </div>
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (text) { const value = text; setText(""); await send({ kind: "text", text: value }) } }}>
            <Input type="password" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} maxLength={256}
              aria-label="输入验证码或文字" placeholder="验证码或文字（先点击画面中的输入框）" />
            <Button type="submit" disabled={!text || sending}>输入</Button>
          </form>
          <div className="flex flex-wrap gap-2">
            {[["Tab", "切换输入框"], ["Enter", "回车"], ["Backspace", "退格"], ["SelectAll", "全选"]].map(([key, label]) =>
              <Button key={key} variant="outline" size="sm" disabled={sending} onClick={() => send({ kind: "key", key })}>{label}</Button>)}
            <Button variant="outline" size="sm" disabled={sending} onClick={() => send({ kind: "scroll", delta: -1 })}>向上滚动</Button>
            <Button variant="outline" size="sm" disabled={sending} onClick={() => send({ kind: "scroll", delta: 1 })}>向下滚动</Button>
            <Button variant="ghost" size="sm" onClick={cancel}>取消本次登录</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

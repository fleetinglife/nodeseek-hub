import os
import re
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, hot, llm, login_flow, login_routes, notify, ns, price, runner, upgrade
from .security import check_password, encrypt, make_token, verify_token

app = FastAPI(title="nodeseek-hub")


def auth(request: Request):
    if not verify_token(request.cookies.get("session")):
        raise HTTPException(401, "未登录")


@app.on_event("startup")
def _startup():
    if not os.environ.get("APP_PASSWORD"):
        print("\n*** 没有设置 APP_PASSWORD，所有登录都会失败。在 backend/.env 里写 APP_PASSWORD=你的密码 后重启。***\n", flush=True)
    if os.environ.get("NO_SCHEDULER") != "1":
        runner.start()


@app.on_event("shutdown")
def _shutdown():
    login_flow.manager.cancel()
    if runner.scheduler.running:
        runner.scheduler.shutdown(wait=False)


# ---------- auth ----------
class Login(BaseModel):
    password: str


@app.post("/api/login")
def login(body: Login, request: Request, response: Response):
    if not check_password(body.password):
        raise HTTPException(401, "密码错误")
    secure = request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https"
    response.set_cookie("session", make_token(), httponly=True, samesite="lax", secure=secure, max_age=7 * 86400)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie("session")
    return {"ok": True}


@app.get("/api/me", dependencies=[Depends(auth)])
def me():
    cfg = config.get()
    return {
        "llm": {"configured": llm.configured(), "model": llm.model()},
        "has_account": bool(cfg["ns"]["username"] and cfg["ns"]["password_enc"]),
        "has_tg": bool(cfg["notify"]["tg_token_enc"] and cfg["notify"]["tg_chat_id"]),
        "pending_drafts": db.one("SELECT COUNT(*) n FROM drafts WHERE status='pending'")["n"],
    }


api = {"dependencies": [Depends(auth)]}


# ---------- jobs ----------
def _job_out(name: str, nexts: dict):
    label, _, module = runner.JOBS[name]
    hist = db.q("SELECT id, status, started_at, finished_at, summary FROM runs WHERE job=? ORDER BY id DESC LIMIT 30", (name,))
    n = nexts.get(name)
    return {
        "name": name,
        "label": label,
        "module": module,
        "running": runner.is_running(name),
        "next_run": n.strftime("%Y-%m-%d %H:%M:%S") if n else None,
        "next_ts": int(n.timestamp()) if n else None,
        "last": hist[0] if hist else None,
        "history": hist[::-1],
    }


@app.get("/api/jobs", **api)
def jobs(module: str | None = None):
    nexts = runner.next_runs()
    return [_job_out(n, nexts) for n, j in runner.JOBS.items() if not module or j[2] == module]


@app.post("/api/jobs/{name}/run", **api)
def run_job(name: str):
    if name not in runner.JOBS:
        raise HTTPException(404)
    if runner.is_running(name):
        raise HTTPException(409, "正在运行")
    runner.run_now(name)
    return {"ok": True}


@app.get("/api/runs", **api)
def runs(job: str | None = None, limit: int = 50):
    sql, args = "SELECT * FROM runs", []
    if job:
        sql += " WHERE job=?"
        args.append(job)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(min(limit, 200))
    return db.q(sql, args)


# ---------- data pages ----------
@app.get("/api/price", **api)
def price_overview(days: int = 30, merchant: str | None = None):
    return price.overview(max(7, min(days, 365)), merchant or None)


@app.get("/api/hot", **api)
def hot_overview(win: str = "24h"):
    if win not in ("1h", "24h"):
        raise HTTPException(400)
    return hot.overview(win)


@app.get("/api/upgrade", **api)
def upgrade_status():
    return upgrade.status()


@app.get("/api/drafts", **api)
def drafts(status: str = "pending", limit: int = 50):
    if status == "done":
        return db.q(
            "SELECT * FROM drafts WHERE status IN ('published','failed') OR (status='discarded' AND content!='') "
            "ORDER BY id DESC LIMIT ?",
            (min(limit, 200),),
        )
    return db.q("SELECT * FROM drafts WHERE status=? ORDER BY id DESC LIMIT ?", (status, min(limit, 200)))


class DraftIn(BaseModel):
    title: str | None = None
    content: str


@app.put("/api/drafts/{id}", **api)
def edit_draft(id: int, d: DraftIn):
    if not d.content.strip():
        raise HTTPException(400, "内容不能为空")
    db.ex("UPDATE drafts SET title=COALESCE(?, title), content=? WHERE id=? AND status IN ('pending','failed')",
          (d.title, d.content.strip(), id))
    return {"ok": True}


@app.post("/api/drafts/{id}/publish", **api)
def publish_draft(id: int):
    ok, msg = upgrade.publish(id)
    if not ok:
        raise HTTPException(400, msg)
    return {"ok": True, "message": msg}


@app.post("/api/drafts/{id}/discard", **api)
def discard_draft(id: int):
    db.ex("UPDATE drafts SET status='discarded', result='手动放弃' WHERE id=? AND status IN ('pending','failed')", (id,))
    return {"ok": True}


# ---------- notifications ----------
class NotifyIn(BaseModel):
    tg_api: str = "https://api.telegram.org"
    tg_token: str | None = None  # omitted = keep old
    tg_chat_id: str = ""
    modules: dict[str, bool] = {}


@app.get("/api/notify", **api)
def get_notify():
    n = config.get()["notify"]
    return {
        "tg_api": n["tg_api"],
        "tg_chat_id": n["tg_chat_id"],
        "has_token": bool(n["tg_token_enc"]),
        "modules": n["modules"],
        "labels": notify.MODULES,
        "history": db.q("SELECT * FROM notifications ORDER BY id DESC LIMIT 60"),
    }


@app.put("/api/notify", **api)
def put_notify(b: NotifyIn):
    old = config.get()["notify"]
    config.save({
        "notify": {
            "tg_api": b.tg_api.strip() or "https://api.telegram.org",
            "tg_token_enc": encrypt(b.tg_token.strip()) if b.tg_token else old["tg_token_enc"],
            "tg_chat_id": b.tg_chat_id.strip(),
            "modules": {k: bool(b.modules.get(k, old["modules"].get(k))) for k in notify.MODULES},
        }
    })
    return {"ok": True}


@app.post("/api/notify/test", **api)
def test_notify():
    try:
        notify.send("test", "nodeseek-hub 通知测试：机器人配置正常。", force=True)
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ---------- settings ----------
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _public_settings():
    cfg = config.get()
    ns_cfg = {k: v for k, v in cfg["ns"].items() if k != "password_enc"}
    ns_cfg["has_password"] = bool(cfg["ns"]["password_enc"])
    ns_cfg.update(ns.session_info())
    out = {k: v for k, v in cfg.items() if k != "notify"}
    out["ns"] = ns_cfg
    return out


@app.get("/api/settings", **api)
def get_settings():
    sizes = {
        t: db.one(f"SELECT COUNT(*) n FROM {t}")["n"]
        for t in ("trade_posts", "topics", "hot_snapshots", "drafts", "runs", "notifications")
    }
    path = db.DB_PATH
    size = sum(p.stat().st_size for p in path.parent.glob(path.name + "*"))
    return {"config": _public_settings(), "categories": config.CATEGORIES, "stats": {"rows": sizes, "bytes": size}}


@app.put("/api/settings", **api)
def put_settings(body: dict):
    with ns.account_lock:
        return _put_settings(body)


def _put_settings(body: dict):
    body = {k: v for k, v in body.items() if k in ("ns", "price", "hot", "upgrade", "cleanup")}
    nsb = body.get("ns")
    account_changed = False
    if isinstance(nsb, dict):
        for k in ("password_enc", "has_password", "logged_in_at", "has_session"):
            nsb.pop(k, None)
        password = nsb.pop("password", None)
        old = config.get()["ns"]
        if password:
            nsb["password_enc"] = encrypt(password)
        account_changed = bool(password) or any(k in nsb and nsb[k] != old[k] for k in ("username", "base"))
    merged = config._merge(config.get(), body)
    times = [merged["price"]["time"], merged["hot"]["daily_time"], merged["upgrade"]["checkin"]["time"],
             merged["cleanup"]["time"], *merged["upgrade"]["post"]["times"], *merged["upgrade"]["comment"]["times"]]
    bad = [t for t in times if not HHMM.match(str(t))]
    if bad:
        raise HTTPException(400, f"时间格式要写成 HH:MM：{', '.join(map(str, bad))}")
    if len(merged["upgrade"]["post"]["times"]) > 4:
        raise HTTPException(400, "发帖时间最多 4 个")
    if account_changed:
        login_flow.manager.cancel()
        ns.clear_session()
    config.save(body)
    runner.sync_jobs()
    return {"ok": True, "config": _public_settings()}


@app.post("/api/ns/login", **api)
def ns_login():
    """Log in now with the saved account (opens a browser; takes 20-60 s)."""
    lines: list[str] = []
    try:
        ns.Client(lambda *a: lines.append(" ".join(map(str, a))), manual=False).login()
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **ns.session_info()}


login_routes.install(app, auth, ns.start_login)


# ---------- frontend ----------
DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")

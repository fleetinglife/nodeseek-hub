"""Panel-authenticated access to the ephemeral login browser."""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from . import login_flow


PRIVATE = {"Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff",
           "Cross-Origin-Resource-Policy": "same-origin"}


def install(app, auth, start):
    router = APIRouter(prefix="/api/ns/login", dependencies=[Depends(auth)])

    def same_origin(request: Request):
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "仅允许从本面板操作")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ("http", "https") or parsed.netloc != request.headers.get("host"):
                raise HTTPException(403, "仅允许从本面板操作")

    def get_flow(id):
        flow = login_flow.manager.get(id)
        if not flow:
            raise HTTPException(404, "登录窗口不存在")
        return flow

    @router.post("/start", dependencies=[Depends(same_origin)])
    def begin(response: Response):
        response.headers.update(PRIVATE)
        return start()

    @router.get("/status")
    def status(response: Response):
        response.headers.update(PRIVATE)
        flow = login_flow.manager.get()
        return flow.public() if flow else {"phase": "idle"}

    @router.post("/{id}/cancel", dependencies=[Depends(same_origin)])
    def cancel(id: str):
        get_flow(id)
        login_flow.manager.cancel(id)
        return {"ok": True}

    @router.get("/{id}/screen")
    def screen(id: str):
        flow = get_flow(id)
        with flow.lock:
            if flow.phase != "needs_manual" or flow.stop.is_set() or not flow.frame:
                raise HTTPException(409, "当前没有可接管的登录窗口")
            try:
                flow.check()
            except login_flow.FlowStopped as exc:
                raise HTTPException(409, str(exc))
            return Response(flow.frame, media_type="image/jpeg", headers=PRIVATE)

    @router.post("/{id}/input", dependencies=[Depends(same_origin)])
    def input(id: str, body: dict):
        flow = get_flow(id)
        try:
            flow.enqueue(body)
        except (ValueError, login_flow.FlowStopped) as exc:
            raise HTTPException(409, str(exc))
        return {"ok": True}

    app.include_router(router)

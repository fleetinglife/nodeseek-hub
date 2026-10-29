"""One ephemeral login browser, with a bounded manual takeover after automation.

Screens and input stay in memory. Only the browser's owner thread touches Selenium/X11.
This is deliberately a single-process service (the default uvicorn deployment).
"""
from collections import deque
import threading
import time
import uuid


ACTIVE = {"automatic", "needs_manual", "verifying"}


class FlowStopped(Exception):
    pass


class LoginFlow:
    def __init__(self):
        self.id = uuid.uuid4().hex
        self.phase = "automatic"
        self.message = "正在自动处理验证并登录…"
        self.deadline = None
        self.stop = threading.Event()
        self.done = threading.Event()
        self.error = None
        self.lock = threading.RLock()
        self.frame = None
        self.width = self.height = 0
        self.inputs = deque()

    def public(self):
        with self.lock:
            return {"id": self.id, "phase": self.phase, "message": self.message,
                    "expires_at": self.deadline, "width": self.width, "height": self.height}

    def check(self):
        if self.stop.is_set():
            raise FlowStopped("登录已取消")
        if self.deadline is not None and time.time() >= self.deadline:
            raise FlowStopped("人工验证已超时，请重新登录")

    def manual(self, message):
        with self.lock:
            self.check()
            self.phase = "needs_manual"
            self.message = message
            self.deadline = time.time() + 600

    def picture(self, image, width, height):
        with self.lock:
            self.check()
            self.frame, self.width, self.height = image, width, height

    def enqueue(self, action):
        with self.lock:
            self.check()
            if self.phase != "needs_manual" or self.frame is None:
                raise ValueError("当前没有可接管的登录窗口")
            if len(self.inputs) >= 32:
                raise ValueError("操作过快，请稍后重试")
            kind = action.get("kind")
            if kind == "click":
                x, y = action.get("x"), action.get("y")
                if type(x) is not int or type(y) is not int or not (0 <= x < self.width and 0 <= y < self.height):
                    raise ValueError("点击位置超出窗口")
                clean = {"kind": kind, "x": x, "y": y}
            elif kind == "text":
                text = action.get("text")
                if not isinstance(text, str) or not 1 <= len(text) <= 256 or any(not 32 <= ord(c) <= 126 for c in text):
                    raise ValueError("请输入最多 256 个英文字符、数字或符号；换行请用回车按钮")
                clean = {"kind": kind, "text": text}
            elif kind == "key" and action.get("key") in {"Tab", "Enter", "Backspace", "Escape", "SelectAll"}:
                clean = {"kind": kind, "key": action["key"]}
            elif kind == "scroll" and type(action.get("delta")) is int and action["delta"] in {-1, 1}:
                clean = {"kind": kind, "delta": action["delta"]}
            else:
                raise ValueError("不支持的操作")
            self.inputs.append(clean)

    def take_inputs(self):
        with self.lock:
            self.check()
            out = list(self.inputs)
            self.inputs.clear()
            return out


class LoginManager:
    def __init__(self):
        self.lock = threading.RLock()
        self.current = None

    def start(self, callback):
        with self.lock:
            if self.current and not self.current.done.is_set():
                return self.current
            flow = self.current = LoginFlow()

            def run():
                try:
                    callback(flow)
                    with flow.lock:
                        # The callback owns the final check/save transaction. Cancellation after
                        # that transaction must not turn an already-saved session into a failure.
                        flow.phase, flow.message = "success", "登录成功，已保存经过验证的会话"
                except FlowStopped as exc:
                    with flow.lock:
                        flow.phase = "canceled" if flow.stop.is_set() else "expired"
                        flow.message, flow.error = str(exc), exc
                except (Exception, SystemExit) as exc:
                    with flow.lock:
                        flow.phase, flow.message = "error", "登录未完成，请检查账号或重新尝试"
                        flow.error = exc
                finally:
                    with flow.lock:
                        flow.frame = None
                        flow.inputs.clear()
                        flow.width = flow.height = 0
                    flow.done.set()

            threading.Thread(target=run, name="nodeseek-login", daemon=True).start()
            return flow

    def get(self, flow_id=None):
        with self.lock:
            flow = self.current
            if not flow or (flow_id and flow.id != flow_id):
                return None
            return flow

    def cancel(self, flow_id=None):
        flow = self.get(flow_id)
        if flow:
            with flow.lock:
                if not flow.done.is_set() and flow.phase in {"automatic", "needs_manual"}:
                    flow.stop.set()
                    flow.frame = None
                    flow.inputs.clear()
        return flow


manager = LoginManager()


class Desktop:
    """Linux X11 capture/native input, restricted to the Chrome content area.

Pillow and python-xlib are supplied by SeleniumBase on the Linux deployment.
No VNC server, clipboard, browser chrome, shell, or public listening port.
"""
    def __init__(self, browser):
        import os
        from Xlib import display
        self.browser = browser
        self.display_name = os.environ.get("DISPLAY")
        if not self.display_name:
            raise RuntimeError("No X11 display")
        self.display = display.Display(self.display_name)
        self.bounds = None

    def close(self):
        self.display.close()

    def screenshot(self):
        from io import BytesIO
        from PIL import ImageGrab
        box = self.browser.execute_script(
            "return ({x: window.screenX, y: window.screenY + window.outerHeight - window.innerHeight, "
            "width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio});"
        )
        if not box or box["scale"] != 1:
            raise RuntimeError("Unsupported browser display scale")
        x, y, w, h = (int(box[k]) for k in ("x", "y", "width", "height"))
        screen = ImageGrab.grab(xdisplay=self.display_name)
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > screen.width or y + h > screen.height:
            raise RuntimeError("Browser viewport outside display")
        self.bounds = x, y, w, h
        out = BytesIO()
        screen.crop((x, y, x + w, y + h)).save(out, format="JPEG", quality=80)
        return out.getvalue(), w, h

    def _key(self, symbol, down):
        from Xlib import X, XK
        from Xlib.ext import xtest
        code = self.display.keysym_to_keycode(XK.string_to_keysym(symbol))
        if not code:
            raise ValueError("Unsupported key")
        xtest.fake_input(self.display, X.KeyPress if down else X.KeyRelease, code)

    def input(self, action):
        from Xlib import X
        from Xlib.ext import xtest
        kind = action["kind"]
        if kind in {"text", "key"} and not self.browser.execute_script("return document.hasFocus();"):
            # Tab must not let the typing toolbar operate Chrome's address bar or menus.
            return
        if kind == "click":
            x, y, w, h = self.bounds
            if not (0 <= action["x"] < w and 0 <= action["y"] < h):
                return
            xtest.fake_input(self.display, X.MotionNotify, x=x + action["x"], y=y + action["y"])
            xtest.fake_input(self.display, X.ButtonPress, 1)
            xtest.fake_input(self.display, X.ButtonRelease, 1)
        elif kind == "scroll":
            button = 5 if action["delta"] > 0 else 4
            xtest.fake_input(self.display, X.ButtonPress, button)
            xtest.fake_input(self.display, X.ButtonRelease, button)
        elif kind == "key":
            key = action["key"]
            if key == "SelectAll":
                self._key("Control_L", True)
                self._key("a", True)
                self._key("a", False)
                self._key("Control_L", False)
            else:
                key = {"Enter": "Return", "Backspace": "BackSpace"}.get(key, key)
                self._key(key, True)
                self._key(key, False)
        elif kind == "text":
            for char in action["text"]:
                code = self.display.keysym_to_keycode(ord(char))
                mapping = self.display.get_keyboard_mapping(code, 1)[0] if code else []
                if ord(char) not in mapping[:2]:
                    raise ValueError("Unsupported character")
                shift = mapping[0] != ord(char)
                if shift:
                    self._key("Shift_L", True)
                xtest.fake_input(self.display, X.KeyPress, code)
                xtest.fake_input(self.display, X.KeyRelease, code)
                if shift:
                    self._key("Shift_L", False)
        self.display.sync()

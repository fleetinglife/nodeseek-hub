"""NodeSeek HTTP client.

Requests go through curl_cffi with a Chrome TLS fingerprint. When Cloudflare still answers
with a challenge, a real browser (seleniumbase) solves it once and the cf_clearance cookie +
its User-Agent are reused until they expire.

Login: NodeSeek's sign-in page has a Cloudflare Turnstile check, so the account is logged in
with the same real browser (username + password from Settings). The session cookies are kept
encrypted and reused; when a write call says "not logged in", it logs in again once and retries.

The HTML selectors below were written against the public markup and are kept in one place
(SEL) so they are easy to adjust. Check them on your server with:
    ./venv/bin/python -m app.ns list trade      # parse page 1 of a board
    ./venv/bin/python -m app.ns post 1011130    # parse one post
"""
import json
import hashlib
import re
import threading
import sys
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from curl_cffi import requests

from . import config, db, login_flow
from .security import decrypt, encrypt

SEL = {
    "item": "li.post-list-item",
    "title": ".post-title a[href*='/post-']",
    "author": ".info-author a, a[href^='/space/']",
    "views": ".info-views",
    "replies": ".info-comments-count",
    "category": "a[href^='/categories/']",
    "pinned": ".pined, .pinned, use[href='#pin'], use[*|href='#pin']",
    "content": "article.post-content, .post-content",
    "time": "time[datetime]",
}
# sign-in form; tolerant so a small markup change still works
LOGIN = {
    "password": "input[type='password']",
    "error": ".error-message, .msc-content, .el-message, [role='alert']",
}
# The page also has a search box, so the username input and the 登录 button are looked up
# inside the block that holds the password input, and tagged for the clicks/typing below.
MARK_LOGIN_FORM = "return (() => { " + """
const pw = document.querySelector("input[type='password']");
let box = pw && pw.parentElement;
while (box && !box.querySelector("button") ) box = box.parentElement;
if (!box) return "no form";
const inputs = [...box.querySelectorAll("input")].filter(i => i !== pw && /^(text|email|)$/.test(i.type) && i.offsetParent);
const user = inputs.find(i => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) || inputs[0];
const btn = [...box.querySelectorAll("button")].find(b => b.textContent.trim() === "登录")
         || [...box.querySelectorAll("button")].find(b => b.textContent.includes("登录"));
if (user) user.setAttribute("data-nsh", "user");
pw.setAttribute("data-nsh", "pw");
if (btn) btn.setAttribute("data-nsh", "submit");
return (user ? "" : "no user ") + (btn ? "" : "no button");
""".strip().replace("\n", " ") + " })();"
CHALLENGE = ("just a moment", "attention required", "cf-chl", "challenge-platform")
POST_ID = re.compile(r"/post-(\d+)")


class NSError(Exception):
    pass


class CFBlocked(NSError):
    pass


class LoginError(NSError):
    pass


NOT_LOGGED_IN = re.compile(
    r"未登录|请先登录|登录已过期|重新登录|not.?logged|unauthori[sz]ed|login|user[\s_]+not[\s_]+found", re.I
)
_login_lock = threading.RLock()  # SeleniumBase/Xvfb has process-global display state
account_lock = threading.RLock()  # account edits and verified session commits


def _requires_email_verification(browser) -> bool:
    path = urlsplit(browser.get_current_url()).path.lower()
    return "emailsignin" in path or browser.is_element_visible(
        "input[placeholder*='验证码'], input[placeholder*='validation code' i], input[autocomplete='one-time-code']"
    )


EMAIL_VERIFICATION_MESSAGE = "NodeSeek 要求邮箱验证码（邮箱动态验证登录）。请先完成该账号的邮箱验证后重试；当前未保存为已登录。"

# Return only state, never the token itself. cf_clearance is not this form token.
LOGIN_CHALLENGE_STATE = "return (() => { " + """
const fields = [...document.querySelectorAll('[name="cf-turnstile-response"]')];
return {present: fields.length > 0, ready: fields.some(field => Boolean(field.value))};
""".strip().replace("\n", " ") + " })();"


def _load_session() -> dict:
    enc = db.get_setting("ns_session")
    try:
        return json.loads(decrypt(enc)) if enc else {}
    except Exception:
        return {}


def _save_session(cookies: dict, ua: str) -> None:
    """Save only a session that passed the authenticated, read-only API check."""
    db.set_setting("ns_session", encrypt(json.dumps({
        "cookies": cookies, "ua": ua, "at": config.now_str(), "verified": True,
    })))


def _verified_session(s: dict) -> bool:
    # Legacy versions saved cf_clearance/theme cookies as a successful login.
    return s.get("verified") is True and bool(s.get("cookies"))


def session_info() -> dict:
    s = _load_session()
    verified = _verified_session(s)
    return {"logged_in_at": s.get("at") if verified else None, "has_session": verified}


def clear_session() -> None:
    db.set_setting("ns_session", "")


def _num(text: str) -> int:
    t = (text or "").strip().lower().replace(",", "")
    m = re.search(r"([\d.]+)\s*([kw万]?)", t)
    if not m:
        return 0
    n = float(m.group(1))
    return int(n * {"k": 1000, "w": 10000, "万": 10000}.get(m.group(2), 1))


class Client:
    def __init__(self, log=print, manual=True):
        cfg = config.get()["ns"]
        self.base = cfg["base"].rstrip("/")
        self.log = log
        self.manual = manual
        self.auto_cf = cfg.get("auto_cf", True)
        cf = db.get_setting("cf_session", {}) or {}
        self.ua = cf.get("ua") or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        )
        # anonymous session for everything read-only: only the Cloudflare cookies, never the login
        self.s = self._new_session(cf.get("cookies") or {})
        self._auth: tuple | None = None  # (session, ua) with the login cookies, built on first write

    def _new_session(self, cookies: dict):
        s = requests.Session(impersonate="chrome")
        for k, v in cookies.items():
            s.cookies.set(k, v, domain=".nodeseek.com")
        return s

    def _auth_session(self) -> tuple:
        if self._auth is None:
            sess = _load_session()
            self._auth = (self._new_session(sess.get("cookies") or {}), sess.get("ua") or self.ua)
        return self._auth

    # ---------- transport ----------
    def _headers(self, extra=None):
        h = {"User-Agent": self.ua, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
        h.update(extra or {})
        return h

    def _blocked(self, r) -> bool:
        if r.status_code not in (403, 429, 503):
            return False
        head = r.text[:3000].lower()
        return any(c in head for c in CHALLENGE)

    def request(self, method, path, auth=False, **kw):
        """auth=False: anonymous session. auth=True: the logged-in session (sign-in / post / comment only)."""
        url = path if path.startswith("http") else self.base + path
        extra = kw.pop("headers", None)
        for attempt in range(2):
            s, ua = self._auth_session() if auth else (self.s, self.ua)
            h = self._headers(extra)
            h["User-Agent"] = ua
            r = s.request(method, url, headers=h, timeout=30, **kw)
            if not self._blocked(r):
                return r
            if attempt == 0:
                if auth:  # the login browser refreshes cf_clearance for the logged-in UA
                    self.log("登录会话被 Cloudflare 拦截，重新登录")
                    self.login()
                    continue
                if self.auto_cf and self._solve_cf(url):
                    continue
            raise CFBlocked("被 Cloudflare 拦截，自动过挑战也没成功。检查服务器是否装好 Chrome。")
        return r

    def _solve_cf(self, url) -> bool:
        try:
            from seleniumbase import SB  # optional dependency
        except ImportError:
            self.log("遇到 Cloudflare 挑战，但没装 seleniumbase，无法自动处理")
            return False
        self.log("遇到 Cloudflare 挑战，启动浏览器处理…")
        try:
            with _login_lock, SB(uc=True, headless=False, xvfb=True) as sb:
                sb.uc_open_with_reconnect(url, reconnect_time=6)
                deadline = time.time() + 40
                while time.time() < deadline:
                    if not any(c in (sb.get_title() or "").lower() for c in CHALLENGE[:2]):
                        break
                    time.sleep(1)
                cookies = {c["name"]: c["value"] for c in sb.driver.get_cookies()}
                ua = sb.execute_script("return navigator.userAgent")
        except (Exception, SystemExit) as e:  # SystemExit: python3-tk / Chrome missing
            self.log("自动过挑战失败:", e)
            return False
        if "cf_clearance" not in cookies:
            self.log("浏览器没拿到 cf_clearance")
            return False
        cf = {k: v for k, v in cookies.items() if k.startswith(("cf_", "__cf"))}
        db.set_setting("cf_session", {"cookies": cf, "ua": ua, "at": config.now_str()})
        for k, v in cf.items():
            self.s.cookies.set(k, v, domain=".nodeseek.com")
        self.ua = ua  # cf_clearance is tied to the UA that solved it
        self.log("已拿到 cf_clearance")
        return True

    def html(self, path) -> BeautifulSoup:
        r = self.request("GET", path)
        if r.status_code != 200:
            raise NSError(f"GET {path} 返回 {r.status_code}")
        return BeautifulSoup(r.text, "html.parser")

    def api(self, path, body=None, referer="/", auth=False):
        r = self.request(
            "POST",
            path,
            auth=auth,
            data=json.dumps(body) if body is not None else "",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/plain, */*",
                "Origin": self.base,
                "Referer": self.base + referer,
            },
        )
        try:
            data = r.json()
        except Exception:
            raise NSError(f"POST {path} 返回 {r.status_code}，不是 JSON：{r.text[:200]}")
        return r.status_code, data

    # ---------- reading ----------
    def list_page(self, category: str, page: int = 1) -> list[dict]:
        # sortBy=postTime: newest posts first, ids strictly descending (the anonymous default is
        # last-reply order, where bumped old posts jump to the top and break the watermark)
        path = f"/categories/{category}" + (f"/page-{page}" if page > 1 else "") + "?sortBy=postTime"
        soup = self.html(path)
        items = soup.select(SEL["item"])
        if not items:  # markup changed: fall back to any element wrapping a post link
            items = [a.find_parent("li") or a.parent for a in soup.select("a[href^='/post-']")]
        out, seen = [], set()
        for it in items:
            a = it.select_one(SEL["title"]) or it.select_one("a[href^='/post-']")
            if not a:
                continue
            m = POST_ID.search(a.get("href", ""))
            if not m or int(m.group(1)) in seen:
                continue
            pid = int(m.group(1))
            seen.add(pid)
            cat_a = it.select_one(SEL["category"])
            author = it.select_one(SEL["author"])
            views = it.select_one(SEL["views"])
            replies = it.select_one(SEL["replies"])
            out.append(
                {
                    "post_id": pid,
                    "title": a.get_text(" ", strip=True),
                    "author": author.get_text(strip=True) if author else "",
                    "category": cat_a["href"].rstrip("/").split("/")[-1] if cat_a else category,
                    "views": _num(views.get_text() if views else ""),
                    "replies": _num(replies.get_text() if replies else ""),
                    "pinned": bool(it.select_one(SEL["pinned"])),
                }
            )
        return out

    def post(self, post_id: int) -> dict:
        soup = self.html(f"/post-{post_id}-1")
        body = soup.select_one(SEL["content"])
        title = soup.select_one("h1") or soup.select_one("title")
        times = soup.select(SEL["time"])
        edited = None
        for t in times:
            ctx = (t.parent.get_text(" ", strip=True) if t.parent else "").lower()
            if "edit" in ctx or "编辑" in ctx:
                edited = t["datetime"]
                break
        return {
            "post_id": post_id,
            "title": title.get_text(" ", strip=True) if title else "",
            "content": body.get_text("\n", strip=True) if body else "",
            "posted_at": times[0]["datetime"] if times else None,
            "edited_at": edited,
        }

    def rss(self, url: str) -> list[dict]:
        r = self.request("GET", url)
        return parse_feed(r.text)

    # ---------- login ----------
    def _wait_login_challenge(self, browser, timeout: float = 30, flow=None) -> None:
        """Wait for the login form's Turnstile result after the automatic attempt."""
        state = browser.execute_script(LOGIN_CHALLENGE_STATE)
        if not isinstance(state, dict):
            raise LoginError("无法读取登录表单的 Cloudflare 验证状态，未提交登录请求")
        if not state.get("present") or state.get("ready"):
            return
        self.log("等待登录表单的 Cloudflare 验证完成…")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if flow:
                flow.check()
            if _requires_email_verification(browser):
                raise LoginError(EMAIL_VERIFICATION_MESSAGE)
            browser.sleep(1)
            state = browser.execute_script(LOGIN_CHALLENGE_STATE)
            if isinstance(state, dict) and state.get("present") and state.get("ready"):
                return
        raise LoginError("Cloudflare 登录表单验证未完成，未提交登录请求。请稍后重试或在同一服务器浏览器中完成人工验证。")

    def _verify_login(self, cookies: dict, ua: str) -> bool:
        """Verify the exported cookies using NodeSeek's read-only authenticated API.

        A browser redirect or cf_clearance only proves that a page/challenge was loaded.
        Checking through the HTTP client also verifies the session used by sign-in/publish.
        Do not use request(): its challenge handler can recursively call login().
        """
        if not cookies:
            return False
        session = self._new_session(cookies)
        try:
            r = session.get(
                self.base + "/api/notification/unread-count",
                headers={"User-Agent": ua, "Accept": "application/json", "Referer": self.base + "/"},
                timeout=8,
            )
            if r.status_code != 200:
                return False
            try:
                data = r.json()
            except (ValueError, TypeError):
                return False
            return (
                isinstance(data, dict)
                and data.get("success") is True
                and "unreadCount" in data
            )
        finally:
            session.close()

    def login(self) -> None:
        """Automation first; scheduled work can wait for the panel's manual takeover."""
        if not self.manual:
            return self._login_browser()
        flow = login_flow.manager.start(self._login_browser)
        if not flow.done.wait(780):
            login_flow.manager.cancel(flow.id)
            raise LoginError("登录等待超时，请在面板重新登录")
        if flow.phase != "success":
            raise LoginError(flow.message)
        self._auth = None

    def _automatic_login(self, sb, cfg, flow=None):
        if flow:
            flow.check()
        sb.uc_open_with_reconnect(self.base + "/signIn.html", reconnect_time=6)
        if _requires_email_verification(sb):
            raise LoginError(EMAIL_VERIFICATION_MESSAGE)
        sb.wait_for_element_visible(LOGIN["password"], timeout=40)
        sb.sleep(1)
        missing = sb.execute_script(MARK_LOGIN_FORM)
        if missing:
            raise LoginError("登录页结构和预期不同，需要人工检查")
        sb.type("[data-nsh='user']", cfg["username"])
        sb.type("[data-nsh='pw']", decrypt(cfg["password_enc"]))
        try:
            sb.uc_gui_click_captcha()
        except Exception:
            self.log("自动验证未完成，等待表单验证结果…")
        self._wait_login_challenge(sb, flow=flow)
        if flow:
            flow.check()
        sb.click("[data-nsh='submit']")
        deadline, next_probe = time.monotonic() + 45, 0
        while time.monotonic() < deadline:
            if flow:
                flow.check()
            sb.sleep(1)
            if _requires_email_verification(sb):
                raise LoginError(EMAIL_VERIFICATION_MESSAGE)
            on_login_page = "signin" in sb.get_current_url().lower()
            if not on_login_page and time.monotonic() >= next_probe:
                if urlsplit(sb.get_current_url()).netloc != urlsplit(self.base).netloc:
                    raise LoginError("登录窗口离开了 NodeSeek，请重新登录")
                cookies = {c["name"]: c["value"] for c in sb.driver.get_cookies()}
                ua = sb.execute_script("return navigator.userAgent")
                if self._verify_login(cookies, ua):
                    return cookies, ua
                next_probe = time.monotonic() + 3
            err = sb.find_elements(LOGIN["error"])
            if err and err[0].text.strip() and on_login_page:
                raise LoginError("登录失败：" + err[0].text.strip()[:100])
        raise LoginError("未取得有效的 NodeSeek 登录状态（登录接口验证未通过）。请检查账号或完成人工验证。")

    def _manual_login(self, sb, flow):
        desktop = login_flow.Desktop(sb)
        try:
            flow.picture(*desktop.screenshot())
            flow.manual("自动登录未完成，请在下方窗口完成验证并点击登录；如需邮箱验证码，可在窗口中输入。")
            self.log("自动登录未完成，请打开面板完成人工验证（10 分钟内有效）")
            next_probe = 0
            while True:
                flow.check()
                # Do not export cookies from a different origin reached by a page link.
                current = urlsplit(sb.get_current_url())
                expected = urlsplit(self.base)
                if (current.scheme, current.netloc) != (expected.scheme, expected.netloc):
                    raise LoginError("登录窗口离开了 NodeSeek，请重新登录")
                for action in flow.take_inputs():
                    desktop.input(action)
                flow.picture(*desktop.screenshot())
                if "signin" not in current.path.lower() and time.monotonic() >= next_probe:
                    cookies = {c["name"]: c["value"] for c in sb.driver.get_cookies()}
                    ua = sb.execute_script("return navigator.userAgent")
                    try:
                        if self._verify_login(cookies, ua):
                            return cookies, ua
                    except Exception:
                        pass  # a transient probe failure must not close the user's window
                    next_probe = time.monotonic() + 3
                flow.stop.wait(0.7)
        finally:
            desktop.close()

    def _login_browser(self, flow=None) -> None:
        cfg = config.get()["ns"]
        if not cfg.get("username") or not cfg.get("password_enc"):
            raise LoginError("没有填写 NodeSeek 账号和密码（设置 → NodeSeek 账号）")
        try:
            from seleniumbase import SB
        except ImportError:
            raise LoginError("登录需要 seleniumbase：在 backend 里用 venv 的 pip 安装（pip install -r requirements.txt），并装好 Chrome")
        with _login_lock:
            if flow:
                flow.check()
            clear_session()
            self._auth = None
            self.log("用浏览器登录 NodeSeek…")
            # Reuse the device for this account, without inheriting another account's login.
            account_id = hashlib.sha256((self.base + "\0" + cfg["username"]).encode()).hexdigest()[:24]
            profile = str(db.DATA_DIR / "browser" / account_id)
            try:
                with SB(uc=True, headless=False, xvfb=True, user_data_dir=profile,
                        window_size="1280,900", xvfb_metrics="1366,1000",
                        chromium_arg="--force-device-scale-factor=1") as sb:
                    try:
                        cookies, ua = self._automatic_login(sb, cfg, flow)
                    except login_flow.FlowStopped:
                        raise
                    except Exception:
                        if not flow:
                            raise
                        flow.check()
                        cookies, ua = self._manual_login(sb, flow)
            except LoginError:
                raise
            except login_flow.FlowStopped:
                raise
            except SystemExit as e:  # seleniumbase exits the process when python3-tk / Chrome is missing
                raise LoginError(f"浏览器启动失败：{e}。Linux 上需要 apt install python3-tk python3-dev xvfb，并装好 Google Chrome")
            except Exception as e:
                raise LoginError(f"浏览器登录出错：{type(e).__name__}，请重新尝试")
            with account_lock:
                # An account edit cancels the old browser before it can commit its session.
                current_cfg = config.get()["ns"]
                if any(current_cfg.get(k) != cfg.get(k) for k in ("base", "username", "password_enc")):
                    raise LoginError("账号配置已更改，请重新登录")
                lock = flow.lock if flow else threading.RLock()
                with lock:
                    if flow:
                        flow.check()
                        flow.phase = "verifying"
                    _save_session(cookies, ua)
                    db.set_setting("cf_session", {"cookies": {k: v for k, v in cookies.items() if k.startswith(("cf_", "__cf"))},
                                                  "ua": ua, "at": config.now_str()})
            self._auth = (self._new_session(cookies), ua)
            self.log("登录成功")
    def _write(self, path, body, referer) -> tuple[bool, str]:
        """Call a write API; log in first if there is no session, and once more if it says we're logged out."""
        if not _verified_session(_load_session()):
            self.login()
        for attempt in range(2):
            code, data = self.api(path, body, referer, auth=True)
            msg = data.get("message") or json.dumps(data, ensure_ascii=False)
            logged_out = code in (401, 403) or (not data.get("success") and NOT_LOGGED_IN.search(msg))
            if not logged_out:
                return bool(data.get("success")), msg
            clear_session()
            self._auth = None
            if attempt:
                return False, msg
            self.log("登录状态失效，重新登录")
            self.login()
        return False, msg

    # ---------- writing ----------
    def checkin(self, random: bool = True) -> tuple[bool, str]:
        ok, msg = self._write(f"/api/attendance?random={'true' if random else 'false'}", None, "/board")
        return ok or "鸡腿" in msg, msg

    def new_comment(self, post_id: int, content: str) -> tuple[bool, str]:
        return self._write(
            "/api/content/new-comment",
            {"postId": post_id, "content": content, "mode": "new-comment"},
            f"/post-{post_id}-1",
        )

    def new_post(self, title: str, content: str, category: str) -> tuple[bool, str]:
        return self._write(
            "/api/content/new-post",
            {"title": title, "content": content, "category": category},
            "/new-discussion",
        )


def start_login():
    client = Client()
    return login_flow.manager.start(client._login_browser).public()


def parse_feed(xml_text: str) -> list[dict]:
    """RSS 2.0 or Atom -> [{title, link, post_id, category, author, published}]"""
    root = ET.fromstring(xml_text.encode() if isinstance(xml_text, str) else xml_text)
    ns = {"a": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/elements/1.1/"}
    out = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        out.append(
            {
                "title": (it.findtext("title") or "").strip(),
                "link": link,
                "summary": re.sub(r"<[^>]+>", " ", it.findtext("description") or "")[:600],
                "category": (it.findtext("category") or "").strip(),
                "author": (it.findtext("author") or it.findtext("dc:creator", namespaces=ns) or "").strip(),
                "published": _date(it.findtext("pubDate")),
            }
        )
    for it in root.iter("{http://www.w3.org/2005/Atom}entry"):
        link_el = it.find("a:link", ns)
        cat = it.find("a:category", ns)
        out.append(
            {
                "title": (it.findtext("a:title", namespaces=ns) or "").strip(),
                "link": link_el.get("href", "") if link_el is not None else "",
                "summary": re.sub(r"<[^>]+>", " ", it.findtext("a:summary", namespaces=ns) or "")[:600],
                "category": cat.get("term", "") if cat is not None else "",
                "author": (it.findtext("a:author/a:name", namespaces=ns) or "").strip(),
                "published": _date(it.findtext("a:published", namespaces=ns) or it.findtext("a:updated", namespaces=ns)),
            }
        )
    for o in out:
        m = POST_ID.search(o["link"])
        o["post_id"] = int(m.group(1)) if m else None
    return out


def _date(s):
    if not s:
        return config.now_str()
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            from datetime import datetime

            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return config.now_str()
    return d.astimezone(config.TZ).strftime("%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":  # quick selector check on the server
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to GBK; titles carry emoji
    c = Client()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        for p in c.list_page(sys.argv[2] if len(sys.argv) > 2 else "trade"):
            print(json.dumps(p, ensure_ascii=False))
    elif cmd == "post":
        print(json.dumps(c.post(int(sys.argv[2])), ensure_ascii=False, indent=2))
    elif cmd == "login":
        c.login()
        print(session_info())
    elif cmd == "rss":
        for p in c.rss(sys.argv[2] if len(sys.argv) > 2 else config.get()["hot"]["rss_url"])[:20]:
            print(json.dumps(p, ensure_ascii=False))

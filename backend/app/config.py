"""All user-editable settings live in the `settings` table under the key "config".
Missing keys fall back to DEFAULTS, so new options appear automatically after an upgrade."""
import copy
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from . import db

TZ = ZoneInfo(os.environ.get("TZ_NAME", "Asia/Shanghai"))

# NodeSeek boards: slug -> label
CATEGORIES = {
    "daily": "日常",
    "tech": "技术",
    "info": "情报",
    "review": "测评",
    "trade": "交易",
    "carpool": "拼车",
    "promotion": "推广",
    "life": "生活",
    "dev": "Dev",
    "photo-share": "贴图",
    "expose": "曝光",
    "sandbox": "沙盒",
}

DEFAULTS = {
    "ns": {
        "base": "https://www.nodeseek.com",
        "username": "",
        "password_enc": "",     # encrypted
        "auto_cf": True,        # solve Cloudflare with the browser when list pages are blocked
    },
    "price": {
        "enabled": True,
        "time": "23:00",
        "max_pages": 5,        # safety cap per night (a page is ~100 posts)
        "lookback_days": 0,     # re-scan posts first seen in the last N days to catch "已出" edits
        "cold_pages": 3,        # first run ever: how many list pages to take
        "usd_rate": 6.8,
        "delay": 3,             # seconds between page / detail requests
    },
    "hot": {
        "enabled": True,
        "rss_url": "https://rss.nodeseek.com/",
        "categories": ["info", "review", "trade"],
        "poll_minutes": 1,
        "hourly": True,         # LLM keywords for the last hour, every hour
        "daily_time": "00:05",  # LLM keywords for the last 24h
        "top_n": 10,
    },
    "upgrade": {
        "checkin": {"enabled": False, "time": "08:05", "random": True},
        "post": {
            "enabled": False,
            "times": ["09:30", "13:30", "18:30", "21:30"],
            "category": "daily",
            "news_feeds": [     # RSS/Atom URLs used as material
                "https://www.ithome.com/rss/",
                "https://hnrss.org/frontpage",
                "https://www.v2ex.com/index.xml",
                "https://sspai.com/feed",
            ],
            "use_hot": True,    # also write about today's hot keywords
            "style": "",        # extra instructions for the LLM
        },
        "comment": {
            "enabled": False,
            "times": ["10:15", "15:15", "20:15"],
            "per_run": 2,
            "daily_max": 6,
            "categories": ["daily", "tech", "info"],
            "keywords": [],     # only comment on titles containing one of these (empty = any)
            "style": "",
        },
    },
    "notify": {
        "tg_api": "https://api.telegram.org",
        "tg_token_enc": "",
        "tg_chat_id": "",
        "modules": {"price": True, "hot": True, "checkin": True, "drafts": True, "errors": True},
    },
    "cleanup": {
        "time": "02:00",
        "topics_days": 15,
        "runs_days": 10,
        "drafts_days": 15,
        "notifications_days": 10,
        "trade_days": 0,        # 0 = keep forever (the price history needs it)
    },
}


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def get() -> dict:
    return _merge(DEFAULTS, db.get_setting("config", {}))


def save(cfg: dict) -> None:
    db.set_setting("config", _merge(get(), cfg))


def now() -> datetime:
    return datetime.now(TZ)


def now_str() -> str:
    return now().strftime("%Y-%m-%d %H:%M:%S")


def today() -> str:
    return now().strftime("%Y-%m-%d")

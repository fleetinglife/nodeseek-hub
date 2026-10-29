> [!WARNING]
> **免责声明**：签到、发帖、评论等「升级」功能会以你的账号与 NodeSeek 交互。若因使用本程序导致账号被限制或封禁，开发者概不负责，请斟酌使用，并遵守 NodeSeek 的社区规则。

# nodeseek-hub

NodeSeek 的行情与动态面板：交易区溢价走势、各板块热度关键词、每日签到和发帖/评论草稿，结果通过 Telegram 推送。

自托管，单用户，密码登录。后端 FastAPI + SQLite + APScheduler，前端 React + Vite + Tailwind + shadcn/ui，LLM 用任何 OpenAI 兼容接口（默认 DeepSeek）。

## 功能

| 页面 | 做什么 |
|---|---|
| 价格走势 | 每晚抓取交易区新帖，标题像成交的（已出、已收……）再读正文，交给 LLM 归一出商家、型号、溢价、总价、折扣，判断是否成交。只写了总价、但正文给了续费价和到期日的，按剩余价值估算溢价。按型号画 7 日滚动中位数走势，统计热门型号。 |
| 热度话题 | 每分钟拉一次 RSS，只保留所选板块的新帖；LLM 每小时、每天各归纳一次热度关键词和一句话总结。 |
| 升级 | 按时自动签到。帖子（素材来自新闻源和当日热点）和评论（所选板块、关键词的新帖）由 LLM 写成**草稿**，在面板里看过、改过、点「发布」才会发出。 |
| 通知 | 自己的 Telegram 机器人，每类消息单独开关：价格日报、每日热点、签到结果、新草稿、任务出错。 |
| 设置 | NodeSeek 账号、各模块的时间和参数、新闻源、数据保留天数。 |

每个页面底部都有对应的定时任务：下次运行时间、最近的运行结果、实时日志，也可以手动立即运行。

## 页面预览

**价格走势**

![价格走势](https://cloud.fleetinglife.org/f/X1fn/nodeseek1.png)

**热度话题**

![热度话题](https://cloud.fleetinglife.org/f/7zhK/nodeseek2.png)

**升级**

![升级](https://cloud.fleetinglife.org/f/O8tY/nodeseek3.png)

**通知**

![通知](https://cloud.fleetinglife.org/f/orCJ/nodeseek4.png)

**设置**

![设置](https://cloud.fleetinglife.org/f/NkiA/nodeseek5.png)

## 部署（Debian / Ubuntu 服务器）

需要一台能访问 NodeSeek 的服务器（国内机器一般连不上 `rss.nodeseek.com`），Debian 12+ 或 Ubuntu 22.04+，root 权限。

```bash
git clone https://github.com/fleetinglife/nodeseek-hub.git /opt/nodeseek-hub
cd /opt/nodeseek-hub
bash install.sh
```

`install.sh` 会：

1. 安装系统依赖：Python、`python3-tk`、`xvfb`、Google Chrome（arm64 装 Chromium）、Node.js 22；
2. 构建前端（`frontend/dist`），建 Python 虚拟环境并装依赖；
3. 第一次运行时生成 `backend/.env`，面板密码随机生成并打印出来；
4. 注册并启动 systemd 服务 `nodeseek-hub`，只监听 `127.0.0.1:8001`。

装完后：

```bash
vim /opt/nodeseek-hub/backend/.env       # 填 LLM_API_KEY
systemctl restart nodeseek-hub
```

可选参数：`PORT=9000 bash install.sh` 换端口；`SKIP_CHROME=1 bash install.sh` 不装浏览器（这样签到和发布用不了）。

### 访问面板

面板只监听本机，外网直接访问不到。两种方式：

- **SSH 隧道**（最省事）：本机执行 `ssh -L 8001:127.0.0.1:8001 root@服务器IP`，浏览器打开 `http://localhost:8001`。
- **域名 + HTTPS**（长期使用）：用 Nginx 反代并配证书。登录 cookie 不要走明文 HTTP。

```nginx
server {
    listen 443 ssl;
    server_name ns.example.com;
    ssl_certificate     /etc/letsencrypt/live/ns.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ns.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 更新

```bash
cd /opt/nodeseek-hub && git pull && bash install.sh
```

脚本可以重复运行：会重新构建前端、更新依赖、重启服务，不会覆盖已有的 `.env` 和数据。

## 第一次使用

1. 用 `.env` 里的 `APP_PASSWORD` 登录面板。
2. **设置 → NodeSeek 账号**：填用户名、密码，点「测试登录」。会在服务器上用浏览器过人机验证，大约 20–60 秒。程序会用导出的会话请求只读的登录接口，验证通过才保存并显示「已登录」；页面跳转或拿到 `cf_clearance` 不代表账号登录成功。旧版本保存的未验证会话需重新登录，失效会话会自动重新登录并最多重试一次。
3. **通知**：填 Telegram Bot Token 和 Chat ID，点「保存并发测试消息」。
4. **价格走势**：点页面底部「抓取交易区」的运行按钮。第一次会取最近几页（一页约 100 帖），之后每晚只抓新帖。
5. **热度话题**：RSS 每分钟自动拉取；攒一两个小时数据后，热度分析才有内容。
6. **升级**：签到、帖子草稿、评论草稿默认都是关的，在设置里按需打开。

> 只有签到、发帖、评论会用登录状态；抓取列表、读帖子、拉 RSS 都是匿名访问。

## 配置（`backend/.env`）

| 变量 | 说明 |
|---|---|
| `APP_PASSWORD` | 面板登录密码，必填 |
| `LLM_API_KEY` | LLM 的 key，必填 |
| `LLM_BASE_URL` | OpenAI 兼容接口地址，默认 `https://api.deepseek.com` |
| `LLM_MODEL` | 模型名，默认 `deepseek-v4-flash` |
| `LLM_THINKING` | 默认关闭思考模式；设为 `enabled` 才开 |
| `TZ_NAME` | 定时任务的时区，默认 `Asia/Shanghai`（和服务器系统时区无关） |
| `DATA_DIR` | 数据目录，默认 `backend/data` |
| `HTTPS_PROXY` | 程序的出站请求走代理，国内本地调试时用 |

其余参数（抓取时间、页数、板块、签到时间、新闻源、保留天数等）都在面板的「设置」页里改。

## 本地开发

需要 Python 3.10+、Node.js 20.19+、Google Chrome。

```bash
# 后端
cd backend
python -m venv venv
./venv/bin/pip install -r requirements.txt        # Windows：.\venv\Scripts\python.exe -m pip install -r requirements.txt
cp .env.example .env                              # 填 APP_PASSWORD 和 LLM_API_KEY
./venv/bin/uvicorn app.main:app --port 8000 --reload

# 前端（另开一个终端）
cd frontend
npm install
npm run dev                                       # 打开 http://localhost:5173，/api 会转发到 8000
```

国内网络连不上 `rss.nodeseek.com` 和 Telegram，本地调试时在启动后端的终端里先设代理：

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7890"          # PowerShell；bash 用 export HTTPS_PROXY=...
```

在 Windows 上用 seleniumbase 安装依赖时，如果报 `To modify pip, please run ...`，改用 `python.exe -m pip install ...`。

### 检查页面解析

NodeSeek 的页面结构没有公开文档。改版导致解析不对时，用这几条命令看程序实际读到了什么：

```bash
cd backend
./venv/bin/python -m app.ns list trade      # 交易区第 1 页：post_id、标题、浏览、回复、是否置顶
./venv/bin/python -m app.ns post 帖子ID      # 正文、发帖时间、编辑时间
./venv/bin/python -m app.ns rss              # RSS 条目和分类
./venv/bin/python -m app.ns login            # 用设置里的账号登录一次
```

选择器集中在 `backend/app/ns.py` 顶部的 `SEL`（列表和详情）和 `MARK_LOGIN_FORM`（登录表单）。

## 数据和备份

`backend/data/` 里是全部状态，备份这个目录即可：

- `app.db`：帖子、分析结果、草稿、设置、运行记录；
- `secret.key`：NodeSeek 密码、登录状态、Bot Token 的加密密钥，**丢了这些就解不开**；
- `browser/`：登录用的浏览器配置，NodeSeek 靠它记住这台设备。

过期数据每天自动清理，保留天数在「设置 → 数据清理」里改；交易帖默认永久保留，价格走势要用。

## 常见问题

**登录失败 / 浏览器启动失败**：确认装了 Chrome、`python3-tk`、`xvfb`。缺 `python3-tk` 时 seleniumbase 会直接退出，面板上会显示原因。数据中心 IP 偶尔过不了人机验证，过一会儿再点「重新登录」。

**自动登录失败，需要手动点击验证**：面板「设置 → NodeSeek 账号 → 测试登录/重新登录」先尝试自动处理。未完成时，面板会弹出服务器上同一个浏览器的画面，你可直接点击验证框和登录按钮。需要输入验证码时，先点击画面里的输入框，再通过窗口下方工具输入。账号会话经只读登录接口确认有效后才保存；页面跳转、`cf_clearance` 或验证码页面均不算登录成功。定时任务遇到登录失效也会提示接管，面板需保持打开才能及时看到。

接管窗口保留 10 分钟，可关闭弹窗后通过提示条重新打开；「取消登录」、超时、账号修改或服务关闭会结束本次接管，浏览器随工作线程退出。画面和输入仅在内存中短暂保存，接口沿用面板登录认证、禁止跨站操作，不开启 VNC 或其他公网端口。Linux 需要 X11/Xvfb，以及 SeleniumBase 依赖中的 Pillow 和 python-xlib；当前仅支持单进程后端。旧版 `/api/ns/login` 接口保留自动登录行为，新面板使用异步 `/api/ns/login/start` 和状态轮询。

画面太小时可点「放大画面」后滚动查看。若服务器浏览器的中文显示为方框，需要给运行服务的用户安装中文字体（如 Debian 的 `fonts-wqy-microhei`），再重新开始登录。

**提示需要邮箱验证码**：NodeSeek 有时会转到 `emailSignIn.html`。在同一个接管窗口中完成验证即可；是否要求邮箱由 NodeSeek 当次登录流程决定。

**被 Cloudflare 拦截**：程序会自动用浏览器拿 `cf_clearance` 再重试。一直被拦，就换一台 IP 干净的服务器。

登录表单的 Turnstile 验证结果与 `cf_clearance` Cookie 是不同的。登录时自动尝试处理后，程序会最多等待 30 秒，确认表单验证结果非空才自动提交账号密码；超时后保留浏览器供人工验证。

**LLM 报「没有返回可用的 json」**：看报错里的 `finish_reason`。是 `length` 的话，要么模型在思考（检查 `LLM_THINKING`），要么一批帖子太多，把 `backend/app/price.py` 里的 `BATCH_TITLE`、`BATCH_WITH_BODY` 调小。

**有的帖子详情 404**：标题旁带锁的帖子要求等级才能看，匿名访问读不到，只按标题判断，不影响整体。

**RSS 一次只有 20 条**：NodeSeek 的 RSS 固定返回最新 20 条（所有板块合计），每分钟拉一次足够覆盖。

## 关于自动发帖和评论

NodeSeek 社区对 AI 自动回帖很反感，被认出来的账号会被处理。所以本项目只自动生成草稿，发布始终需要人工确认；提示词也要求只说有信息量的话、不编造经历，没把握就跳过。请遵守 NodeSeek 的社区规则。

## 许可

[MIT](LICENSE)

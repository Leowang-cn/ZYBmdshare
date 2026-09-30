# MDShare

当前已升级为单用户 Markdown 笔记应用，支持目录、公式、Mermaid、音视频附件和 PIN 只读分享。单栏编辑/阅读，可选分屏；不是 Typora 的即时所见即所得编辑器。

## 当前部署方式

需要 Node 22+，单进程运行，不需要 Docker 或原生数据库模块。平台使用已验证的 Node 24，环境准备/构建：

```sh
export PATH=/usr/local/node24/bin:$PATH
npm ci --include=dev
npm run build
```

平台补充文件 `.env` 设置至少 24 字符的随机 `ACCESS_TOKEN`。启动命令：

```sh
/usr/local/node24/bin/node --env-file=.env server.mjs --port 8915
```

健康检查 `/api/health` 保持兼容。`DATA_DIR` 默认 `./data`，需要平台保证重新部署后保留。只能运行一个进程使用此目录。跨不可信网络使用 HTTPS，并设置 `COOKIE_SECURE=1`。

## AI 问答

在本地 `.env` 填入 `AI_API_KEY`，服务端读取，浏览器不会接触 Key：

```dotenv
AI_BASE_URL=https://llm.baifentan.com/openproxy/rp/v1
AI_MODEL=gpt-5.2
AI_API_KEY=
```

修改后重启：`node --env-file=.env server.mjs --port 8927`。本地配置沿用 `.runtime/browser-test` 示例数据和测试管理令牌；正式部署必须改为自己的数据目录及随机管理令牌。不要提交 `.env`，不要把 Key 粘贴到聊天或日志中。

- 工具栏的 AI 问答按钮默认选中当前笔记，可逐篇勾选其他笔记（子笔记不会自动包含）。发送前请保存正文。
- 所选笔记正文和开启的本地图片会发送到配置的 AI 服务。请确保你有权向该服务传输这些数据。
- 每次请求读取所选笔记的最新已保存版本，并带上此前问答。笔记范围在首次成功后锁定，新建对话可重新选择。对话仅存于当前页面，刷新或退出会丢失。
- 可以把整条回答以 Markdown 保存，或选中一段回答后以纯文本保存。创建前可修改标题、所属目录和正文，默认附带问题及来源版本信息。
- 最多 10 篇笔记、10 轮历史、问题 8000 字符，总上下文 100000 字符；图片最多 8 张、合计 12 MiB。超限会报错，不静默截断。
- 图片仅限所选笔记正文中引用且属于该笔记的本地 PNG/JPEG/WebP/GIF 附件。不会读取外链图片、音视频、PDF 或网页链接内容。
- 使用 OpenAI Chat Completions，非流式完整返回，输出上限 4096 tokens，超时 120 秒；全局同时最多一个请求。停止会取消本地请求，但供应商可能仍计费。
- 仅管理用户可用，分享访客不能调用。模型返回内容不保证正确，请核对来源。默认模型的真实权限与图片支持需填入 Key 后验证；自动测试使用模拟服务，不访问真实供应商。

API：`POST /api/ai/chat`，管理鉴权同笔记 API，请求字段 `noteIds`、`question`、`includeImages`、`history`（交替的 user/assistant 文本消息），返回 `answer`、`sources`、`warnings`、`model`、`imageCount`。

## 分享 PIN

- 管理界面使用管理令牌，API 使用 `Authorization: Bearer <ACCESS_TOKEN>`；管理会话 8 小时。
- 分享包含选中笔记及全部子笔记，仅可读。随机长链接与四位数字 PIN 必须同时具备，支持前导零。
- 创建时指定 PIN 或自动生成，PIN 不放进 URL、不明文持久化。链接和 PIN 请分别保存发送。
- 每个分享每分钟最多 10 次解锁尝试（包括成功尝试）。限制是进程内、整个分享共用，恶意尝试可临时耗尽额度；四位 PIN 不适合公开高敏感资料。
- 解锁有效期 8 小时；服务重启、修改 PIN 或撤销分享会使原会话失效。管理令牌改变后需重新设置分享 PIN。
- 正文与附件均校验分享权限；已经复制或下载的内容不能撤回。
- 分享页工具栏支持下载 ZIP，包含分享笔记及全部子笔记的 Markdown 和分享范围内的本地图片。文件名包含笔记 ID，避免同名覆盖；图片链接改为包内相对路径。外链图片不抓取。
- ZIP 不包含音视频源文件；外链音视频 URL 保持不变，本地音视频转换为带分享标识的在线 URL，仍需有效的 PIN 解锁会话。离线时不可播放；分享撤销、会话过期或使用不共享浏览器 Cookie 的阅读器时可能无法播放。其他非图片附件也仅保留在线链接。
- 下载接口为 `GET /api/public/:token/download`，与阅读接口使用相同的 PIN Cookie 校验。HTTPS 反向代理部署应设置 `COOKIE_SECURE=1`，并保留原始 Host，以生成正确的媒体 URL。
- 旧的无 PIN 分享默认锁定，需在分享列表设置 PIN 或重新创建。

## 管理 API

`GET /api/notes` 获取笔记及 revision。`POST /api/notes` 创建，`PUT /api/notes/:id` 修改，字段为 title、markdown、parentId，修改必须提供 revision。`DELETE /api/notes/:id` 请求体包含 revision，删除整个子树。

`POST /api/notes/batch` 原子创建；`PUT /api/notes/batch` 原子修改。请求体为 `{ "notes": [...] }`，最多 100 篇、整体 2 MiB。修改每项包含 id、revision 和完整字段，任意冲突整批回滚并返回 409。创建可用 key 与 parentKey 引用本批较早创建的笔记：

```json
{"notes":[{"key":"root","title":"项目","markdown":"# 项目"},{"parentKey":"root","title":"记录","markdown":"正文"}]}
```

`POST /api/shares` 接收 noteId 与可选 pin，返回 url、pin；`PUT /api/shares/:id` 接收 pin 进行重设；`DELETE /api/shares/:id` 撤销。访客 `POST /api/public/:token/unlock` 提交 pin 获取 HttpOnly Cookie 后读取 `GET /api/public/:token`。

附件上传 `POST /api/notes/:id/attachments?name=...` 使用二进制请求体与正确 Content-Type，最大 512 MiB，并以流式方式写入磁盘，避免大文件完整进入内存。支持图片、音视频、PDF；不允许 HTML/SVG。音视频能否播放取决于实际编码。外链媒体会向对应站点发送请求。

新视频子笔记使用提交 URL 路径末尾的文件名命名：解码中文等 URL 编码，去掉 MP4/WebM 扩展名，忽略查询参数与片段，标题最多 200 个字符。没有可用文件名时使用“父笔记名 - 视频 N”。哈希文件名原样保留，无法仅凭 URL 恢复来源页面中的中文标题；此规则不修改已有子笔记。

视频任务接受多个直接下载的 HTTP(S) URL。每个 URL 创建一个子笔记和持久化后台任务；服务重启后会继续排队。任务限制下载大小为 512 MiB，使用 `ffprobe` 校验视频轨道、格式和 1200 秒（20 分钟）时长，再用 FFmpeg 提取音频、调用 OpenAI 兼容 ASR 接口、调用总结模型推断最多 6 个关键帧，并保存视频、音频和截图。失败任务可以重试。需要安装 `ffmpeg` 和 `ffprobe`，配置 `ASR_BASE_URL`、`ASR_API_KEY`、`ASR_MODEL`；总结默认复用 `AI_*`，也支持独立的 `SUMMARY_*` 变量。仅支持直接可下载的 MP4/WebM 类文件，不绕过 DRM 或平台登录。

笔记侧边栏在每个父级内按名称自动排序，中文使用拼音顺序，数字使用自然顺序（例如“视频 2”排在“视频 10”之前）。保存改名后自动重新排序，不改变笔记父子关系；只读分享页同样适用。

## 备份与验收
视频转写默认配置为 `qwen3-asr-flash-2025-09-08`，使用国内代理 `https://openproxy-cn.yukework.com/openproxy/rp/v1` 的 JSON 音频消息接口；`ASR_API_KEY` 留空时复用 `AI_API_KEY`。其他模型保留 OpenAI 兼容的 multipart 转写路径。上传给 ASR 的音频为 MP3，笔记音频附件仍为 WAV。Qwen 音频按最多 60 秒切片依次转写，避免单次音频过长；逐字稿标注真实切片时间范围，并非模型返回的逐句时间戳，图文定位也仅具有分段精度。修改环境变量后需重启服务。


界面导出和 `GET /api/export` **仅包含正文及元数据，不含附件二进制**，目前没有界面恢复功能。完整备份需停止写入后复制整个 DATA_DIR 到异机存储；恢复时停止服务后还原整个目录，保留原管理令牌才能继续使用原 PIN。删除笔记暂不清理磁盘孤立附件。

正式使用前验证重启、重新部署后笔记及附件保留；`.gitignore` 不保证持久化。运行 `npm run build` 和 `npm test` 验证构建、批量原子性、PIN 与附件权限、限速、重置失效及重启持久化。浏览器视觉验收需另行执行。

---

## 历史部署探针记录（非当前部署步骤）

这是部署兼容性探针，不是 Markdown 编辑器，也不是已部署的 Trilium。它先验证部署平台的 Node 运行环境、端口、鉴权、可写目录和重启持久化，再通过可选命令检查固定版本 Trilium 官方包。代码无第三方 npm 依赖，无前端构建步骤，无数据库服务依赖。

## 部署后台填写

将本仓库推送到你自己的 GitHub 仓库后，在部署后台手动创建独立项目。不要继续使用此前指向 Trilium 上游仓库的配置。

| 设置 | 值 |
| --- | --- |
| 仓库 | 你推送后的仓库 URL |
| 分支 | 你实际推送的分支，例如 main |
| 部署目录 | `/data/deploys/mdshare-probe`，不要与已有项目共用 |
| 环境准备命令 | `/usr/local/node24/bin/node --version` |
| 启动命令 | `/usr/local/node24/bin/node server.mjs` |
| 健康检查路径 | `/api/health` |
| 验收脚本 | 先留空；可手动执行 `node verify.mjs` |

Node 需要 22 或更新版本。上述绝对路径来自后台显示的 Node 24 安装位置。默认 Node 16 不适用。仅运行 Node 标准库，无需 `npm install`，也不要配置 Python 依赖安装。

环境变量在后台配置：

- `ACCESS_TOKEN`：必填，至少 24 字符，建议随机 32 字节。不要提交到 Git，也不要将真实令牌发到聊天。可在自己的终端执行 `openssl rand -hex 32` 生成。
- `PORT`：由平台自动分配，不手动固定。也支持启动参数 `--port 8913`，参数优先于环境变量；只在平台未注入端口时使用其实际分配值。未配置时本地默认 8080。
- `DATA_DIR`：默认 `./data`，相对于项目根目录。保持位于独立项目内，不要使用会被清理的临时目录。

监听固定为 `0.0.0.0`。配置缺失、端口无效、数据目录不可写或持久化标记损坏时启动失败，不会悄悄清空数据。仅支持单实例；不要让多个进程共用该数据目录。

`.env.example` 只是变量说明，应用不会自动加载 `.env`。优先使用后台环境变量；本地 Node 22/24 可以使用 `node --env-file=.env server.mjs`。请勿把空白示例令牌直接用于启动。

## 检查结果

- `GET /`：公开的 JSON 服务信息，不是前端编辑界面。
- `GET /api/health`：公开最小健康检查，读取数据标记失败时返回 503。`triliumVerified` 始终为 false，避免误报笔记服务已可用。
- `GET /api/report`：需要 `Authorization: Bearer <ACCESS_TOKEN>`，返回 Node、glibc、内核、主机内存/CPU、可用磁盘和持久化标记。不返回环境变量或令牌。

主机资源不等于项目配额。该探针不测试 MinIO、Redis、PostgreSQL，不证明公网可达，也不修改系统配置。诊断信息仅供管理员查看；不要直接公开 HTTP 端口。跨不可信网络请使用 HTTPS 反向代理或 VPN。

平台服务启动后，在持有相同令牌的终端执行：

```sh
BASE_URL=http://服务器地址:分配端口 node verify.mjs
```

`verify.mjs` 从当前环境读取 `ACCESS_TOKEN`，依次验证健康检查、匿名请求拒绝及授权报告。输出不包含令牌。

## 重启与重新部署验收

1. 首次运行 `verify.mjs`，记录 `persistence.id` 和 `boots`。
2. 手动重启服务，再运行验证。ID 应保持一致，boots 应增加。
3. 手动重新部署同一仓库，再验证同样两项。可设置 `EXPECTED_MARKER_ID` 和 `MIN_BOOTS` 让脚本自动断言。
4. 若 ID 改变，说明数据目录被替换或清理，不能据此环境上线正式笔记。

`.gitignore` 只能防止提交数据，不能保证平台更新时保留数据。正式使用前必须实测更新策略并安排异机备份。数据目录内 `probe.json` 不是用户笔记，只保存随机标记和启动计数。

## 可选：Trilium 官方包兼容性检查

只在 Linux x64 部署服务器手动执行，不是默认启动步骤：

```sh
/usr/local/node24/bin/node trilium.mjs prepare
/usr/local/node24/bin/node trilium.mjs check
```

`prepare` 从官方 GitHub 下载约 94 MB 的 v0.106.0 服务端发行包，校验固定 SHA-256，再解压到项目 `.runtime/` 并检查。首次需要 GitHub 网络访问、tar/xz 和 ldd；不要求 sudo，不安装系统库，不更改系统 Node。下载有 180 秒超时。失败时命令返回非零状态，可在后台“环境准备”日志中查看具体原因。`check` 只检查已经解压的包。

发行包：<https://github.com/TriliumNext/Trilium/releases/tag/v0.106.0>

固定 SHA-256：`c693a28eb86d2892e30553d8fd9a171f4d72e5c76f02dd3fb335f6bd476b6aec`。

检查会尝试运行包内 Node，并对原生模块执行共享库依赖检查。glibc/GLIBCXX 缺失会报告失败。即使通过，也不代表原生模块 Node ABI、应用启动或笔记功能已验证。macOS 本地会明确拒绝这一步，不能将本机结果当作服务器结果。

不提供未经验证的 Trilium 自动启动或一键系统修复。兼容检查通过后，再配置实际服务并验收 Markdown、Mermaid、TeX 公式、音视频分享、子树权限和 ETAPI 批量写入。

## 本地测试

```sh
npm test
```

覆盖动态端口、鉴权、健康检查、方法限制、重启后的标记保留及损坏数据保护。测试使用临时目录，不访问部署服务器，不下载 Trilium。
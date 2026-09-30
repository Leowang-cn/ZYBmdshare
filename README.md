# MDShare 部署测试项目

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
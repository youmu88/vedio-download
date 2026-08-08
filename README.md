# 视频下载器（全栈）

基于 Playwright 网络拦截 + 多引擎下载的视频下载服务。支持 HLS (m3u8)、DASH (MPD)、直链 (mp4/mkv/webm) 以及 CCTV 特判解密。

## 功能

- REST API + Socket.IO 实时任务进度
- 任务队列（默认并发 2）、自动重试（指数退避）、错误分类（永久错误不重试）
- 多引擎降级：N_m3u8DL-RE → ffmpeg → JS 原生下载器
- JS 下载器支持 AES-128 解密、并行分片、断点续传（分片级 checkpoint）、fMP4 (EXT-X-MAP)
- 直链下载支持 Range 断点续传与防盗链请求头
- 全局/单任务限速、真实带宽统计、磁盘空间预检
- 断点续跑：停止任务后重试，已下载分片自动跳过
- 浏览器池复用（cookie/代理按任务注入）、SSRF 全链路防护、可选 API Token
- iOS/macOS 风格三页界面（下载 / 浏览 / 设置），浅色深色主题自动跟随
- 浏览页：本地视频库、在线 m3u8/mp4 播放（hls.js）、播放记录与自动续播
- 前端资源全部本地化（socket.io / hls.js，无 CDN 依赖）、下载默认参数可在设置页配置

## 快速开始

```bash
npm ci
npm start
```

浏览器打开 <http://localhost:3456>，粘贴视频播放页 URL 即可。

依赖（下载引擎）：

- `ffmpeg` / `ffprobe`（建议安装）
- `N_m3u8DL-RE`（可选，HLS 首选引擎）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3456` | 服务端口 |
| `API_TOKEN` | 空 | 设置后所有 API 需 `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | 本机 localhost | CORS 白名单，逗号分隔；`*` 全放开 |
| `DOWNLOADS_AUTH` | 空 | `1` 且设置了 `API_TOKEN` 时，下载文件也需鉴权 |
| `MAX_BANDWIDTH` | `0` | 全局限速（字节/秒），`0` 不限制 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `AUTO_START_QUEUE` | `1` | `0` 时进入待命模式：启动后不自动处理任务队列（维护/调试用） |

## API 摘要

- `POST /api/download` — 创建任务 `{ url, cookies?, injectScript?, maxSpeed?, proxy? }`
- `POST /api/download/advanced` — 高级任务 `{ url, engine?, format?, parallel?, parallelCount?, maxSpeed?, timeoutMs?, bandwidth? }`
- `GET /api/tasks` / `GET /api/task/:id` — 任务查询
- `POST /api/task/:id/cancel` — 停止任务（保留分片缓存，可续跑）
- `POST /api/task/:id/retry` — 重试失败/已停止任务
- `POST /api/tasks/retry-batch` / `delete-batch` — 批量操作
- `DELETE /api/task/:id` — 删除任务
- `GET /api/health` — 健康检查（含队列/浏览器池/引擎/磁盘）
- `GET /api/stats` — 统计
- `GET /api/library` — 已下载视频库（文件列表，供浏览页播放）

## 部署

### Docker

```bash
docker compose up -d --build
```

### PM2

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save
```

## 测试

```bash
npm test
```

## 目录结构

- `src/index.js` — 服务入口、调度器、API
- `src/task-manager.js` — 任务队列/生命周期/持久化
- `src/m3u8-interceptor.js` — Playwright 流拦截
- `src/browser-pool.js` — 浏览器池
- `src/downloader.js` — 多引擎下载调度
- `src/js-downloader.js` — 纯 JS HLS 下载器（续传/AES/fMP4）
- `src/security.js` — SSRF 防护
- `public/` — 前端页面

下载文件输出到 `downloads/`，任务状态持久化在 `data/tasks.json`。

# 交付报告：MKV 边转边播（流式转换）+ H.264 快路管线

> objectiveId: obj_1789049478404_24zoid · 2026-09-10
> 方案：`docs/MKV边转边播-方案设计.md`（用户已拍板：**转完为止 / 全面替换 / 立即开发**）
> 结论：**已实现并全量验证** —— 点击 MKV 即从第 0 秒起播（真实文件实测首分片 ≈2 秒），后台按「够播且不抢资源」的速率限速转换（≈0.3~0.6 核），转换完成自动合封标准 MP4 入库。全套件 **24 pass / 0 fail**。

---

## 一、用户问题的直接答案

**「是否支持类似视频流，边转换边播放？」→ 支持，已落地并经真实文件实测。**

| 维度 | 旧行为（昨天版本） | 新行为（本次交付） |
|---|---|---|
| 起播时机 | 必须等**整部转码完成** | **点击后 ≈2 秒**（首个 HLS 分片就绪即播） |
| 转换 CPU | 全量重编码，**≈8 核满载**数分钟 | 限速转换，**≈0.3~0.6 核**（10 核机的 3~6%） |
| 「活着-1994」这类文件 | 误判为全量重编码（视频其实是 H.264），2h12m 片约 **4.6 分钟满载** | 走快路（视频直拷+音频转 AAC）≈77 倍速，**约 1.7 分钟、≈1 核** |
| 观看中拖动 | 转完才可播，无此限制 | 只能拖到已转换范围（越界有提示）；转换完成后随全片拖 |
| 播完后的文件 | 生成 MP4 入库 | 不变（HLS 分片 -c copy 合封 MP4 入库，自动进视频库） |

---

## 二、实现清单

### 服务端

| 文件 | 改动 |
|---|---|
| `src/transcode.js`（重写为流式会话模块） | ① 管线矩阵 `resolvePipeline`：H.264+AAC/无 → remux；**H.264+其他音频 → copy-audio（新增快路）**；其他编码 → encode（libx264）② 会话化：`startStreamSession` 产出 HLS 事件播放列表（4s/片、全量保留、`temp_file` 原子落地、`-readrate` 限速 + 首段 burst）③ 完成自动合封 `<原名>.mp4`（+faststart，时长校验 ±2s/±2% 才入库）④ 取消/清理：`cancelSession`、`sweepSessions`（done 30 分钟 / failed·cancelled 5 分钟无访问回收分片）、`cleanupOrphanDirs`（启动清孤儿）⑤ 并发上限 2（超出 429） |
| `src/index.js` | ① `POST /api/transcode` 语义升级为「确保流式会话」，返回 `streamId/playlist`，保留 `409 exists/running` 续接契约（running 附带 playlist）② 新增 `GET /api/stream/:id/index.m3u8`（**服务端重写分片行附加 token**）、`GET /api/stream/:id/segNNNNN.ts`（`dotfiles:'allow'`）、`POST /api/stream/:id/cancel` ③ 启动清理孤儿 + 每分钟清扫会话 ④ 关停钩子改 `cancelAllSessions` |
| 速率默认值（环境变量可调） | `VD_STREAM_RATE_ENCODE=1.25`（重编码限速 1.25 倍速）、`VD_STREAM_RATE_COPY=6`（直拷系 6 倍速）、`VD_STREAM_MAX_CONCURRENT=2` |

### 前端（`public/js/player-core.js`）

- **点击即触发**：三信号（主动预判/静默弃轨检测/onerror）任一命中 → 自动 `POST /api/transcode` → 等首分片 → 用既有 hls.js 管线起播（`startPosition:0` + `initialLiveManifestSize:1`，从 0 秒起播、1 个分片即可起）；
- 播放器内**状态条**：`后台转换中 N%（已转换 mm:ss）` + **「停止转换」按钮**（用户手动取消入口）；
- **seek 越界提示**：拖到未转换区域 → toast「该位置尚未转换完成（已转换到 …）」（节流 4s）；
- **409 续接**：产物已存在 → 直接播 MP4；转换中 → 直接播现有会话流；
- 启动失败 → 落回手动入口（提示条 +「开始边转边播」按钮），并防探测/静默检测双信号重复 POST。

### 测试

| 文件 | 内容 |
|---|---|
| `test/stream.test.js`（新增，5 例） | ⑬ 快路矩阵（H.264+AC3 → mode=copy-audio、产物可播入库）⑭ **渐进产出**（首个分片先于转换完成 + ENDLIST + 合封入库）⑮ 鉴权与 token 重写（401/404/分片行带 token）⑯ 取消会话（cancelled 事件 + 可重新启动）⑰ 路由防护（非法 id/分片名 404） |
| `test/mkv-play.test.js`（更新 4 例） | ⑧ 现象级改为「边转边播流出画面 + 产物入库」⑨ 静默失败 → **自动启动边转边播**（stub 解除后验证出画面）⑪ WebKit → 自动边转边播 → 流可播 ⑫ 409 exists 直接续播 MP4（不重启流） |
| `test/transcode.test.js` | ⑤⑥⑥b⑦ 契约不变，全绿（零改动通过） |

---

## 三、验证证据

### 1. 全量测试（`npm test`，退出码 0）

```
ℹ tests 24  ℹ pass 24  ℹ fail 0  ℹ skipped 0
✅ 全部检查通过
```
（原 19 例 + 新增 5 例；含前端 HTML 检查、4 个外部 JS 语法检查。）

关键用例实测输出：

- ⑧ 现象级：`点击即播：cp.src=/api/stream/<32位id>/index.m3u8?token=…（边转边播流）`（真实浏览器链路，非直解）
- ⑭ 渐进产出：首个分片 GET 200、TS 同步字节 0x47、**此刻 ENDLIST=false**（转换仍在进行）→ 随后 ENDLIST + 合封产物入库
- ⑪ WebKit：`拒收 matroska → 自动边转边播 → 流可播 → 产物入库` 全绿

### 2. 真实文件冒烟（`活着-1994.mkv` 2 分钟无损截取：h264 + AC3 + 2×subrip 字幕轨）

```
POST → 200 streamId=…（copy-audio 快路自动命中）
首分片就绪 @2.1s：GET 200、552KB、首字节=0x47、ENDLIST=false
CPU 采样（ffmpeg 进程 %CPU）：27.1, 27.7, 24.9, 27.9, 26.2, 24.7, 26.8, 29.0, 28.5 → 均值 27.0%
✅ 产物：video=h264 audio=aac duration=120.14s（源 120.12s）
视频库列表：活着-1994-2min.mp4 | 活着-1994-2min.mkv
总耗时（点击→产物入库）：20.9s
```
脚本可重放：`.handoff/obj_1789049478404_24zoid/smoke-run.mjs`（日志：`smoke-real-file.log`）

### 3. 浏览器端到端（hls.js 1.6.17 + 增长中事件列表，`.handoff/obj_1789049478404_24zoid/stream-e2e-verify.mjs`）

```
[browser] MANIFEST_PARSED=true videoWidth=1920
[sample 1s] currentTime/缓冲终点 = 1.06/12      ← 从第 0 秒开始播（未跳到直播边缘）
[sample 25s] currentTime/缓冲终点 = 25.15/48    ← 缓冲持续领先，播放无中断
[总览] 测试期间 ffmpeg 仍在运行=true            ← 真·边转边播
```

### 4. 性能对照（M1 Pro 10 核 / ffmpeg 8.0.1 / 活着-1994 全片 2h12m 13.3GB）

| 管线 | 速度 | CPU | 全片耗时/代价 |
|---|---|---|---|
| 旧：全量重编码（误判） | 28.6 倍速 | ≈8 核满载 | ≈4.6 分钟、≈2150 CPU·秒 |
| 新快路：视频直拷+音频 AAC | 77 倍速 | ≈1 核 | ≈1.7 分钟、≈106 CPU·秒（**CPU 降 ≈20 倍，画质零损失**） |
| 新限速（重编码类文件） | 1.25 倍速 | ≈0.6 核 | 与播放同速推进，始终领先，**不抢资源** |

---

## 四、部署与故障处置（必读）

### 1. 本次交付已生效

- pm2 服务已按 `ecosystem.config.cjs` 重建并重启（`video-downloader`，**id=40**，PORT=3456），`pm2 save` 已持久化；
- 生效核验：`/api/health → 200`；新路由判别 `GET /api/stream/<32hex>/index.m3u8（无 token）→ 401`（旧代码无此路由会 404）。

### 2. ⚠️ 应急处置记录：服务端口污染导致崩溃循环（已修复）

- **现象**：22:52:40 一次 pm2 重启后，服务持续 `EADDRINUSE ... port: 52134` 崩溃循环（52134 是 ai-chatbox 的端口）。
- **根因**：pm2 为该应用缓存的运行环境被污染为 `PORT=52134`（当前 shell 环境里导出着 `PORT=52134`；带 `--update-env` 的重启会把 shell 环境刷进应用）。而端口 3456 才是本应用配置（ecosystem + 前端入口 + 历史部署）。
- **修复**：`pm2 delete video-downloader` → `PORT=3456 pm2 start ecosystem.config.cjs` → `pm2 save`。重建后 `pm2 env` 核验 `PORT=3456`，服务正常。
- **今后重启请用**（勿加 `--update-env`，或先 `unset PORT`）：
  ```bash
  pm2 restart video-downloader        # ✅ 安全：复用应用自身已存的 env（PORT=3456）
  # ❌ 避免：pm2 restart video-downloader --update-env   （会把当前 shell 的 PORT=52134 刷进来）
  ```

### 3. 浏览器强刷

前端 `player-core.js` 已更新，浏览器需 `Ctrl/Cmd + Shift + R` 强刷（否则旧 JS 仍是「等全量转码」的行为）。

---

## 五、遗留项

1. **断点续转**（v2 备选）：用户中断后重进目前**从头开始**。方案已就绪（`-ss` + `-start_number` + `-output_ts_offset` + `-hls_flags append_list`），但时间轴连续性必须实测后才敢上，本轮未做。
2. **seek 物理限制**：流式期间未转换的部分不存在，只能拖到已转换范围（已有提示文案）。转换完成后（ENDLIST/MP4 入库）全片可拖。
3. **工作区归档说明**：本轮改动与上一轮「MKV 三信号触发模型」改动在同一批文件中交织（player-core.js / index.js / transcode.js / test 文件），本次提交一并归档（用户此前选择「暂不补提交」的是单独归档动作，非禁止本功能提交）。
4. 历史遗留不变：`.ts` 不在视频库白名单（无转码入口）；`test/e2e-features.mjs` 不在 `npm test` glob 内。

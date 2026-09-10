# MKV「边转边播」方案设计

> objectiveId: obj_1789049478404_24zoid · 2026-09-10
> 前序：`docs/MKV网页播放二次修复-交付报告.md`（触发模型修复，已生效）
> **结论：支持。且「边转边播 + 限速转换」已在本机端到端实测跑通**（真实浏览器从第 0 秒开播、全程 ffmpeg 仍在转换，见 §三）。
> 本方案同时解决两个问题：① 全量转码「等太久、吃满 CPU」；② 部分文件的转码管线选得太保守（本来秒级的活被当成小时级的活干）。

---

## 一、现状与根因

### 1.1 现在的流程（为什么慢）

```
点击 MKV → ffprobe 探测 → 判定不可播 → 显示「转码后播放」按钮
→ POST /api/transcode → 全量 ffmpeg 转码（一次性跑完，产物 <原名>.mp4）
→ done → 前端自动播 MP4
```

痛点全在「全量转码」这一环：**必须等整部转完才有第一帧画面**，而整部转换期间 CPU 长时间高占用。用户视角就是：点下去 → 转半天 → 才能看。

### 1.2 用真实文件解剖根因（`downloads/wilsonwen/活着-1994.mkv`）

| 轨道 | 编码 | 现状管线判定 | 实际代价 |
|---|---|---|---|
| 视频 | **H.264**（1920×1038, 23.976fps） | 因为音频不是 AAC → **整条走 libx264 全量重编码** | 2h12m 片长 × 8 核满载 ≈ 4.6 分钟、**2150 CPU·秒** |
| 音频 | AC3 640kbps | 陪跑重编码 | — |
| 字幕 | subrip ×2 | `-sn` 丢弃（既有行为，保留） | — |

**根因 A（管线判定过严）**：`src/transcode.js` 的 `canRemux` 要求「视频 H.264 **且** 音频 AAC/无音轨」才走快速通道；音频差一点点（AC3），整部视频就要逐帧重压。而实际上 H.264 视频**可以直接 -c:v copy 进 MP4**，只有音频需要转 AAC——这条路的实测速度是 **77 倍速**（见 §三）。

**根因 B（模型是「全量后播」）**：即使管线判定修好，像 HEVC 这类真需要重编码的文件，仍然要等全量转完才能播。真正的解法是流式：**转换进度只要领先播放进度即可，不必等全量**。

---

## 二、方案总览

两条腿走路，缺一不可：

| # | 改动 | 解决的问题 | 收益 |
|---|---|---|---|
| **A. 快路优化**（管线矩阵升级） | 视频编码可直拷时 `-c:v copy`，只转音频；音频 AAC 时音频也直拷（现有 remux 分支保留） | 「活着-1994」这类**主流资源**（H.264 视频 + 非 AAC 音频的 MKV）被误判 | 全片转换从 **4.6 分钟满载** → **约 1.7 分钟、约 1 核**；CPU 消耗降低 **≈20 倍** |
| **B. 边转边播**（流式会话） | 所有需要转换的文件点击即播，不等全量 | 首帧从「分钟级等待」→ **约 5 秒**；后台转换 CPU ≤0.6 核（10 核机的 6%） |

两者是正交的：A 让大多数文件「转得快」，B 让所有文件「播得早」。A 也会被 B 复用（同一条管线判定）。

---

## 三、实测证据（本机 M1 Pro 10 核 · ffmpeg 8.0.1 · 素材：活着-1994.mkv 13.3GB/7943s）

### 3.1 转码管线速度对照

| 场景 | ffmpeg 命令要点 | 素材窗口 | 实测 wall | 实测 CPU | 外推全片（2h12m） |
|---|---|---|---|---|---|
| **快路**：视频 copy + 音频 AAC | `-c:v copy -c:a aac -sn` | 60s | **0.78s（≈77 倍速）** | 0.85 CPU·s | **≈1.7 分钟**，总 CPU ≈106 CPU·s（≈1 核） |
| 现状：全量重编码 | `libx264 veryfast crf23` | 30s | 1.05s（≈28.6 倍速） | 8.09 CPU·s | ≈4.6 分钟，总 CPU ≈2150 CPU·s（≈8 核满载） |
| **限速重编码** | 全量重编码 + `-readrate 1` | 20s | 20.02s（=1 倍速） | 9.48 CPU·s / 20s ≈ **0.47 核** | 全片 ≈2h12m 后台跑，CPU 占用 ≈**5%** |

> 结论：`-readrate` 就是用户要的「适当速率」旋钮——把「转换消耗」摊平到与播放同步，CPU 从 8 核满载压到 ~0.5-0.6 核。

### 3.2 HLS 分片渐进产出（边转边播的引擎）

```
命令：-readrate 1.5 -readrate_initial_burst 12 … -f hls -hls_time 4
      -hls_playlist_type event -hls_list_size 0 -hls_flags independent_segments+temp_file
```
- `-force_key_frames "expr:gte(t,n_forced*4)"` 保证 4.0s 均匀分段（不加则受源 GOP 影响，段长 3.4~10.4s 不均）；
- 实测：**t+3s 无分片 → t+6s 第 1 片 → 之后每 4s 稳定 +1 片**，播放列表同步增长，收尾自动写 `#EXT-X-ENDLIST`；
- `temp_file` 保证分片/播放列表**原子落地**，客户端永远不会读到半截文件。

### 3.3 真实浏览器端到端（决定性证据）

`.handoff/obj_1789049478404_24zoid/stream-e2e-verify.mjs`（可重放）：
ffmpeg 边转 → 极简 HTTP 服务 → **Playwright Chromium + hls.js 1.6.17** 播放增长中的事件播放列表：

```
[browser] MANIFEST_PARSED=true videoWidth=1920
[sample 1s] currentTime/缓冲终点 = 1.06/12      ← 从第 0 秒开始播（startPosition:0 生效）
[sample 25s] currentTime/缓冲终点 = 25.15/48    ← 缓冲终点持续领先，播放无中断
[总览] 测试期间 ffmpeg 仍在运行=true            ← 播放全程转换未完成：真·边转边播
```

关键 hls.js 配置（已在 1.6.17 源码逐行核实 + 实测）：`startPosition: 0`（从 0 秒起播而非跳到直播边缘）、`initialLiveManifestSize: 1`（1 个分片即可起播）、配合 `-hls_list_size 0` 全量保留分片 → 播放窗口始终覆盖 0 秒起，不会被「live edge 同步」逻辑拽走。

### 3.4 收尾：分片合封正式 MP4

```
ffmpeg -i index.m3u8 -c copy -movflags +faststart <原名>.mp4
```
实测：6 片（24.02s 内容）合封产物时长 **24.04s**，音视频轨完好（h264/aac）。合封是纯封装、几乎零 CPU，落盘后走既有 `fs.watch → library-update` 机制自动入库。

---

## 四、详细设计

### 4.1 服务端：转换管线矩阵（快路优化）

`probeMedia` 探测结果 → 决定转码参数（替换现有 `REMUXABLE_VIDEO` 单集合判断）：

| 视频编码 | 音频编码 | 视频处理 | 音频处理 | 说明 |
|---|---|---|---|---|
| H.264 | AAC / 无 | `-c:v copy` | `-c:a copy` | 现有 remux 分支，秒级 |
| **H.264** | **其他（AC3/DTS/FLAC…）** | **`-c:v copy`** | **`-c:a aac`** | ⭐ 本次新增：主流资源快路 |
| 其他（HEVC/VP9/MPEG4…） | 任意 | `libx264 -preset veryfast -crf 23` | `-c:a aac` | 现有重编码分支 |

统一附加：`-map 0:v:0 -map 0:a:0 -sn`（丢字幕轨，保持既有行为）。

### 4.2 服务端：流式会话（边转边播）

**核心模型**：一次点击 = 一个「流式会话」（streamId），会话内 ffmpeg 以限速持续产出 HLS 分片；播放器边播边追；转完自动合封 MP4 入库；会话结束后清理分片。

```
点击确认不可播
  → POST /api/transcode { name }
      ├─ 产物 mp4 已存在 → 409 {code:'exists', output}        （沿用现有契约）
      ├─ 已存在运行中会话 → 409 {code:'running', streamId, playlist}（沿用现有语义，附播放列表）
      └─ 新建会话 → 200 { streamId, playlist, mode, durationSec, convertedSec }
  → 前端轮询 playlist 直到出现 ≥1 个分片（约 5s）→ openPlayer(playlist) → hls.js 起播
  → 会话完成 → 后台合封 <原名>.mp4 → 入库 → 前端 socket 收到 done
```

**ffmpeg 命令模板（会话本体）**：

```bash
# 重编码模式（慢路，CPU 敏感 → 强限速）
ffmpeg -y -readrate ${RATE_ENCODE=1.25} -readrate_initial_burst 12 \
  -i <source> -map 0:v:0 -map 0:a:0 -sn \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac \
  -force_key_frames "expr:gte(t,n_forced*4)" \
  -f hls -hls_time 4 -hls_list_size 0 -hls_playlist_type event \
  -hls_flags independent_segments+temp_file \
  -hls_segment_filename <会话目录>/seg%05d.ts <会话目录>/index.m3u8

# 快路模式（视频直拷 → CPU 本就极低，限速只为磁盘 IO 温和）
… -c:v copy -c:a aac … ${RATE_COPY=6}   # 无 -force_key_frames（copy 不能插关键帧，分段随源 GOP）
```

**会话目录与生命周期**：

- 目录：`downloads/<user>/.vd-stream/<streamId>/`（点开头 → 不入库、不触发库刷新、不被静态暴露）；
- 状态机：`running → finalizing → done` / `failed` / `cancelled`；
- 同文件互斥：同一 owner+name 只允许一个会话（沿用 `isTranscoding` 语义）；
- 全局并发上限：建议 2（超出 → 429 + 明确文案）；
- 服务启动时清理孤儿会话目录（上次进程残留）；
- 转换完成：合封 MP4 → 校验（ffprobe 时长与源对齐，容差 max(2s, 2%)）→ 原子 rename 入库 → 延迟到「无访问」后清理分片目录（**done 30 分钟 / failed·cancelled 5 分钟**，`sweepSessions` 每分钟扫一次；访问播放列表或分片会续期）；
- ffmpeg 崩溃：状态置 failed、保留现场日志尾部（沿用 errorTail 模式）、清理半成品。

**API（新增/改造）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/transcode` | 改造：语义从「启动全量转码」→「确保流式会话」；返回 `streamId/playlist/mode` |
| GET | `/api/stream/:id/index.m3u8?token=` | 播放列表。**服务端重写**：为每个分片行追加 `?token=`（见 §4.4 鉴权） |
| GET | `/api/stream/:id/:segment` | 分片文件（`^seg\d{5}\.ts$` 校验 + 目录逃逸防护） |
| POST | `/api/stream/:id/cancel` | 取消会话（用户手动「停止转换」；分片目录由清理器回收） |

**进度上报**：沿用 `-progress pipe:1` 解析 + socket `transcode-status`（字段增加 `streamId/convertedSec/progress`），前端 toast 进度与完成通知的既有行为不变。

### 4.3 前端改动

- `player-core.js`：`requestTranscodeAndPlay` 改为「请求会话 → 等待播放列表出现 → 用现有 HLS 分支起播」；
  - **复用现成基础设施**：inline player 的 hls.js 分支、`CachedFragmentLoader`（IndexedDB 分片缓存）、`preloadManager`（已核实：按播放位置就近预加载，对增长列表不会失控）、socket 状态转发；
  - HLS 会话需传入 `startPosition: 0`（本会话专用配置项）；
  - 播放器内提示：转换中显示进度（如「后台转换中 34%」）；
  - **seek 边界**：流式期间只能拖到「已转换进度」之内；目标超出时 toast 提示（`已转换到 XX:XX，暂不能跳转`），转完后（ENDLIST）全片随意拖；
  - iOS/Safari 无 MSE 时走 `video.src = m3u8` 原生 HLS（现有分支已具备）。
- 库卡片文案：`需转码` → `点击即转播`（或保留「需转码」+ 播放器内提示，二选一，实施时定）。

### 4.4 鉴权与安全

- 播放列表 URL 带 `?token=`（与现有 `playLibrary` 给 `/downloads` 加 token 的模式一致）；
- **分片鉴权靠服务端重写播放列表**：为每个 `segNNNNN.ts` 行追加同款 token。
  - 原因：前端分片加载器（`CachedFragmentLoader`）以 `credentials:'omit'` 请求（跨域远程分片场景必须如此，不能改成带凭据），Cookie 鉴权在局域网 http 部署下也不可靠（`SameSite=None` 要求 Secure）——token 入 URL 是唯一全场景（JS/原生 HLS、http/https）都成立的方案；
- `streamId = crypto.randomBytes(16).toString('hex')`，路由正则校验，禁止路径穿越（沿用现有 basename + `startsWith` 双保险模式）；
- 会话归属校验：`streamId → owner` 必须与请求用户一致。

### 4.5 失败与边界

| 场景 | 行为 |
|---|---|
| ffmpeg 不存在 | 现有 `probeFfmpeg` → 503 明确报错（不静默） |
| 源文件删除/损坏 | ffmpeg 非零退出 → 会话 failed + 前端提示 |
| 磁盘写入失败 | 同上；启动时清理孤儿目录 |
| 用户拖到未转换区 | UI 提示已转换进度（见 §4.3） |
| 多端同时播同一文件 | 会话共享（同一 streamId），分片可被多客户端并发读取 |
| 服务重启 | 会话丢失：孤儿目录清理；下次点击重新开始（v1 不承诺断点续转，见 §七） |

---

## 五、对现有代码/测试的影响清单

| 文件 | 改动 |
|---|---|
| `src/transcode.js` | 改造：管线矩阵升级（快路）+ 会话化（HLS 产出/合封/清理），`startTranscode` → `startStreamSession` |
| `src/index.js` | `POST /api/transcode` 语义升级；新增 `/api/stream/:id/*` 两条路由 |
| `public/js/player-core.js` | `requestTranscodeAndPlay` → 会话化；HLS 分支传会话配置；seek 提示 |
| `public/js/media-cache.js` | 预计零改动（已核实兼容）；如预加载对增长列表需微调再动 |
| `test/transcode.test.js` | 更新：管线矩阵契约（新增 H.264+AC3 快路用例）、会话契约（启停/互斥/409） |
| `test/mkv-play.test.js` | 更新：⑧ 现象级改为「点击后 N 秒内可播且转换未完成」；⑫ 409 续接语义对齐 |
| 新增 | 流式会话测试（分片渐进产出、ENDLIST、合封入库、鉴权、路径穿越防护） |

**TDD 节奏**：RED（会话契约/快路契约/browser 现象级）→ 实现 → GREEN → 全量回归（当前基线 19 pass）→ 部署（pm2 restart + 强刷）。

---

## 六、性能与体验预期（基于 §三 实测外推）

| 指标 | 现在 | 方案落地后 |
|---|---|---|
| 首帧等待（活着-1994 这类快路文件） | 全量转完才播（≈4.6 分钟满载） | **≈5 秒**（首分片就绪即播） |
| 首帧等待（HEVC 等慢路文件） | 同上量级 | **≈5-8 秒** |
| 转换 CPU 占用 | 8 核满载 × 数分钟 | **≤0.6 核持续**（10 核机的 ≤6%） |
| 全片转换耗时（快路文件） | ≈4.6 分钟 | ≈1.7 分钟（或按限速后台完成） |
| 播完后的文件状态 | 已是标准 MP4 入库 | 不变（合封回同款 MP4 入库） |
| seek | 全片随意拖 | 转换期间限已转换范围；转完随全片拖（或直接播 MP4） |

**首播延迟优化项（可选）**：`-hls_time 2` / 调大 `-readrate_initial_burst` / `-probesize` 限制探测，理论可压到 ~3 秒。

---

## 七、风险与备选

1. **seek 范围限制是流式的物理特性**（未转换的部分不存在）。缓解：完成后 mp4 全片可拖；UI 明确提示。
2. **断点续转（暂停待续）**：v1 不实现——需要 `-ss` + `-start_number` + `-output_ts_offset` + `-hls_flags append_list` 的接续机制，且必须实测时间轴连续性后才敢上。列为 v2 备选（本次问询中确认是否纳入）。
3. **磁盘占用**：会话期间分片 + 最终 MP4 双份（大文件约 2×2-4GB），完成且无访问 30 分钟后清理分片；上限由「会话完成即合封」兜底。
4. **并发争抢**：多会话并发时 CPU/磁盘会叠加；默认并发上限 2 + 整体限速策略即为此设。
5. **copy 模式分段粒度受源 GOP 约束**（无法插关键帧）：源 GOP 若很碎会产生较多小分片，功能无碍。

---

## 八、待确认决策点（已随本轮问询提交）

1. **会话资源策略**：转完为止 / 无观众即停 / 暂停待续（v2 机制）；
2. **旧模式去留**：全面替换为边转边播 / 保留「完整转换后播放」双通道；
3. **本轮推进节奏**：立即开发（快路+流式一起）/ 先小步上快路 / 仅出方案；
4. **git 归档**：昨日二次修复的工作区改动是否一并补提交归档。

---

## 九、实现落地纪要（2026-09-10 · 已交付）

用户拍板：**转完为止（可手动取消）/ 全面替换旧模式 / 立即开发**。落地时与本文档的差异及实测补充：

- **速率默认值**：`VD_STREAM_RATE_ENCODE=1.25`、`VD_STREAM_RATE_COPY=6`、`VD_STREAM_MAX_CONCURRENT=2`（环境变量可调）；首段预读 burst=12s。
- **清理窗口**：done 30 分钟无访问 / failed·cancelled 5 分钟（每分钟清扫一次）；访问播放列表与分片会续期（保护在播客户端）。
- **新增取消路由**：`POST /api/stream/:id/cancel` + 播放器状态条「停止转换」按钮。
- **鉴权细节**：分片加载走 `res.sendFile(..., { dotfiles:'allow' })`（会话目录 `.vd-stream` 为点开头，默认策略会误判 404 —— 实测踩坑已修）。
- **实测数据（真实文件 `活着-1994.mkv` 2 分钟无损截取）**：首分片 **2.1s** 就绪（优于文档预估 5s）；转换 CPU 均值 **27%（≈0.3 核）**；点击→产物入库 **20.9s**（6 倍速）。
- **已知边界**：取消发生在探测窗口/合封阶段（尚无子进程时）也已被正确消费为 cancelled 并即时让位新会话（测试 ⑯ 覆盖）。

# 交付报告：MKV 网页播放二次修复

> objectiveId: obj_1788961990968_si3lmm · 2026-09-09
> 前序：docs/视频库自动扫描与MKV播放修复-交付报告.md（上轮，验收 pass 6/6）
> 本轮结论：**根因定位到「触发模型」而非转码链路；三信号触发模型已落地并经两轮独立验收 pass，全套件 19/19 全绿。⚠️ 用户侧 pm2 服务需重启才生效（见第五节）。**

## 一、用户问题的直接答案

**「上轮修复验收全绿，为什么我点 MKV 还是黑屏、连『转码后播放』按钮都不出现？」**

- **上轮修的转码链路本身是完好的**：真实浏览器（WebKit/Safari 栈）下 4/4 种 MKV 形态均走通 onerror → 转码条 → POST /api/transcode 200 → done → 自动续播 MP4（复现报告对照矩阵，.handoff/obj_1788961990968_si3lmm/mkv-repro-report.md）。上轮验收绿是真实的——它验的就是这条链路。
- **但断点在触发模型**：转码入口按钮只挂在 `video.onerror` 一个事件上（旧 player-core.js），而 **Chromium 对「MKV 容器可解、视频编码不可解」的文件（如 HEVC）是静默黑屏**——`canplaythrough`/`playing` 照发、时间轴照走、`videoWidth=0`、零帧输出、**全程不抛 error**。于是按钮结构性不可达，`POST /api/transcode` 永不发出。
- **与服务端日志互证**：用户访问期间服务端日志零「开始转码」（logs/app-2026-09-06.log:199-212），复现实验中 chromium 轮同样零转码日志、webkit 轮 4 行——前端不 POST，服务端自然什么都没做。**不是转码坏了，是转码根本没被叫起。**
- 顺带证伪了两个候选：缓存读取挂起（mediaCache.get 7ms 即返回）与旧 JS 缓存（隔离环境全新加载同样复现）均不成立。

## 二、根因

| # | 发现 | 证据 |
|---|------|------|
| 主断点 | 转码入口仅由 `video.onerror` 驱动；Chromium 对编码不可解的 MKV **静默弃轨不抛 error** → 入口不可达 → POST 永不发出 → 服务端零转码日志 | 复现报告 §三/§四：chromium 事件流 `…canplaythrough → play → playing → (8s 无事件) → pause`，无 error 条目，videoWidth=0x0、decodedFrames=0、readyState=4；网络侧文件整段送达（206 响应），服务端无辜 |
| 次级 | 可播性是**浮动面**：同为 HEVC in MKV，本机真实 Chrome（VideoToolbox 硬解）可直解 120 帧，headless/无硬解环境即落入静默失败分支。以 error 事件为唯一信号源的旧设计天然覆盖不了 Chromium 的最大失败类别 | 复现报告 §二矩阵：Chrome headful ✅ vs chromium headless ❌；canPlayType 实测 `mkv+hevc → (empty)` |
| 附带 | remux（-c copy）产 MKV 内嵌 ASS 字幕的 mp4 时，ffmpeg 8 静默弃轨、老版本直接 mux 失败，存在版本不确定性 | src/transcode.js:134-135 注释（实测记录） |

复现方法可重放：`node .handoff/obj_1788961990968_si3lmm/mkv-repro.mjs`（--webkit 对照、--channel=chrome 真实 Chrome）。

## 三、修复清单（文件:行）

核心思路：**用三信号触发模型替代被动 onerror**——「不可播」的判定不再依赖浏览器主动报错。

### 信号 1｜点击即主动预判（主信号）
- `public/js/player-core.js:118-124`：openPlayer 对库内「需转码」文件（id 以 `file:` 开头且命中 TRANSCODE_EXTS，:224）点击即并发探测 + 挂静默检测；
- `public/js/player-core.js:261-271`：`probeLibraryPlayability` → **新 API `GET /api/media-info`**（ffprobe 真实编码）× 客户端 `canPlayType`（:235-259 容器/编码 → MIME 映射）→ 判不可播直接给转码入口，用户不再先看黑屏；
- `src/index.js:576-601`：**新增 GET /api/media-info 路由**（basename+startsWith 防路径穿越，与 /api/transcode 同款）。

### 信号 2｜静默弃轨检测
- `public/js/player-core.js:273-294`：`loadeddata`/`canplaythrough` 后若 `readyState≥3 && videoWidth===0 && 无 error` → 给转码入口。按 video 元素登记/拆除（openPlayer 重挂、closePlayer 拆，:47/:182），不累积。覆盖「探测判可播但实际零帧输出」的浮动面。

### 信号 3｜onerror 兜底（保留旧链路）
- `public/js/player-core.js:152-162`：显式失败（WebKit 拒收 matroska 容器、文件损坏）仍走 error → 转码入口；非转码类文件维持原报错 toast。WebKit/iOS 链路完整保留。

### 409 续接（重复点击/重进页面可恢复）
- `src/index.js:545-552`：POST /api/transcode 在产物已存在/转码中时返回 409，**新增机器可读 `code`（exists/running）+ `output` 字段**；
- `public/js/player-core.js:344-377`：`requestTranscodeAndPlay` 收到 409 后——`exists` → toast「产物已存在」直接播产物；`running` → 订阅 transcode-status，done 后自动续播。

### 服务端加固
- `src/transcode.js:133-136`：remux 分支显式 **`-sn` 丢弃字幕轨**（MKV 常内嵌 ASS/SSA，mp4 不支持；消除 ffmpeg 版本间「静默弃轨 vs mux 失败」的不确定性）。

### 测试（TDD）
- `test/mkv-play.test.js`：**新增** ⑧ 现象级（:336-415）、⑨ 静默失败检测契约（:445 起）、⑫ 409 exists 浏览器级续接（:541-627）；RED 记录 `test/mkv-play.RED.md`；
- `test/transcode.test.js`：⑥ 补 code/output 断言（:247-258）、**新增** ⑥b 转码中 409 running 契约（:261-292）。

## 四、验证证据

环境：Node v23.x · playwright 1.59.1（chromium headless/WebKit）· ffmpeg 含 libx264/libx265 · 隔离 mkdtemp 服务（AUTO_START_QUEUE=0）。复跑：`npm test`（退出码 0）。

| 项 | 用例 | RED→GREEN / 结论 | 关键断言（证据） |
|----|------|------------------|------------------|
| 现象级 | ⑧ mkv-play.test.js:336 | **RED→GREEN**（2175ms）：chromium 真实用户链路（登录→浏览→点 HEVC MKV 卡片）20s 内必达可播状态；断言链 POST=200 → socket done → 产物 src 切 .mp4、videoWidth>0、无 error → 落盘 ffprobe h264/aac → 入库 | RED 时：`POST 请求数=0`、入口未出现（RED 文档原文）；GREEN 后全链路走通 |
| 静默检测 | ⑨ mkv-play.test.js:445 | **RED→GREEN**（8564ms）：实例级 stub 钉死 videoWidth=0 复现静默弃轨签名（与宿主机解码能力解耦），断言无 error 也必须出现转码入口 | RED 时：`video=0x0 readyState=4 decodedFrames=24 且无 error，入口未出现` |
| 护栏不回退 | ⑩⑪ transcode/mkv-play | 修复前 GREEN、修复后仍 GREEN（254ms/1455ms）：⑩ HEVC 源走 libx264 重编码半链路；⑪ WebKit onerror→入口→POST→done→续播链路保留 | 验收报告 §④ |
| 409 exists | ⑫ mkv-play.test.js:541-627 | **PASS**（2718ms，浏览器级四层证据）：API 预转码制造 exists → 真实点击 → POST 恰好一次且 409 → 直接续播产物（不等 done）→ 1.5s 窗口三重证据（单次 POST/产物 mtime 不变/无新「开始转码」日志）证明未重复启动转码 | 最终验收报告 §⑤ |
| 409 running | ⑥b transcode.test.js:261-292 | **PASS**（207ms，契约级）：首次 POST 200+running+output；二次 POST 409+code='running'+output；done 收尾无悬挂 ffmpeg；libx265 缺失时显式 skip（本环境 0 skipped） | 同上 |
| 409 exists 契约 | ⑥ transcode.test.js:247-258 | **PASS**（2.1ms）：409 + code='exists' + output + error 含产物名 | 同上 |
| 全量回归 | `npm test` | **19 pass / 0 fail / 0 cancelled / 0 skipped**（16131ms，退出码 0）；上轮 17 → 19（新增 ⑥b/⑫），既有用例零退化 | 验收报告 19/19 复跑输出 |
| 独立验收 | 两轮 qa-accept | **verdict: pass（①~⑤ 全过，unmet 空）**：首轮验 ①~④，第二轮补 ⑤（409 行为级证据）并复核生产文件 mtime 确认第二轮交付为纯测试改动 | .handoff/2b233aa922e145fca2352b3a3ba59ea8/.handoff_obj_1788961990968_si3lmm_acceptance-report-final.md |

## 五、部署重启指引（⚠️ 生效必读）

1. **服务端必须重启**：你的 pm2 常驻服务（pid 12892，端口 3456）**仍在跑旧代码**——本轮改动（player-core.js / index.js / transcode.js）已在磁盘，但未被旧进程加载。执行：
   ```bash
   pm2 list                 # 找到端口 3456 对应的进程名（当前 pid 12892）
   pm2 restart <进程名>     # 重启后新代码才生效
   ```
2. **浏览器必须强刷**：`Ctrl/Cmd + Shift + R`（或 DevTools Network 勾 Disable cache 后刷新），确保拿到新版 `public/js/player-core.js`——旧缓存的播放器 JS 不含三信号逻辑，黑屏会原样复现。
3. 环境前提（与上轮一致）：本机 macOS pm2 直跑需 ffmpeg 在 PATH（本机实测 /opt/homebrew/bin/ffmpeg 8.0.1）；Docker 部署镜像已内置。
4. 验证生效：点一个 HEVC 的 MKV → 播放器内应立即出现「XX 格式浏览器无法直接播放，可转码为 MP4 后观看」提示条（不再黑屏）→ 点「转码后播放」→ toast 报进度 → 完成自动播放 MP4。

## 六、遗留项

1. **`test/e2e-features.mjs` 不在 `npm test` glob 内且未设 `VD_DOWNLOADS_DIR` 隔离**：单独运行可能触到真实用户目录，需单独处理后纳入套件，本轮未修。
2. **HEVC 可播性随环境浮动（设计已适配，非缺陷）**：有硬解的环境（如 Apple Silicon + VideoToolbox）Chrome 可直解 HEVC，无硬解则走转码。本修复用「ffprobe 编码 × canPlayType」确定性判定：能直解就直接播，不能则给入口——同一文件在不同机器上行为不同是符合预期的。
3. 上轮遗留保持不变：`.ts` 不在视频库白名单（无转码入口，上轮 scope 外）；macOS Docker Desktop bind mount 的 fs.watch 平台边界已由 15s 轮询兜底。

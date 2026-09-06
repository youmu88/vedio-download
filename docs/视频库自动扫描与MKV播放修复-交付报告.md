# 交付报告：视频库自动扫描识别 + MKV 播放修复

> objectiveId: obj_1788701854278_asw23u · 2026-09-06
> 验收结论：**pass（6/6 达成，含 4 条现象级实证）** · 全量回归 **13/13 全绿**（tests 13 / pass 13 / fail 0 / skipped 0）

## 一、用户问题的直接答案

**「把本地视频拷贝到 downloads/xxx账号 下，视频库能自动扫描识别并出现在列表吗？」**

- **改造前**：能识别、但不自动——`GET /api/library` 每次请求实时扫描目录，刷新页面即可见；但库刷新只由前端手动触发，socket 事件（含下载完成）不会触发刷新，不刷新页面新文件不会出现。
- **改造后**：服务端 fs.watch 递归监听 downloads 根 → 防抖 → 按目录首段 owner 定向推送 `library-update` → 双端订阅自动刷新列表；针对 macOS Docker Desktop bind mount 下宿主拷入不触发容器内事件的平台边界，保留 **visibilitychange + 15s 轮询兜底**——拷入文件最迟 15 秒自动出现，无需手动刷新。

**「.mkv 能识别但无法播放，是格式问题吗？」——是。**

- 服务端无辜：播放走 `/downloads` → `express.static`（src/index.js:189-201），MKV 的 MIME 与 Range 均正常；
- 前端无辜地直塞 `video.src`（player-core.js 原 104-116 行），失败无提示；
- 根因是 **MKV 容器的浏览器支持面窄**：Safari/iOS WebKit 完全不支持 MKV 容器（本项目含 iOS 端）；Chrome 仅支持 H.264/AAC 等部分编码组合。
- 修复：服务端按需转码管线（Dockerfile 已内置 ffmpeg/ffprobe）——ffprobe 探测编码，H.264/AAC 直接 **remux（`-c copy`，秒级无损）**，否则 **libx264+aac 转码**（-preset veryfast -crf 23）；产物 `<原名>.mp4` 落用户目录自动入库。

## 二、改动清单（文件:行 级）

| 文件 | 改动 |
|------|------|
| src/index.js | VD_DOWNLOADS_DIR 环境变量（:54）、扩展名白名单 VIDEO_EXTS（:59，mp4/webm/mkv/mov/m3u8）、运行中任务按 outputFile/outputName 实际输出名过滤（:447-461）、.part.mp4 过滤（:458/:463）、broadcastLibrary（:252）、fs.watch 递归监听+防抖+owner 定向推送（:296-333）、POST /api/transcode（:523-566）、启动 ffmpeg 探测与优雅关闭清理 |
| src/transcode.js | **新模块**：ffprobe 探测 → remux/transcode 分支 → 产物自动入库 → 进度经 user 房间 `transcode-status` 推送 → 失败删半成品 |
| public/js/macos.js | library-update 订阅→loadLibrary、transcode-status 经 window CustomEvent 转发、visibilitychange+15s 轮询兜底、mkv/ts「需转码」徽标 |
| public/js/ios.js | 同上（双端对齐） |
| public/js/player-core.js | video.onerror → 可转码库文件显示提示条 +「转码后播放」按钮 → 提交转码 → done 自动续播 |
| test/library.test.js | **新增** 4 组用例（TDD RED 先行）：白名单 / .part.mp4 / 运行中任务实际输出名 / fs.watch→library-update socket 推送 |
| test/transcode.test.js | **新增**：ffmpeg 探测（有则真实断言、无则 t.skip）——⑤ 真实 MKV→MP4 转码链路（785ms）、⑥ 409 转码互斥、⑦ 路径穿越防护 |

## 三、验收结果（acceptance-report 摘录）

| 标准 | 结论 | 证据 |
|------|------|------|
| C1 拷入即识别 + 自动推送 | ✅ | 隔离环境真实服务下拷入 .mp4 即入 /api/library；socket 收到 `42["library-update",{"owner":"vd_acc_mtpwtlzr"}]`（src/index.js:306-320→252-254） |
| C2 MKV 转码后可播（现象级） | ✅ | 真实 ffmpeg 转码 acc-sample.mkv→acc-sample.mp4 入库；GET 产物 200 + video/mp4；Range 返回 206 bytes 0-99/15140。注记：实际播放路由为 `/downloads/<file>?token=`（src/index.js:196-208 前缀剥离设计，与前端 playLibrary 一致），验收标准中 `/downloads/<user>/<file>` 为描述偏差，非缺陷 |
| C3 白名单/临时文件/运行中任务过滤 | ✅ | .txt/.zip/.srt/.part.mp4 全过滤（:458/:463，VIDEO_EXTS :59）；运行中任务标题命名过滤由用例③实证 |
| C4 无 ffmpeg 明确报错 | ✅ | PATH 隔离实例返回 503 `{"error":"服务端未安装 ffmpeg，无法转码"}`（:524-525），不静默 |
| C5 前端在位断言 | ✅ | 双端订阅/兜底轮询/需转码徽标 + player-core onerror→转码入口→done 自动续播，逐处 文件:行 确认 |
| C6 全量回归 | ✅ | npm test 退出码 0、13/13，测试零残留污染（downloads/ 与 data/ 与基线逐文件一致） |

## 四、使用方式

- **自动刷新**：无需操作。拷入 downloads/<你的账号>/ 后，打开的浏览页最迟 15 秒自动出现该文件（fs.watch 生效环境即时推送）。
- **MKV 播放**：点击 mkv 卡片若浏览器不能播 → 播放器内出现「转码后播放」按钮 → 点击后服务端转码（进度实时推送）→ 完成自动续播。API 等价：`POST /api/transcode {"name":"movie.mkv"}` → `{ok, output:"movie.mp4"}`。
- **注意**：本机（macOS，pm2 直跑）需保证 ffmpeg 在 PATH（本机实测 /opt/homebrew/bin/ffmpeg 8.0.1）；Docker 部署镜像已内置。

## 五、遗留与部署期复核项

1. **白名单不含 .ts**（不可直播且无转码入口，属本轮 scope 外）：存量 .ts 文件将不再出现在 /api/library，需要找回需转 mp4 或后续为 .ts 增加转码入口。
2. **macOS Docker Desktop bind mount**：宿主拷入不触发容器内 fs.watch 事件——已由 visibilitychange+15s 轮询兜底，属平台边界非缺陷。
3. **部署期复核**：Docker 容器内 Node 版本、inotify 上限与 bind mount 事件传播（勘察报告④声明，本机 node v23.10.0 实证通过）。

## 六、委派台账

| 委派 | 角色 | 结果 |
|------|------|------|
| del_mtpuzc1v_hsvl | code-explore | 勘察报告 .handoff/obj_1788701854278_asw23u/library-scan-survey.md |
| del_mtpvaqh1_ontg | test-writer | 4 组 RED 用例（RED 4/4 断言失败实证） |
| del_mtpvup1m_k47r | code-dev | 实现+MKV 修复，6 文件落盘 |
| del_mtpwfqjb_k0xh | test-runner | 13/13 全绿、零污染（.handoff/15549d5d20c248c9a3f673464bee2023/orch_test-runner_4.md） |
| del_mtpwk2s2_oeix | qa-accept | pass 6/6（.handoff/15549d5d20c248c9a3f673464bee2023/acceptance-report.md） |

# test/mkv-play.test.js — RED 运行记录（TDD 验收线）

- 日期：2026-09-09 · 运行者：test-writer
- 命令：`node --test test/mkv-play.test.js`（全套件验证：`node --test test/*.test.js`）
- 环境：Node v23.10.0 · playwright 1.59.1（bundled chromium 147.0.7727.15 / webkit 26.4）· ffmpeg 含 libx264/libx265
- 结果：**⑧⑨ RED（断言不满足，非语法/导入错误）；⑩⑪ 护栏 GREEN**；全套件 17 用例仅 ⑧⑨ 失败，既有 15 条不受影响。两次独立运行失败形态一致（稳定 RED）。
- 未改动 src/ 与 public/（git status 仅新增 test/mkv-play.test.js）。

## 根因断点 → 用例映射（根因报告：.handoff/obj_1788961990968_si3lmm/mkv-repro-report.md）

| 断点 | 用例 | 现状 |
|---|---|---|
| 主断点：转码入口仅由 video.onerror 驱动，Chromium 静默弃轨（不抛 error）→ 入口结构性不可达 → POST 永不发出 | ⑧ 现象级 / ⑨ 检测契约 | RED |
| 次级发现：error 事件不可作为唯一信号源（可播性是浮动面） | ⑨（用 videoWidth 实例级 stub 复现静默签名，与运行环境解码能力解耦） | RED |
| 服务端投影：chromium 轮零「开始转码」日志 | ⑧ 断言失败信息含 `POST /api/transcode 请求数=0` | RED（随 ⑧ 转绿） |
| 服务端半链路（HEVC 源 → 重编码 h264/aac 产物，非 copy） | ⑩ | GREEN（护栏） |
| WebKit/iOS 现有 onerror→入口→POST→done→续播 链路保留 | ⑪ | GREEN（护栏） |

## ⑧ RED 输出（现象级验收线：MKV 点击即获得可播产物）

```
AssertionError: 现象级断点：点击 HEVC in MKV 卡片后 20s 内未到达任何可播状态（黑屏死胡同）。；
video=0x0（0x0=黑屏） decodedFrames=0 readyState=4；
error=null（null=Chromium 静默弃轨：demux 成功但不抛 error）；
转码入口(.transcode-notice)=未出现（player-core.js 转码入口仅由 video.onerror 驱动 → 静默失败形态结构性不可达）；
POST /api/transcode 请求数=0（0=服务端零「开始转码」日志的上游投影）；
事件流=[loadstart → loadedmetadata → loadeddata → canplay → canplaythrough → play → playing → pause → ended]
  at test/mkv-play.test.js:358
```

转绿语义（code-dev 验收线）：chromium(headless) 点击 HEVC in MKV 卡片后 20s 内，
**直解**（videoWidth>0 且 decodedFrames>0）或**转码入口**出现二者必居其一；
若走入口：点击/自动触发 → POST /api/transcode=200 → transcode-status done →
产物 `<原名>.mp4` 落盘 + ffprobe h264/aac/duration>0 + 入库 + 浏览器自动续播（src 切 .mp4、videoWidth>0、无 error）。

## ⑨ RED 输出（静默失败检测契约）

```
AssertionError: 静默失败检测断点：videoWidth=0、readyState>=3 且全程无 error 事件（Chromium 静默弃轨签名），
但未出现转码入口 —— player-core.js 转码入口仅由 video.onerror 驱动，error 事件不可作为唯一信号源。
终态：video=0x0 readyState=4 decodedFrames=24
事件流=[loadstart → loadedmetadata → loadeddata → canplay → canplaythrough → play → playing → pause → ended]
  at test/mkv-play.test.js:445
```

夹具说明：样本为 H.264+AAC MKV（chromium 可直解，夹具自检断言 readyState≥3 且无 error 先行通过），
实例级 stub 把 videoWidth/videoHeight 钉死为 0 —— `decodedFrames=24` 证明播放机制真实运转而
videoWidth 读数为 0、且全程不抛 error，即精确复现根因报告的静默弃轨签名，断言与宿主机解码能力解耦（非 HEVC 专属）。
转绿语义：canplaythrough/loadeddata 后 videoWidth===0（且无 error）必须给出转码入口；点击 MKV 卡片即预判入口的方案同样转绿（观察窗 8s）。

## ⑩⑪ 护栏（现状 GREEN，修复不得使其变红）

- ⑩：POST HEVC MKV → 200 → socket done → 产物 `mkv_hevc_api.mp4` ffprobe=h264/aac/duration>0 → 入库（服务端对 HEVC 源走 libx264 重编码而非 copy）。
- ⑪：webkit 点击 MKV 卡片 → onerror → `.transcode-notice` → 点击 → POST 200 → done → 续播 mp4（videoWidth>0、无 error）。

## 运行耗时参考

单独文件 ≈32s（⑧ 21.7s 内含 20s 现象观察窗；⑨ 8.6s；⑩ 0.25s；⑪ 1.4s）。
无 ffmpeg/libx265/playwright 的环境自动 t.skip（不失败）。

# Windows 播放卡顿与长条接缝验证

以下结果来自 Windows Electron 测试副本，未启动或写入原游戏。原始报告、CPU profile 与截图位于 `out/performance/`；黑缝报告位于 `out/ribbon-pixels-normal.json`。本页区分完整播放器测量与隔离舞台测量，不能把后一项直接当成完整新版帧率。

## 0.1.10 SLC 连续采样

`out/performance/final-0.1.10.json`：相同 Windows 校准谱、8 秒采集，1,249 个帧间隔；平均 6.41 ms，p99 6.50 ms。两帧超过 50 ms，最长 93.9 ms，因此只认为通过现有回归阈值，不宣称无卡顿。声音与定位时钟速度比均约 1.0，renderer 无异常。SLC 控制跨度在换谱时计算，播放中使用缓存跨度。

## 0.1.9 黑色背景与原生字体

`out/performance/final-0.1.9.json`：Windows 实际桌面播放器，1466×923、DPR 1.5、8 秒采集共 1,260 个帧间隔。平均 6.35 ms，p95 / p99 均 6.40 ms；2 帧超过 25 ms，其中 1 帧 75 ms，不能宣称完全无停顿。AudioContext 与播放位置速度比均为 1.0；renderer 无异常。舞台绘制调用为 0，符合黑色背景设置。

RFZ 文字缓存以单字形小图保存，最多 1,024 项；不会为每种文字颜色复制完整 2048 像素图集。长条重叠实际 GPU 像素检查连同其他材质检查共通过 19 项。旧版性能数据保留于下方作为历史对照。

## 可重复反馈

`tests/windows-performance.mjs` 使用 Windows Node 和已有 Windows runtime，自动打开原创 `examples/calibration.chuni.json`，播放预热 1.8 秒后采集 8 秒 rAF 间隔、AudioContext 时钟、播放位置与 Canvas 调用，再记录 3 秒 CPU profile。测试窗为 1466×923、DPR 1.5，播放器 framebuffer 为 2199×1068。

命令参数为 `--runtime=<Windows程序目录> --data=<独立测试数据目录> --label=<报告名> --assert-smooth`。阈值是 p99 不超过 25 毫秒，超过 50 毫秒的帧不多于 2 帧；它是本机回归标准，不是对所有硬件的帧率承诺。`--mode=no-stage-paint` 仅抑制舞台绘制，保留音乐、谱面、相机、动画和 CPU 几何计算。`--renderer=<独立构建index.html>` 可加载测试构建而不覆盖原 runtime。

| 完整播放器场景 | 平均帧间隔 | p95 | p99 | 超过25ms帧数 |
| --- | ---: | ---: | ---: | ---: |
| 0.1.7 原版，第一次 | 11.70ms | 18.9ms | 37.5ms | 16 |
| 0.1.7 原版，重复 | 9.96ms | 18.8ms | 25.1ms | 11 |
| 仅抑制舞台填充 | 6.26ms | 6.4ms | 7.4ms | 0 |
| 完整 0.1.8 发布测试副本 | 6.35ms | 6.3ms | 6.4ms | 2 |

原版每帧提交 3612 次舞台 Canvas 三角形填充。两次原版均触发回归失败，抑制填充后通过。测试期间 AudioContext 与墙钟之比为 1.0000–1.0016；这些数据支持绘制负担为此处卡顿主因，未显示歌曲时钟停走。

诊断先提出了四个可区分的候选原因：舞台三角形填充、逐帧几何分配、音符纹理绘制，以及逐帧 UI 更新。仅禁用舞台填充即可消除当前最小复现的长帧，所以本次舞台修复针对这一已验证原因，未据此声称其它路径没有成本。

## 舞台修复与隔离对比

`ClassicRingRenderer` 将原始不透明环形网格的三角形合并成一次 WebGL 提交，复用顶点缓冲区；姿态、颜色、相机和世界矩阵仍来自原资源及共享投影。透明材质、WebGL 不可用或 context loss 时使用现有 Canvas 后备路径。替换资源时 `dispose()` 释放旧 GPU context。

同一 Windows 应用内，旧舞台与新舞台分别运行相同 8 秒动画区间；该测试将播放器暂停，只比较舞台本身。

| 隔离舞台 | 绘制与复制平均耗时 | p95 | p99 | rAF p99 |
| --- | ---: | ---: | ---: | ---: |
| 旧 Canvas 三角形 | 2.026ms | 2.7ms | 3.1ms | 12.6ms |
| 新 WebGL 批量绘制 | 0.132ms | 0.2ms | 0.4ms | 6.4ms |

这里测量的是 CPU 提交及复制耗时，约减少 15 倍，不能解释为 GPU 运算速度提升 15 倍。两个场景的姿态计算平均耗时约 0.28 / 0.27 毫秒。

`tests/stage-gpu-browser.ts` 在实际 Windows GPU 上通过 10 项检查：深度遮挡、近远裁切、跨近面的三角形、世界平移、编辑预览锚点、context loss 后备用绘制和 dispose 行为。报告为 `stage-gpu-tests.json`。旧、新动画截图仍可有抗锯齿与按像素深度差异，不宣称逐像素一致。

## 音符 GPU 接缝与材质

`tests/windows-ribbon.mjs` 调用实际 `ChartPlayer.texturedQuad`，检查内部三角形接缝和相邻段的连接边界。三个固定场景均通过：

| 场景 | 检查像素 | 暗缝像素 | 重复叠加亮缝像素 |
| --- | ---: | ---: | ---: |
| 不透明透视长条 | 2072 | 0 | 0 |
| 半透明透视长条 | 2072 | 0 | 0 |
| 半透明、透视变宽的相邻两段 | 3799 | 0 | 0 |

`tests/mesh-gpu-browser.ts` 的 17 项真实 WebGL2 检查覆盖：双纹理 MUL_RGB 的 RGB 与 alpha 行为、纹理/无纹理 alpha test 顺序、普通透明混合、border/repeat wrap、三种 cull 模式，以及 context loss、失效后续帧与幂等销毁。该测试验证实现行为，原生语义依据另见材质研究文档；测试本身不是语义来源。

## 完整 0.1.8 验收

最终测试使用完整 0.1.8 Windows runtime、相同校准工程和 8 秒区间，通过上述帧时间阈值。1260 个帧间隔的平均值为 6.35ms，p95 为 6.3ms，p99 为 6.4ms；2 帧超过 25ms，其中 1 帧为 81.1ms，并记录到一次 85ms long task。因此这是持续帧间隔的改善，不能描述为完全消除了长帧。

测量时载入 407 个原始音符模型，每帧特效图元平均 155.85、峰值 728；舞台每帧绘制 3612 个三角形，合为一次 WebGL draw。舞台 Canvas 每帧刷新到音符 GPU 层作为背景，以正确执行原特效的加法混合，这项工作包含在完整测量内。音乐时钟与播放位置相对墙钟的速率均为 1.0000，renderer errors 为空。最终报告为 `out/performance/final-0.1.8.json`，另附同名 CPU profile 与截图。

之后顺序运行完整 `windows-desktop.mjs`，win32 bridge、原曲导入、音频解码、编辑和节点类型、小节定位、动画、XML 与 OPT 导出均通过，生成 8 个导出文件；证据为 `out/windows-test/evidence.json`。最后在同一 0.1.8 runtime 上重跑 `windows-mesh-gpu.mjs`，上述 17 项真实 GPU 检查全部通过。所有窗口使用独立测试 profile，未与其他 GPU 测量并发，也没有写入原游戏目录。

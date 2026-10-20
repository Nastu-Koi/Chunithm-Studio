# 俯视图片

把整张谱面画成一张 PNG，版式仿照 sdvx.in 的谱面页。使用方法见 `README.md`「导出俯视图片」，术语见 `CONTEXT.md`。

## 模块与数据流

| 位置 | 内容 |
| --- | --- |
| `src/core/chart-image.ts` | 版面：`layoutChartImage` 把小节分到列、列分到行，算出每个小节带的像素范围与拍线；`chartImageLocate` / `chartImageSlice` 把 tick 与时间段换成图上坐标；`chartImageLaneX` 把轨道换成横坐标。纯几何。 |
| `src/renderer/chart-image.ts` | 绘制：`renderChartImage(project, 资源副本, {cover})` 先按谱面收集需要的贴图并加载，再画页头、背景、小节线与音符，返回画布和缺少的贴图名；`chartImagePng` 编码 PNG。 |
| `src/renderer/dialogs/export.ts` | 「导出俯视图片」按钮：取封面与 `ctx.gameTextures`，渲染后经 `bridge.saveImage` 保存。 |
| `src/bridge.ts` / `src/backend/main.ts` | `saveImage(defaultName, png)`，通道 `image:save`：保存对话框（PNG 过滤）后写文件；浏览器替身直接下载。 |

## 版面（与 sdvx.in 页面一致的部分）

依据是对 sdvx.in 真实页面图层的测量：

- 列宽 200 像素，内区 98 像素，轨 n 从内区左边 round(n × 98 ÷ 16) 像素处开始；上下各 24 像素边距。
- 一列 16 拍（按页面 BPM 折算），4/4 时 4 个小节；小节在列内自下而上，列自左而右，每行 8 列（`columnsPerRow`），行与行之间上下排布。
- 页面 BPM 取第一个画出的小节处的 BPM。每拍 96 像素（`pixelsPerBeat`）；任一段音乐的像素 = 拍数 × 96 × 页面 BPM ÷ 该段 BPM，按 BPM 事件分段累加（`chartImagePixelsBetween`），所以小节中途变速也成立，一像素对应的音乐长度全图相同。
- 小节号用 `getMeasureLines` 的 0 起编号：第 0 小节是开头的空小节，第 1 小节从 tick 384 起，与 sdvx.in 页面和原生 MEASURE 一致。第 0 小节只有有音符时才画。最后画到最后一个音符结束所在的小节。
- 比 16 拍长的小节单独成列；所有列的高度相同，取 16 拍与最长小节中的较大者再加边距（与 sdvx.in 跨列画法不同，这是有意的简化）。
- 跨列的长条由 `chartImageSlice` 切成每列一段，段内按时间比例插值轨道与宽度；上一列顶边到下一列底边之间没有像素。

## 绘制

- 背景黑色；列边框与小节线灰 85，拍线灰 34，轨道线为 10% 白（每 4 轨 18%）；小节号画在列左侧。小节线画在音符之下，起拍的音符不被切开。
- 音符贴图的选型与播放页相同（`getNativeHeadModel`）：按宽度取 `_NN`，EX 用 `NotesChara`，HOLD／SLIDE 端点用 `_point`，AIR 按方向取 `NotesAirU/D(R)`、按颜色取 `_P/_G`。短音符与端点把贴图整张拉伸到轨道跨度，高度按原网格纵横比（10.09 ÷ 15.68）取在 6–12 像素之间。
- 叠放按原游戏的绘制图层（[native-note-assets.md](../native-note-assets.md)「绘制图层」），与谱面记录顺序无关：先画全部带体（`chartImageBodies`：HOLD、SLIDE、AIR-SLIDE 与 CRUSH 中心线、AIR-HOLD），再画头部、端点、AIR 箭头、动作环与 CRUSH 横档（`chartImageMarks`），同层按时间。因此 SXD 头盖住同处的 TAP，TAP 盖住 SLIDE 头与端点。带体全部压在头部之下是为了看清地面音符，原游戏里 AIR 条带在地面头部之上。
- HOLD／SLIDE 带体贴 `HoldJoint`／`SlideJoint`，贴图顶行在终点、底行在起点；宽度不变时一次仿射变换，变化时逐像素行拉伸（与编辑页 `paintGroundBody` 相同）。SLIDE 链的后续段不再画头，控制节点不画节点条。
- 长条带体（HOLD／SLIDE／AIR-HOLD／AIR-SLIDE 的顶面与中线、AIR-CRUSH 的连线）从所在链的起点起一个 12 分音符（`resolution ÷ 12` tick）内全亮，之后以 40% 不透明度画（`BODY_DIM`）。链起点沿「起点与前一段终点相接」回溯；边界落在一段中间时该段切成亮、暗两块，贴图 V 连续。
- AIR 箭头取 `NotesAirU/D` 贴图上方 36% 的彩色横条，画在父音符上方 2 像素处，高 9 像素；斜向箭头横向偏移。AIR-HOLD／AIR-SLIDE 的头画同样的箭头，动作节点末端画 `NotesAirHold_Ring_NN`。
- AIR-HOLD／AIR-SLIDE 带体：`AirHoldJoint`（按颜色 `_P/_S`）以 55% 不透明度铺满轨道跨度，`AirHoldLine` 沿中心拉伸成 3–6 像素宽的线。高度不影响俯视图。
- AIR-CRUSH：`AirLadderLine` 图集取该颜色对应的一行（`getNativeAirCrushLineV`，NON 不画线）拉成中心线；每个判定间隔处画一个横档，第一个用 `NotesAirLadderTop_NN`，其余 `NotesAirLadder_NN`。
- 页头：封面 100×100（有则画）、曲名、艺术家、难度与等级（WORLD’S END 带属性字）、BPM（范围）、CHAIN（`buildJudgementTimeline().total`）、谱师。
- 贴图经 `Image` 以 `crossOrigin = 'anonymous'` 加载，`chuni-asset://` 协议带 CORS 头，画布不会被污染，`toBlob` 可用。

## 已知限制

- 需要资源副本；缺少的模型名由 `renderChartImage` 返回，对话框在提示里列出。
- 极长的谱面会生成很高的图（每行约 1584 像素）；浏览器画布的尺寸上限约 32767 像素，超过时会失败，目前没有自动缩放。
- 俯视图不表现 AIR 高度、滚速事件与 SLIDE 曲线形状（按直线段画）。

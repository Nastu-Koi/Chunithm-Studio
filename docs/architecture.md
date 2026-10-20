# 系统架构

Chuni Studio 是 Electron 桌面程序：主进程负责文件、游戏资源与导出，渲染进程负责编辑与预览，两者通过一个类型化的桥接接口通信。术语见根目录的 `CONTEXT.md`。

## 模块与职责

| 模块 | 运行位置 | 职责 |
| --- | --- | --- |
| `src/core` | 两个进程共用 | 谱面与工程的数据模型、C2S 读写、时间轴、量化、校验、判定时间表，以及资源清单的类型定义。纯逻辑，不访问文件、DOM 或 Electron。 |
| `src/backend` | 主进程 | 工程文件夹读写、曲库扫描、音频转换、OPT 导出、资源副本的装载与提供。 |
| `src/renderer` | 渲染进程 | 应用壳、俯视编辑器、透视播放器、音频时钟与对话框。 |
| `src/bridge.ts` | 两个进程共用 | `StudioBridge`：渲染进程能向主进程请求的全部操作（含 `saveImage`：把渲染进程画好的 PNG 字节经保存对话框写入磁盘），以及跨进程传递的数据形状；`IPC_CHANNELS`：每个操作的 IPC 通道名。 |
| `native` | 独立子进程 | 音频助手 `ChunithmAudio`（基于 VGAudio）与 FFmpeg，由主进程按需启动。 |
| `scripts` | 开发时 | 构建、打包，把游戏资源转换复制到 `assets/game` 的一次性脚本，以及从 `assets/icon` 的 SVG 生成应用图标的 `build-icon.mjs`。 |

依赖方向：`src/renderer` 和 `src/backend` 都依赖 `src/core`，彼此不直接引用，只通过 `src/bridge.ts` 的类型约定与通道表对接；`src/core` 不依赖另外两者。`scripts` 可以引用 `src/backend` 和 `src/core`。

### `src/core`

- `model.ts`：`Project`、`Chart`、`Note`、`ChartEvent` 等数据结构及其构造函数。音符的原生属性有明确类型 `NoteAttributes`。难度顺序 `DIFFICULTIES` 与音符分类（长条、AIR 系列、需要父音符的 AIR、多段长条、带节点类型、带 AIR 高度、有 EX 变体）的集合也定义在这里，其他模块不再自建同类列表。
- `search.ts`：有序数组的二分查找 `upperBound` / `lowerBound`。
- `c2s.ts`：原生 C2S 文本的解析与序列化。
- `timing.ts`：分段 BPM 时间轴、tick 与秒的换算、小节线与小节号。
- `quantization.ts`：分数 tick 对齐到整数 tick 的分析。
- `validation.ts`：谱面与工程校验，产出错误与提示。
- `judgement.ts`：判定时间表，供计分、打击音和统计使用。
- `editing.ts`：与界面无关的谱面编辑操作，编辑页的谱面变换（移动、镜像、翻转、复制粘贴、节点拆分与删除、AIR 绑定、SLIDE 造型、EX、属性面板的字段规则等）都在这里，每个函数返回新的 `Chart`、不修改输入。属性编辑被拒绝时返回原因码，提示文字由编辑器决定，核心层不含界面文字。
- `xml-metadata.ts`：Music.xml 与 CueFile.xml 的可编辑信息。
- `chart-image.ts`：俯视图片的版面：小节分列（每列 16 拍、每行若干列）、按 BPM 反比的像素换算、tick 与轨道到图上坐标、跨列时间段的切分。纯几何，不绘制。方法见 [implementation/chart-image.md](implementation/chart-image.md)。
- `game-assets.ts`、`game-effects.ts`、`game-sounds.ts`、`stage-animation.ts`、`stage-program.ts`：资源副本清单、特效、打击音和舞台数据的类型与解释逻辑。

### `src/backend`

- `main.ts`：主进程入口。创建窗口、注册全部 IPC 处理函数与资源协议、维护读取白名单。
- `preload.ts`：把 `StudioBridge` 暴露为渲染进程里的 `window.studio`。
- `projects.ts`：项目文件夹的打开、保存、最近项目列表和原子写入，以及把导入的 C2S 组装成新工程。
- `library.ts`：本地曲库扫描与缓存，读取曲目的 XML 信息，把曲库谱面载入为新工程（含原曲解码与缓存）。
- `audio.ts`：调用 FFmpeg 与音频助手，完成格式归一、HCA 编码和游戏音频解码，以及编辑器试听用 WAV 的解码缓存。
- `cri.ts`：CRI 容器（ACB/AWB）的解析与重建。
- `export.ts`：生成 OPT 追加包。
- `dds-preview.ts`：DDS 封面解码。
- `cover.ts`：读取 PNG / JPG / DDS 封面，生成界面预览与导出用的 512×512 RGBA。
- `bundled-assets.ts`：读取 `assets/game/manifest.json`，把资源副本交给渲染进程。
- `game-textures.ts`、`game-models.ts`、`game-animation.ts`、`game-effects.ts`、`game-scene.ts`、`game-stage-program.ts`、`game-font.ts`、`game-audio.ts`：从原游戏文件解析贴图、模型、动画、特效、场景、字体和打击音。由 `scripts` 下的资源复制脚本使用，运行中的程序不读原游戏的这些文件。

### `src/renderer`

- `main.ts`：应用壳。把工程同步到各部件，处理工具栏动作、快捷键、载入与保存。
- `project-store.ts`：`ProjectStore`，当前工程、项目文件夹、未保存标记与撤销重做（最多 80 步），以及保存后让撤销步骤指向复制进项目文件夹的素材。不访问 DOM，可单独测试。
- `app-template.ts`：页面模板。
- `icons.ts`：界面图标。从 `lucide` 取图标数据拼成内联 SVG 字符串，模板与各对话框只经 `ICON` 取用。
- `app-context.ts`：`AppContext`，对话框访问工程、播放器和应用壳操作的唯一入口。
- `dialogs/`：设置、曲库、最近项目、导出、小节定位、信息类对话框。
- `editor.ts`：俯视编辑器 `ChartEditor`。持有选区、工具、拖动与交互模式（普通、插入节点、接续、对齐音乐、SLIDE 形状，同一时刻只有一个，经 `setMode` 切换），处理指针、键盘、工具栏与提交；谱面变换调用 `src/core/editing.ts`。它依赖下列模块，这些模块不反向引用它：
  - `editor-view.ts`：画布版面、缩放与滚动，tick、轨道与像素之间的换算，横向分割下哪些轨道线要画，以及 AIR 高度在原生镜头下的可见度（高度 5 以内完整可见、15 起全程出屏，数值来自播放页投影核对）。
  - `editor-hit.ts`：命中测试，找出指针下的音符、事件、节点与可插入位置；叠放时按绘制图层先给出画在上面的。
  - `editor-paint.ts`：整帧绘制。输入是 `ChartEditor` 每帧组装的只读 `PaintScene`。节点与头部按 `native-notes.ts` 的绘制图层叠放。
  - `editor-inspector.ts`：属性面板的标记。
  - `editor-template.ts`：工具栏与画布的页面标记、音符与事件的显示名。
- `chart-image.ts`：俯视图片的绘制：页头、列与小节线，音符按 `native-notes.ts` 的选型规则用资源副本贴图画出、按其绘制图层叠放，输出 PNG。
- `player.ts`：透视播放器。HUD 在 `player-hud.ts`，原生模型绘制在 `game-mesh-renderer.ts`、`native-notes.ts`、`native-air-geometry.ts`、`native-effects.ts` 等文件。`native-notes.ts` 同时给出各音符模型的绘制图层，播放页与编辑页共用。
- `transport.ts`：音频时钟，负责音乐播放、打击音、节拍器、变速和循环。
- `ui-settings.ts`：界面设置的读写。应用壳和编辑器的显示与监听偏好都经它存入 localStorage，不进工程，也不经过桥接接口。
- `browser-bridge.ts`：浏览器开发预览用的 `StudioBridge` 替身。
- `tokens.css`、`style.css`、`editor.css`：样式表。`tokens.css` 定义全部颜色、控件高度、圆角等设计变量；`style.css` 是应用壳、播放页工具条与对话框的样式，`editor.css` 是编辑器的样式，两者都只经变量取色，并各自 `@import` 一份 `tokens.css`，因此编辑器单独装载（如交互测试）时样式也完整。画布与播放器 HUD 的颜色由绘制代码自己决定。

## 进程边界

渲染进程开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，不能直接访问文件系统。它只能调用 `StudioBridge` 上的方法，每个方法是 `IPC_CHANNELS` 中一个通道上的请求：`preload.ts` 按这张表生成方法，`src/backend/main.ts` 用 `handle(方法名, 处理函数)` 注册，处理函数的参数与返回值按 `StudioBridge` 做类型检查。处理函数只做授权检查、对话框和调用，业务逻辑在各个后端模块里。应用壳用 `window.studio ?? browserBridge` 取得桥接对象，所以同一套渲染端代码在浏览器里也能运行，只是没有曲库和导出。

主进程维护一份读取白名单：渲染进程请求读取的路径必须是主进程交出过的（文件对话框的选择、已打开的项目、曲库扫描结果），或位于受信任的根目录下（用户数据目录、资源副本目录、曲库扫描找到的资源目录，即游戏目录下的 `data/*`、`option/*`、`bin/option/*`）。原地保存会删除被替换的素材，因此只允许保存到本次会话打开、创建或恢复的项目文件夹。

音频助手和 FFmpeg 作为独立子进程运行。Windows 便携包使用 `native/win-x64` 中的自包含可执行文件，Linux 开发环境使用构建出的 .NET DLL 和 `ffmpeg-static`。

## 数据流

### 工程

工程是一个不可变的 `Project` 对象，由 `src/renderer/project-store.ts` 的 `ProjectStore` 持有。每次编辑通过 `commit` 换成新对象，旧对象压入撤销栈，然后由 `src/renderer/main.ts` 同步到编辑器、播放器和音频时钟，并在 1.5 秒后把工程暂存到用户数据目录的 `recovery.json`。保存时主进程把工程写入项目文件夹，同时把音乐和封面复制进去。

编辑器、播放器和音频时钟共用同一份谱面和播放位置：音频时钟给出当前秒数，`src/core/timing.ts` 把它换算成 tick，每帧只绘制当前可见的那个页面。播放器按谱面建立的索引推迟到切换到播放页时才重建。

### 曲库

`library:scan` 扫描游戏目录下的基础资源和追加包，按 music 与 cueFile 文件夹及其修改时间生成指纹，结果缓存在用户数据目录的 `library-cache.json`；目录未变化时直接使用缓存，强制重扫忽略缓存。载入曲目时主进程解析 C2S、读取 XML 信息，并把原曲音乐解码成 WAV 缓存。

### 资源副本

播放用的贴图、模型和打击音事先由 `scripts` 下的脚本从游戏文件转换到 `assets/game`，随程序分发。运行时主进程读取清单，通过自定义协议 `chuni-asset://game/…` 直接提供文件，渲染进程只收到清单和 URL。该协议只响应资源目录内的 PNG、WAV、JSON，并带 CORS 头以供 WebGL 读取。

### 音频

编辑器试听和导出使用同一次 FFmpeg 解码：压缩格式先归一为 48 kHz 双声道 PCM16 WAV，偏移在重采样之后按整数采样点补静音或裁剪。这样编辑器里对齐的偏移与导出的音频一致。试听用的 WAV 按源文件路径、大小和修改时间缓存。

### 导出

导出前先校验谱面，有错误就中止。C2S 要求整数 tick，工程中的分数 tick 只有在用户确认对齐后才量化，工程本身不变。OPT 导出从所选游戏目录读取模板，在游戏目录以外生成独立的追加包；程序不会写入游戏目录。

## 构建与发布

- 渲染端由 Vite 构建到 `dist/`；主进程和预加载脚本由 `scripts/build-main.mjs` 用 esbuild 打包到 `dist-electron/`。
- `.github/workflows/ci.yml` 在推送时运行格式检查、类型检查、单元测试和渲染端构建；单元测试时启动 Vite 并设置 `CHUNI_UI_URL`，编辑器交互测试在 Chromium 中实际运行。代码格式由 Prettier 统一，配置在 `.prettierrc.json`。
- `.github/workflows/release.yml` 在打 `v*` 标签时于 Windows runner 上准备原生依赖、打包便携目录并附加到 GitHub Release。打包输出位于 `release/<版本号>/`。
- Node 版本以 `.nvmrc` 与 `package.json` 的 `engines` 约束。

## 关键约束

- 资源目录只读：程序不写入原游戏文件，导出目录必须在游戏目录之外。
- 未编辑的 C2S 记录保持原始文本；修改已知字段时保留额外列和未知记录。
- 工程以分数 tick 保存节奏，量化只发生在导出时。
- 使用原始资源不等于还原了实机画面：已实现与未复现的范围记录在下面的专题文档里。

## 专题文档

这些文档记录逆向核查的证据、研究过程和验证结果，按主题组织。

**音符与长条**
- [node-semantics.md](node-semantics.md)：长条节点的文件语义与编辑规则。
- [native-note-assets.md](native-note-assets.md)：音符模型与材质的来源和校验。
- [margrete-reference.md](margrete-reference.md)：编辑器界面与功能对照 Margrete 的情况。

**判定与计分**
- [native-judgement.md](native-judgement.md)：AUTO 判定与计分的核对。
- [native-judgement-reader.md](native-judgement-reader.md)：原生读取顺序与 SLIDE、AIR 的根关联。
- [native-judgement-residuals.md](native-judgement-residuals.md)：判定结果的剩余差异。
- [judgement-edge-research.md](judgement-edge-research.md)：判定的边界个案。
- [slide-judgement-research.md](slide-judgement-research.md)：SLIDE 持续判定的统计核查。

**打击效果与音效**
- [native-effects.md](native-effects.md)：打击特效的数据与执行范围。
- [native-effect-placement.md](native-effect-placement.md)：打击效果位置中已确认的部分。
- [native-hit-sounds.md](native-hit-sounds.md)：打击音的触发规则、音量、音高与包络。

**场景、舞台与相机**
- [game-scene-reference.md](game-scene-reference.md)：正常游戏场景的参考与布局标定。
- [game-scene-assets.md](game-scene-assets.md)：经典舞台与 HUD 资源的核对。
- [game-animation.md](game-animation.md)：经典圆环动画的原始数据。
- [game-camera-decoding.md](game-camera-decoding.md)：AFNC 相机与舞台结构的解码进展。
- [game-camera-candidate.md](game-camera-candidate.md)：相机数值候选。
- [native-scroll-speed.md](native-scroll-speed.md)：轨道流速与 FIELD WALL 的原生数值和预览换算。

**性能与验证**
- [performance.md](performance.md)：Windows 播放卡顿与长条接缝的验证。
- [verification.md](verification.md)：各版本的验证记录。

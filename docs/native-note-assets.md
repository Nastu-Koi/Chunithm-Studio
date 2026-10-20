# 原版音符模型与材质证据

本记录来自本地 `data/db/ModelTableRecord.bin`、`ModelSetTableRecord.bin`、`TextureTableRecord.bin`，对应 SVO 的 YABX 对象图/VBO/IBO/DDS，以及 `bin/chusanApp.exe` 的只读反汇编。原游戏未运行或修改。解析结果复制到 `assets/game`，播放器不读原安装目录。以下虚拟地址针对本地这一版 PE32，不能视为其他版本 ABI。

## 提取与校验

`game-models.ts` 按 Node→Mesh→Shape→Batch/State→Texture→Image 引用解码，不按 DDS/VBO 的排列猜配对。已完整读取 407 个音符/判定线模型、711 个 mesh batch，保留原顶点坐标、节点世界矩阵、RGBA、UV0/UV1、条带三角形、材质绑定和混合参数。无纹理的 Arch 也保留。DDS 解成 PNG 后按内容去重复制，来源路径只作元数据。0.1.9 的副本包含 269 张去重 PNG 和 8 个 WAV，HUD 补全后为 274 张。

`GameModelTexture.nominalWidth` 来自 ModelTableRecord 末尾字段。原函数 `0xb43ec0` 经 ModelSet→Model 引用读取该字段，正数时返回 `requestedWidth / nominalWidth`，否则为 1。资源名称的宽度不保证等于建模宽度；不能仅按名称缩放。

测试固定了原 AIR、CRUSH、Arch 的非图像源数据，并检查原始三角形索引、混合层、半透明顶点和两套 UV；损坏索引或缺失材质绑定会报错。

## 可执行资源清单

`NN` 是 `01..16`，下表中注明例外的模型不具有全部宽度。每个模型应使用自身 mesh 的材质/UV，不应把第一张 DDS 当成整个模型。

| 谱面元素 | 原模型/材质 | 范围与说明 |
| --- | --- | --- |
| TAP | `NotesTap_NN` | 全部 16 宽度 |
| EX TAP | `NotesChara_NN`, `NotesCharaNoEff_NN` | 前者含独立效果层；后者是原版无特效变体 |
| FLICK | `NotesFlick_NN` | 左右选择/动态动画仍由音符逻辑决定 |
| DAMAGE | `NotesMine_NN` | 含多 mesh，不能只显示一个平面 |
| HOLD | `NotesHold_NN`, `NotesHold_NN_point`; `HoldJoint` | 头/节点模型与长条材质分开 |
| SLIDE | `NotesSlide_NN`, `NotesSlide_NN_point`; `SlideJoint`, `SlideLine`, `SlideEffect` | `SLD/SLC` 判定属性不改变源材质本身 |
| AIR 上 | `NotesAirU_NN` | 原形状 y=0..15.574455，不额外悬空 |
| AIR 上斜 | `NotesAirUR_NN` | 左上为同模型 X 镜像，保留原三维倾斜 |
| AIR 下 | `NotesAirD_NN` | 独立形状，不能拿上箭头翻转 Y |
| AIR 下斜 | `NotesAirDR_NN` | 左下为同模型 X 镜像 |
| AIR 变体 | `NotesAirU_NN_P`, `NotesAirUR_NN_P`, `NotesAirD_NN_G`, `NotesAirDR_NN_G` | 资源确实存在；任意 C2S 颜色到这些变体的完整运行时映射尚未核实 |
| AIR HOLD 专用 Tap 资源 | `NotesAirHold_Tap_NN`, `NotesAirHold_Tap_NN_point` | 资源存在不等于每个动作节点都使用它；当前原生 AH/AS 动作节点选择见下文 |
| AIR 长条前竖面 | `NotesAirHold_Line`, `NotesAirHold_Line_P` | 单个宽 1 原模型；原 AH 在头处用平移矩阵绘制 |
| AIR 长条顶面 | `NotesAirHold_LineTop`, `NotesAirHold_LineTop_P` | 原 y=15.574,z=-4..0，沿时间方向拉伸 |
| AIR 长条顶面两翼 | `NotesAirHold_JointRoof_NN`, `NotesAirHold_JointRoof_NN_P` | 宽度缩放与 LineTop 分开 |
| AIR 动作节点 | `NotesAirHold_Ring_NN`, `NotesAirHold_Shadow_NN` | 原 AH Ring 平面 y=15.724；Shadow 有独立变换，不能当第二枚悬空 Tap |
| AIR SLIDE 长条材质 | `SlideJoint_G`, `SlideLine_G`, `AirHoldJoint[_P/_S]`, `AirHoldLine[_P/_S]` | DEF→_S、GRN→无后缀、PNK→_P；普通动态曲面规则见下文 |
| AIR CRUSH/原生 ALD | `NotesAirLadder_NN`, `NotesAirLadderTop_NN`, `AirLadderLine` | 全部 16 宽度的头/顶部；含双纹理和加法层 |
| CRUSH 地面/Arch | `NotesAirLadderGrd_04`, `NotesAirArch_04`; `AirArch` | 仅宽 4 源模型，不能伪称有其他宽度原模型 |
| 判定线 | `GoalLine` | 原 PNT 网格及贴图 |

原表没有 `NotesAirUL`、`NotesAirDL` 或 `NotesAirH` 模型名。

## AIR 位置与方向

`AirNote` 构造函数 `0xc41e50` 将高度状态设为 1。初始化 `0xc42bb9` 调 `0xb412e0`：

```text
baseY = (height - 1) * 3.8934998512268066
centerX = (lane + width / 2 - 8) * 4
```

普通 AIR 因此 `baseY=0`。AIR SLIDE 父节点高度先从原生整数乘 0.1，再应用该高度式。模型自身 y≈15.574 的箭头顶端已包含抬手高度。`0xc42c03..0xc42c1b` 只对方向 raw 2/4 取负 X scale；数据表 `0x1c1eb00` 的六行依次 U、UR、UR、D、DR、DR。与原生方向对应后，左右斜箭头共享网格且只镜像 X。

`AirHoldNote` 构造 `0xc45677` 同样给高度 1，因此常规 AH 的 baseY 也是 0。初始化将普通 U 作为头部箭头。更新 `0xc46b30` 的对象成员对应：

- `+0x1cc` → `NotesAirHold_Line`，`0xc46bf5..0xc46c49` 给它单位旋转/缩放加头位置平移，是前端竖面。
- `+0x274` → `NotesAirHold_LineTop`；`+0x1c4` → `JointRoof_NN`。
- `0xc470c6..0xc47210` 遍历未结束节点与链尾，取可见 zMin/zMax。顶面 zScale=`(zMax-zMin)/4`，z 平移=`zMax`，yScale=1；Roof 额外乘宽度比例，LineTop 的 xScale=1。
- Ring/Shadow 位置的 y 常量 `0x19151e8`=15.724，比顶面高约 0.15。

AH 初始化 `0xc483d5..0xc483ff` 将原色号 0/1 映射变体 0、2 映射变体 1。色号由 `0x1203c50` 的原字符串表 `DEF/GRN/PNK` 确认，因此 AH 默认与 GRN 同组，PNK 才切 `_P`。AH 动作节点初始化 `0xc488cc..0xc48a25` 只建立 Ring/Shadow，不为每个动作增添专用 Tap。

AH 顶面的原资源默认材质不能直接作为运行时亮度。`0xc47227` 检查运行时 `+0xec`，再由 `0xc47245 / 0xc47374 / 0xc472f3` 写第一 shape 的材质常量 `0x11`：普通 JointRoof 为 RGBA `[1,1,1,27/255]`，状态 3 为 `[1,1,1,80/255]`，状态 4 为 `[.5,.5,.5,3/255]`。LineTop 普通/状态 3 为白色 alpha=1，状态 4 的 alpha=128/255。原常数分别来自 `0x1c1ee4c..0x1c1ee60`。`getNativeAirHoldMaterialColors` 将这三种状态统一为 pending/held/failed 的 0/1/2；不能把 roof 以 alpha=1 绘制，否则会出现很亮的黄绿整面。

AS 初始化 `0xc4c700` 则把 0/1/2 映射变体 2/0/1：DEF 使用 `AirHoldJoint_S / AirHoldLine_S`，GRN 无后缀，PNK `_P`。头部选择 `NotesAirU_NN` 或 `_P`，不使用 `NotesAirHold_Tap`。高度公式仍为上式，标准 C2S 高度 5 对应原单位约 15.574。抬高父节点场景的额外头部缩放来源仍需单独核清。

资源名 `_sky` 不能作为染蓝的依据。本机 `ntt_ahroof.dds` 与 `ntt_ahroof_sky.dds` 两个原文件逐字节相同：384 字节，SHA-256 均为 `589b58d5083ca04e83e7398c1af9e9a4afe2df1fef9d583641d28b3251f24c41`，因此共用去重 PNG 是正确结果。`ntt_ahline_sky.dds` 是未压缩 32 位 BGRA，掩码依次为 `00ff0000/0000ff00/000000ff/ff000000`；直接按原字节与 PNG 副本逐像素比对，4096 个像素零差异。其非透明像素平均 RGB 约 `[113.33,255,31.25]`，原图本身就是绿色。AS strip 的原初始化 `0x4d1fe0` 设置白色 RGBA，mode 8 更新 `0xc285c7..0xc28622` 只更换 alpha，没有已确认的 `_sky` 蓝色 RGB 乘值；预览保留原图本色。

### 已实现的 AS 普通连接曲面

`native-air-geometry.ts` 转写 `0xc275e0` 的 mode 8 普通路径。输入为原单位坐标与已映射的 Z，输出原材质键、顶点、UV、顶点颜色，不负责猜测相机或滚速。

- Joint 的实际宽度为轨道宽度的 75%；源普通状态 alpha=27/255、held=80/255、failed=3/255。水平 UV 是 `(laneEdge - firstCenterLane) * 1.2999999523 + 0.5`，计算使用未缩窄的原轨道宽度。
- `Field` 地面层在 y=0。宽度倍率从 y=0 的 0.75 线性降到 y=15.574 的 0.65，超过后不再降；原静态颜色白色、alpha=64/255，由初始化 `0x4d2010` 确认。
- 中心线使用原 `AirHoldLine` 材质，普通半宽 1.96，原参数 `+0x20` 开启时半宽 0.98。普通/held alpha=1，failed=128/255。不是铺满音符宽度的粉色横带。
- 链首额外从 baseY 接到首节点高度，保持相同 X/Z；后续分段没有重复竖面。
- 原 V 配置为 1→0，见 `0xc4cf98` 与 `0xc246d0`。若按裁剪/滚速变化拆段，应沿同一 V 区间插值；普通节点间的控制节点也不能错误重置相位。

`native-air-timing.ts` 为每段缓存其所在的普通节点区间：中间 ASC 不重置，ASD 后开启下一段 1→0；同一跨度内的 V 以音乐秒数比例计算。证据是 AS 更新 `0xc4b72c` 将节点原时间 `+4` 减当前时间，写入运行时 `+0x23c`，对应 strip 参数 `+0x14`。受滚速变换的值使用另一套 `+0x230` / 参数 `+0x8`，只影响 Z。`0xc27c3f..0xc27d12` 从未滚速变换的时间累计比例，因此不能使用 tick 比例或滚速后距离替代。测试中 120→240 BPM 的等 tick 两段在控制点的 V 为 1/3；停止或反向不改变该 UV 相位。

连接沿实际 C2S 记录顺序，按原地面根优先级消费当前 AIR 尾，匹配时间、位置、宽度、高度及 ASD/ASC 父类型；原父匹配不把颜色作为连接键。缓存随不可变 Chart 对象更新，零时长与末尾控制段保留有限值。

此 helper 生成原单位几何，运行时前后裁剪仍由调用者负责。CRUSH 特殊 Trace 方向的已确认路径见下文；未证实的 Arch 动态变换不在覆盖范围。

### CRUSH 首节点

`0xc37550` 比较生成条目索引是否为 0；`0xc3759a` 首条目使用 ModelSet 表 `0x1c1e2e8` 的 `NotesAirLadderTop_NN`，后续用 `0x1c1e328` 的 `NotesAirLadder_NN`。这基于生成链的首条目，不能把每个分段都当成首条目。CRUSH 连接初始化 `0xb3c846` 明确使用共享 strip mode 9，更新 `0xc36a11` 调用 `0xc275e0`。资源表 `0x1c1cfd0` 是 `[-1,-1,13]`，13 对应 `AirLadderLine`，所以只画中心线，不画 AS 的 Joint/Field。`0xb3c887` 在颜色 raw 15（NON）时明确禁用全部三个纹理槽；这项有调用证据，不能泛化成所有名为 NON 的 SVO 材质都透明。`getNativeAirCrushGeometry` 覆盖上述路径。Ground/Arch 动态放置尚无完整证据。

横档模型的位置经过 `0x416833` 跳板调用 `0xb41300`，为 `H(height)+0.15`；连接中心线使用 `H(height)`。这 0.15 的间距属于横档变换，不能同时加到整个 CRUSH 曲面。

CRUSH 连线的 V 也与 AS 不同：`0xb3cb75` 从 `0x190f198[color]` 读取原浮点数，`0xb3cb82 / 0xb3cb87` 将两端 V 都设为此值，因此整段取同一水平色带。`0x1203d60` 使用 `0x1c26e00` 的 16 项颜色表：`DEF RED ORN YEL LIM GRN AQA CYN DGR BLU PPL VLT PNK GRY BLK NON`，未知字符串回到 DEF。表中例如 DEF=0.15619999、RED=0.96880001、GRN=0.71869999、PNK=0.28119999；代码保留完整原浮点表，而非猜测等分坐标。相邻原方向表是 `DEF / AxisY / AxisZ / Trace`，四种几何均已实现。

Trace 分支 `0xc28c69..0xc29029` 生成四面菱形细管。它按 Z 把近端排在前，XY 半径固定为原常数 `0x1796960` 的 0.5，与普通线宽或窄线选项无关。每个端面的左/右/上/下四点 U 是 `[0.2969000041,0.6875,0.5,0.5]`，V 使用同一颜色值。侧面共 8 个三角形；原链头且未裁剪时有额外 2 个近端封口三角形。初始化 `0xb3c90e` 把中间点的标志清零；`0xc27b0f..0xc27b21` 仅在链首或显式分隔点开启封口，裁剪 `0xc28002` 再清除。调用者在人工滚速拆段时不能为每个子段加封口。

`tests/fixtures/native-crush-trace.json` 是只读隔离 x86 运算对照：仅运行上述几何分支、拦截顶点追加，不调用游戏入口或启动游戏进程。研究脚本 `out/effects-research/trace-oracle.py` 保留生成方式。正向带封口、反向无封口、等 Z 三个输入的原三角形顶点顺序、位置、UV，与 TypeScript helper 逐项比较通过；测试容差只容纳原 float32 与 JavaScript number 的差异。

### 普通长条端点

HOLD 初始化 `0xc4f110` 的尾端对象默认从表 `0x1c1f238` 取 `NotesHold_NN_point`；SLIDE 可见节点 `0xc33ab0` 检查 visible 标志后，默认从表 `0x1c1e1a4` 取 `NotesSlide_NN_point`。控制节点不创建此模型。两者有另一分支选择 `NotesAirTap_NN_point`，由运行时 `+0xb5` 及 SLIDE 节点标志共同控制；尚未将该标志对外命名或将它错误等同于所有显式 AIR。

## 绘制图层：位置相同的音符谁在上层

原游戏不按谱面记录顺序叠放音符，而是按模型所属的图层。证据来自本地 `data/db/LayerTableRecord.bin`、`ModelSetTableRecord.bin` 与 `bin/chusanApp.exe` 的只读反汇编。

- `LayerTableRecord` 每条为 id、名称、说明、层值。层值从 `BG`（0，说明“最背面”）到 `TopMost`（36，“最前面”），层值大的在上面。与音符有关的几层：`HoldJoint` 15、`SlideJoint` 16（两种带体）、`HoldEnd` 17、`SlideEnd` 18、`AirTapNotes` 19、`NormalNotesHold` 20（“HOLD先頭時用通常Tap”）、`NormalNotes` 23（通常ノーツ）、`FlickNotes` 24、`ExTapNotes` 25、`MineNotes` 27、`AirNotesShadow` 28、`AirNotes` 30、`AirNotesRing` 31。
- `ModelSetTableRecord` 每条为 id、名称、说明和 9 个整数，第 4 个是图层 id，第 7 个是排序方式（`ModelSortModeTableRecord`：0 不排序、1 反转、2 距离近的在前、3 距离远的在前），第 8、9 个是层内优先级的基数与每宽度增量。各音符模型族：`NotesTap`、`NotesCharaNoEff` 在 `NormalNotes`；`NotesChara` 在 `ExTapNotes`；`NotesFlick` 在 `FlickNotes`；`NotesMine` 在 `MineNotes`；`NotesHold`、`NotesSlide` 头部在 `NormalNotesHold`；`_point` 端点分别在 `HoldEnd`、`SlideEnd`；AIR 箭头与 `NotesAirHold_Line` 在 `AirNotes`，Ring、LineTop、Roof、Ladder 在 `AirNotesRing`，Shadow 在 `AirNotesShadow`。`FlickNotesHold`、`ExTapNotesHold`、`MineNotesHold` 三层没有任何模型集合使用，也没有找到运行时把音符改到这三层的代码（改层函数 `0xdad3e0` 唯一的调用 `0xd697c9` 属于特效）。
- 模型实例创建 `0xdacd70` 在 `0xdacf2b..0xdacf8f` 取模型集合的图层，经 `0x4571ad` 查出层值，写进排序键 `+0x128` 的第 8–14 位；低 8 位由 `0xc402c0` 写入：`基数 + (宽度 − 1) × 增量`，限制在 0–255（经 `0xdad420`）。TAP、ExTAP、FLICK、DAMAGE 为 `15 − (宽度 − 1)`，SLIDE 头 `31 − 2(宽度 − 1)`，HOLD 头 `30 − 2(宽度 − 1)`，HOLD 端点 `31 − 2(宽度 − 1)`，SLIDE 端点 `30 − 2(宽度 − 1)`，AIR 系列为常数。同层内窄的音符优先级高。
- 选模型：TAP 初始化 `0xc41c42..0xc41c76`、SLIDE 初始化 `0xc34adb..0xc34b04`、HOLD 初始化 `0xc4f0b4..0xc4f0d7` 都先看音符的 EX 标志 `+0x79`：有 EX 时调用 `0xc3f7f0`，取 `NotesChara_NN`（或 `+0x7a` 置位时取 `NotesCharaNoEff_NN`），否则取各自的普通模型。所以 **SXD / HXD 的头部就是 ExTAP 模型，在 `ExTapNotes`（25），盖在 TAP（23）和 FLICK（24）之上**；普通 SLIDE / HOLD 的头部（20）在 TAP 之下；DAMAGE（27）和 AIR 系列又在 EX 之上。
- `+0x7a` 由 `0xc41383..0xc413a9` 设置：`0xb42ec0` 用时刻、轨道和宽度组成的键查一张表，同一键上已经登记过特效的 EX 音符改用 `NotesCharaNoEff`（`NormalNotes`，23），这时它与 TAP 同层。预览没有复现这条去重规则，EX 头一律用 `NotesChara`。

- 带体不是模型集合，图层在代码里指定，层内优先级都是 `16 − 宽度`（`0xc3f880`）：HOLD 带体 `0xc4f311`／`0xb3dcc3` 用 `HoldJoint`（15）；SLIDE 带体 `0xb3ebb4` 用 `SlideJoint`（16），SlideJoint／SlideLine／SlideEffect 三条同层；AIR-SLIDE 条带 `0xc4d031..0xc4d077` 的 Joint 与中心线在 `AirNotes`（30），地面层 Field 在 `AirNotesShadow`（28）；AIR-CRUSH 中心线 `0xb3c86d` 在 `AirNotes`（30）。AIR-HOLD 的顶面 `NotesAirHold_LineTop` 与两翼是模型，在 `AirNotesRing`（31）。
- HOLD 终点与 SLIDE 可见节点在音符 `+0xb5` 置位时改用 `NotesAirTap_NN_point`（`AirTapNotes`，19；`0xc4f119`、`0xc33b8a`）。`+0xb5` 由 `0xc41456..0xc41474` 按记录 `+0x14` 是否为 3、5、8 决定，含义未核清，预览仍用 `_point`。

全部部件由下至上：

| 层值 | 部件 | 层内优先级 |
| --- | --- | --- |
| 15 | HOLD 带体 | 16 − w |
| 16 | SLIDE 带体 | 16 − w |
| 17 | HOLD 终点 | 31 − 2(w − 1) |
| 18 | SLIDE 可见节点 | 30 − 2(w − 1) |
| 19 | 带 `+0xb5` 的 HOLD 终点、SLIDE 节点（预览未用） | 30 − 2(w − 1) |
| 20 | HOLD 头、SLIDE 头 | 30 − 2(w − 1)、31 − 2(w − 1) |
| 23 | TAP（去重后的 EX 也在此，预览未用） | 15 − (w − 1) |
| 24 | FLICK | 15 − (w − 1) |
| 25 | ExTAP、HXD／SXD 头 | 15 − (w − 1) |
| 27 | DAMAGE | 15 − (w − 1) |
| 28 | AIR-HOLD 动作节点影子、AIR-SLIDE 地面层 | 255、16 − w |
| 30 | AIR 箭头、AIR-HOLD 前竖面、AIR-SLIDE 条带、AIR-CRUSH 中心线 | 255、0、16 − w、16 − w |
| 31 | AIR-HOLD 顶面与两翼、AIR-HOLD／AIR-SLIDE 动作环、AIR-CRUSH 横档 | 1、255、255、255 |

判定线 `GoalLine` 为 13，场内连击数 `ComboScore` 为 14，都在全部音符之下；打击特效在 32–35。

尚未核清：排序比较函数本身，以及排序方式（地面音符为“距离近的在前”，AIR 为“距离远的在前”，写入实例标志第 16–17 位，`0xdacdbc..0xdace00`）与排序键怎样组合。间接证据倾向“先比层、层内再比距离”：层表有“最背面／最前面”的说明，场内连击数画在全部音符之下，地面带体必须整体压在头部之下（见下文 0.1.9），排序键里只有层与宽度。

**播放页采用的“层优先、层内由远到近”是未经实机确认的假设。**“层优先”与层内的远近方向都没有在可执行文件里找到直接依据，也没有在原游戏里对照过。验证方法：在原游戏里看一条从 TAP 上方经过的 AIR-SLIDE，其地面层是否始终盖住 TAP；看一个较远的 ExTAP 与稍近的 TAP 在画面上重叠时谁在上面；或继续找读取实例标志第 16–17 位的排序代码。若实机不符，改 `sortPlayerPrimitives` 一处即可。

预览的实现：`native-notes.ts` 的 `getNativeDrawOrder`（头部与端点）和 `getNativeBodyDrawOrder`（带体；AIR-SLIDE 条带的地面层为 28，Joint 与中心线为 30）给出 `层值 × 256 + 层内优先级`。

- 播放页（`sortPlayerPrimitives`）：先比层，不论远近；同层由远到近；同层同距离再比层内优先级。因此 HOLD／SLIDE 带体在全部头部之下，EX 头在全部 TAP 之上，AIR 系列在全部地面音符之上；判定线（13）先于全部音符画出。AIR-HOLD／AIR-SLIDE 动作节点拆成影子与动作环两步，AIR-SLIDE 条带拆成地面层与 Joint、中心线两步（几何每段多算一次，约 2 µs）。打击特效仍在全部音符之后；HUD 的场内连击数仍画在音符之上，与原生的 14 层不同，没有处理。
- 编辑页与俯视图片：带体按原生顺序（HOLD 在 SLIDE 下，AIR 条带在上，AIR-HOLD 最上），节点、头部、AIR 箭头、动作环、横档也按原生顺序且不分时刻（`editorBodies`、`editorMarks`、`chartImageBodies`、`chartImageMarks`）。为了看清地面音符，两者都把全部带体画在节点与头部之下，这与原游戏 AIR 条带盖住地面头部不同。编辑页点击叠放处时按同一顺序先选中上面的。

`tests/note-draw-order.test.ts` 覆盖两种记录顺序下 SXD 盖住 TAP、TAP 盖住 SLIDE 头与端点、带体的层序、AIR 条带盖住地面头部、影子在 AIR 箭头之下而动作环在上，以及播放页按层优先绘制（较远的 ExTAP 盖住较近的 TAP、判定线在全部音符之下）。

## 材质枚举与着色

原程序 Stevia 反射表直接给出命名：

- `0x1939598`：混合因子 0 ZERO，1 ONE，2 SRCCOLOR，3 INVSRCCOLOR，4 SRCALPHA，5 INVSRCALPHA，6 DSTCOLOR，7 INVDSTCOLOR，8 DSTALPHA，9 INVDSTALPHA，10 SRCALPHASAT。
- `0x193a65c`：混合操作 0 ADD，1 SUB，2 REVSUB，3 MIN，4 MAX。
- `0x193a204`：UV wrap 0 REPEAT，1 MIRROR，2 CLAMP，3 BORDER。
- `0x193a2cc`：Cull 0 CW，1 CCW，2 NONE。

AIR 的主要层 `(SRCALPHA, INVSRCALPHA)` 与发光层 `(SRCALPHA, ONE)` 是两个原 mesh；顶点 alpha 例如 0.2、0.949、0.898 必须保留并插值。

本地程序内嵌了原 `DefaultPSFuncTex.h` 等 shader。注册 `0x620a19` 记录数据/长度，原读取循环 `0x61f0f5..0x61f10f` 逐 32 位执行 `data XOR entryKey XOR 0x59634649`。只读研究副本位于 `out/effects-research`，没有把原 shader 源码编入应用。

由 `DefaultPSFuncTex.h:getBaseMap/combineTexture` 确认，双贴图将第一绑定当 dst、第二绑定当 src；只对 RGB 应用 layer 运算，返回的 alpha 始终是第一绑定的 alpha。Layer 枚举与 framebuffer blend 枚举不同：factor 0 ZERO/1 ONE/2 SRCALPHA/3 INVSRCALPHA/4 DSTALPHA/5 INVDSTALPHA；operation 0=`src+dst`、1=`src-dst`、2=`src*dst`。

CRUSH `add_` 源材质为 layer factors 1/1，operation 2，因此 RGB 乘两张贴图、alpha 保留第一张，之后再乘材质及顶点颜色。将两个 alpha 相乘会错误削弱它。

`DefaultPSFunc.h` 有纹理时先测试 `base.a - shapeParam.x`，小于零才丢弃；测试对象不是乘过顶点透明度的最终 alpha。`0x6d82f0..0x6d8392` 经 `0x659dd0` 读取无符号 alphaRef 字节，乘 `0x179567c` 的 1/255，再限制最小值为 0.0001；因此 25 对应 25/255，0 对应 0.0001。UV 静态变换为 `uv * tsUVScrollUVn.zw + tsUVScrollUVn.xy`，原参数已随模型保留；动态时间推进不据名称臆造。

## 长条带体的运行时状态

AH 顶面与 AS Joint 的原生状态亮度见上文（普通 27/255、held 80/255、failed 3/255）。播放器始终使用普通状态：原游戏按运行时判定状态切换（各状态值的含义尚未核清），预览不模拟判定状态，轨迹在判定线前后保持同一亮度；按音符起点切换会让已越过判定线的各段比未到达的段亮约 3 倍。`getNativeAirSlideGeometry` 与 `getNativeAirHoldMaterialColors` 仍保留三种状态，供日后显示判定结果时使用。`tests/air-trail-brightness.test.ts` 检查 AHD／ASD 在判定前、中、后都只出现 27/255。

地面 HOLD／SLIDE 带体也有同类状态，播放器尚未实现：

- 顶点颜色来自静态初始化：`0x4d1fe0` 设 `0x1cbc498` 为白色 RGBA(255,255,255,255)，`0x4d1fc0` 设 `0x1cbc4a0` 为 RGBA(102,102,102,255)（约 0.4 灰）。
- HOLD 更新 `0xc4e8f6..0xc4e944` 由运行时 `+0xec`／`+0xe8` 得出 mode 0/1/2，传入几何 `0xc2dee0`。`0xc2e1d8..0xc2e1f9`：mode 0 白色，mode 2 改用 0.4 灰；`0xc2e3cf` 把一个浮点写入模型 `+0x1d4`，mode 0/2 为 1.0（`0xc2e140`），mode 1 为 `sin(2π·frac(t·0.05))·0.25 + 1.5`（`0xc2e328..0xc2e388`，常数 `0x1914a68`、`0x18a15b4`、`0x18a2724`、`0x18a43b4`），在 1.25～1.75 之间脉动。
- SLIDE 几何 `0xc2c5a0` 的 `0xc2d59b..0xc2d5ad` 与 `0xc2d900` 用同一组颜色和同一脉动公式。
- `+0x1d4` 位于带体的绘制配置 `+0x1c8` 内（偏移 `+0xc`）。初始化 `0xdacb90` 写入 `[1, 4(blend), 0x8005, 1.0, 0]`；应用 `0xdac9c0` 把这个浮点复制到渲染状态 `+0x24`，与 blend（`+0x4`）、贴图（`+0x10→+0x30`）一起提交。渲染状态 `+0x24` 由哪段代码使用尚未找到，因此它是否是 RGB 亮度倍率仍是假设；`t` 的单位与 `+0xec` 各值对应的判定状态也未核清。
- 播放器当前对 HOLD／SLIDE 带体固定白色、alpha 1、`SRC_ALPHA / ONE / ADD`，对应 mode 0。

## 边界

完整原网格和原图不自动等于完整原生演出。尚未核清的动态材质/UV、CRUSH Ground/Arch 变换和打击粒子必须单独标记覆盖程度。ModelSet 390/391 的 Ground/Arch 资源确实存在，但已确认的 ALD 初始化只取 Top/Ladder 与 AirLadderLine；尚无证据支持把 Ground/Arch 强加到普通 CRUSH。新增自定义几何、颜色近似或缺资源 fallback 都不能标记为原生已还原。

## 0.1.13 AIR 长条抬升段

AIR HOLD／SLIDE 播放到中间节点及接续节点时不再重新出现抬升段。

## 0.1.9 地面长条重叠

JointHold 的构造使用 primitive `0x444cc4 → 0xc22550`；JointSlide 构造中的三项组件也使用同一 primitive。绘制配置 `0x453cdd → 0xdacb90` 将 blend 字段设为 4。JointHold setup `0xc270f0` 写入纹理与绘制标志，但不覆盖该字段；`0xdac9c0` 通过 `0x42a4be → 0x6cdaa0` 应用 blend。现有原生混合表解析将此模式映射为 SRC_ALPHA / ONE / ADD。普通不透明混合会使重叠的长条相互抹掉。

Hold 几何 `0x450df3 → 0xc2dee0` 的源顶点为 24 字节（XYZ、RGBA、UV），U 横跨宽度，V 沿前后距离。最初“应当旋转贴图”的假设被这些赋值否定；最终没有旋转源贴图。播放端将地面长条作为先绘制的一组，再绘制头部，解决按长条平均距离排序时遮挡头部的问题。此分组是预览器的遮挡修复，不声称已经解码原游戏全部渲染队列；后来解出的图层表（见上文“绘制图层”）中两种带体确实低于所有头部与端点。

`tests/ground-ribbon.test.ts` 在修复前对 HOLD / SLIDE 都失败，修复后通过。`tests/windows-native-notes.mjs` 实际渲染重叠 HOLD、双向交叉 SLIDE、TAP 和变 BPM，并记录提交顺序；`tests/mesh-gpu-browser.ts` 读取实际 GPU 像素验证两层不透明纹理的加法和顺序无关性。测试只证明这些具体行为，未覆盖全部 WORLD’S END 材质演出。

HUD 字体提取来自 `RFO_SEGAKAKUGOTHIC_DB_24pt.rfz`。RFZ 是带 YS v2 头的 MSB LZW，解出 YABX 数据库；24 像素行高、7,161 个字形及两页 ARGB4444 图集均通过结构校验。绘制使用原 advance 与 bearing。原字体缺失的字符显示问号。中央 COMBO 使用 `chu_count_combo.afb` 的原 DDS 和 AFNC 属性 402 中的 UV 区间，不使用系统斜体替代。字体和数字只从项目副本加载。

字体格式交叉参考：[RFZ 解包规格](https://gzlxz190614.github.io/GekiChuMaiLocalizedDocument/Chunithm/Extra/rfz/1.rfz_unpack_spec.html)、[字形坐标分析](https://gzlxz190614.github.io/GekiChuMaiLocalizedDocument/Chunithm/Extra/rfz/2.rfz_glyph_coords_analysis.html)。最终字段与像素均以本地文件解码结果为准。

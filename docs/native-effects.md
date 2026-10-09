# 原生打击特效：数据、执行范围与验证

本页记录 0.1.8 的实现边界。项目复制了本地资源中的纹理及解码后的 AFNC 数据；运行播放器无需读取原游戏目录。读取了 53 个效果程序，不等于完整执行了 53 种动画。采样器逐组件返回 `partial` 与 `diagnostics`，尚未解释的动画命令不会被写成自行设计的运动曲线。

## 来源与关联

- 原始表：`D:/chunithm/data/db/NotesEffectTableRecord.bin` 与 `AcroartsTableRecord.bin`。前者有 19 个效果族，每行 14 个整数引用；后者提供实际 AFB 文件名。
- 原始容器：`D:/chunithm/data/acroarts/*.afb`。AFNC 版本为 `2012060601`，AFRC 提供图像资源名。解析器检查 POF0 指针归属、节点链与数组范围，不修改源文件。
- 本地二进制依据：`D:/chunithm/bin/chusanApp.exe`，SHA-256 为 `de29131ec8ef51b30b5eba2804d061a8d839577e33d6749fde4c3397aa3fd1c4`。本轮仅静态读取，并在隔离内存中调用限定的纯数学函数；没有启动原游戏、创建原游戏进程或注入游戏。
- 项目入口：`src/backend/game-effects.ts` 负责读取；`src/core/game-effects.ts` 负责纯数据采样；`src/renderer/native-effects.ts` 用已复制贴图绘制采样结果。

`selectNativeEffects` 使用原表选择 bomb、reaction、text、keep。TAP reaction 对应记录 24 的 `CHU_EF_Tap_reaction_v20`，而非同目录中旧版 v10。CRUSH 使用 `AirLadder` 行，其 bomb 引用为 60。

原函数 `0xb33c10` 按实际宽度选择不小于它的最小档位：1、2、3、4、6、8、16。宽 5 选 6，宽 7 选 8，宽 9～16 选 16。`0xb33d47` 的 AIR/AIR DOWN/AIR HOLD IN 分支还乘以「实际宽度 / 所选档位」修正 X；其他族保持 1。16 轨逻辑不变。

自动播放使用 root state 0。原 `NotesJudgeResultTableRecord.bin` 的 id 3 为 JusticeCritical，`0xb35940(3, 0)` 对应 state 0；同一判定的附加参数 1、2 分别映射 8、9。本实现没有模拟这些额外状态条件。

## 已执行的原数据

| 数据/命令 | 实现范围 | 依据与核验 |
| --- | --- | --- |
| SglPrimitive，节点类型 100 | 固定尺寸的原矩形及其原 UV；`+32` 为保持高宽比，固定尺寸时可直接使用 | 构造函数 `0x14c03cb` / `0x14c04e6` |
| MomMatrix，100 | 原常量及固定正弦模式，原记录顺序的平移、旋转、缩放 | 与舞台共享已核对的矩阵采样器 |
| MomTexturePatternAnimation，401 | 确定性资源与图块选择、正反序、循环与末帧保持；保留原单位更新时的余数重置行为 | `0x14b39f0` / `0x14b3c00`，160 帧原函数结果逐项相同 |
| MomUvSet，402 | mode 0 的原四个 UV 坐标及宽高相对标志 | `0x14b73e1`；TAP JC 文本实际使用 atlas `[.477,.111,1,.266]` |
| MomCurve，1003 | 本地效果实际使用的 AD3 时间/数值 Hermite 曲线，固定边界；按原 time 曲线反求参数 | 构造 `0x14be020`、采样 `0x1498f10`；15 个原函数样本误差小于 0.0005 原空间单位 |
| MomMaterial，300 | 固定、无继承、非随机、线性、alpha-only 序列；保留原字节截断 | `0x14b2470` / `0x148ba30`，27 个边界和小数样本逐项相同 |
| CorForester，kind 2 | 固定时长的父子链截止；不擅自选择随机寿命 | 构造读取 `node+0x38`，`0x1285010` 在 current >= duration 时结束节点 |
| SglBasicParticle，6001008 | 原位置/速度/加速度/径向力/阻力、大小、颜色、旋转和纹理帧公式；局部坐标模式 0，形状 0/2/3，发射模式 0/1/2 的首批 | 原 `ParticleSystem.h` 与 `0x6dd0f0`；空、单、双、三关键帧的参数数组与原初始化结果核对 |

粒子着色器源码来自原程序内嵌数据，而非外部相似游戏的公式。原解码函数 `0x61f0f5`～`0x61f10f` 按 32 位字执行 `data ^ entryKey ^ 0x59634649`。独立实现保留了原着色器中不对称的速度参数索引；没有为使运动“看起来合理”而修正原公式。着色器文本只留在本地研究输出中，运行包使用 TS 采样实现。

TAP JC 火花父曲线在 time 5 时 Y 约 5.69363、13 时为 16、40 时为 19。实际父分支寿命为 30 单位，因此 30 时已无输出；不能用粒子自身 1500 单位寿命让整次打击保持 25 秒。TAP 文本 alpha 在 0 时为 0、3 时为 129/255、20 时为 1、25 时为 0，分支寿命为 35 单位。

`effectResourceIndices` 只返回选定激活分支实际需要的纹理引用，避免解码当前自动播放不使用的其他判定图集。粒子曲线参数以不可变资源对象为键缓存；每次采样有粒子数量上限，默认 512，允许范围 1～4096。

## 实际覆盖快照

以下为宽 4、root state 0、time 5 的采样结果；数字是「矩形数 / 粒子数」，不是完整动画覆盖率。不同时间、宽度与判定会变化。详情在本地研究输出 `out/effects-research/executed-coverage.json`。

| 效果族 | bomb | reaction | text | keep |
| --- | --- | --- | --- | --- |
| Tap / Hold / HoldEnd / Mine | 0 / 80 | 1 / 0 | 1 / 0 | 无原表引用 |
| Chara | 无原表引用 | 1 / 0 | 1 / 0 | 无原表引用 |
| Slide / SlideChain / SlideEnd | 0 / 80 | 1 / 0 | 1 / 0 | 2 / 0 |
| Air / AirDown / AirHoldIn | 0 / 53 | 无原表引用 | 2 / 0 | 无原表引用 |
| AirHold | 0 / 80 | 无原表引用 | 1 / 0 | 无原表引用 |
| AirSlide | 无原表引用 | 无原表引用 | 1 / 0 | 无原表引用 |
| AirAction | 0 / 80 | 无原表引用 | 2 / 0 | 无原表引用 |
| AirActionEnd | 0 / 91 | 无原表引用 | 2 / 0 | 无原表引用 |
| FlickLeft / FlickRight | 原 type 204 未执行 | 1 / 0 | 1 / 0 | 无原表引用 |
| FlickNone | 0 / 80 | 无原表引用 | 1 / 0 | 无原表引用 |
| AirLadder / CRUSH | 3 / 3 | 无原表引用 | 1 / 0 | 无原表引用 |

## 仍需核对的边界

- 上表中有输出的组件仍可能受未覆盖命令影响。原贴图、几何与已知曲线会绘制，未知变换以诊断列明；不能把它们称为原引擎逐像素复现。
- MomMatrix property 101 经 `0x14a1350` 读取原相机矩阵及 eye 计算朝向；目前没有完整接入。MomMatrixGoal 106 的缓动、部分随机矩阵、继承/RGB 材质曲线、原类型 200/204/205 等尚未全部执行。FLICK bomb 是明确的未执行组件，不能用 reaction 的成功覆盖它。
- 连续发射模式 0 暂只采样原容量的首批，没有推测重启调度。粒子第六曲线、全局共享随机种子、摄像机淡出与包裹条件尚未校准。
- 属性 300 的 52 字节 `SpkTextureState` 完整保留。它的前两词是 wrap 设置，不能误当 blend 因子。原 blend mode 来自节点头 `+0x0c`，通过 `0x12953c0` → `0x1294f00` → `0x6cdaa0` 送入 shader 状态；只有验证过的映射才进入渲染。
- 资源和数学采样器使用原时间单位。播放器当前明确采用 60 单位/秒的预览基准与确定性预览种子；没有声称已经与运行中的游戏时钟、全局随机序列或触发时机逐帧对齐。

验证命令：`node_modules/node/bin/node --import tsx tests/game-effects.test.ts` 与 `tsc --noEmit`。截至本页记录，7 项测试通过，包括 19 族 × 16 宽度引用、真实 AFB 分支、资源筛选、寿命边界、曲线/UV/透明度原函数对照及损坏文件拒绝。

## 混合状态核对

原函数 `0x6cd870` 返回 `0x18a6908 + mode × 32`，`0x129588b`～`0x12958bb` 分别应用 enable、operation、source、destination。节点 mode 在 `0x1294f00` 限制为 0～7。采样材质直接输出这些已确认状态，避免用普通透明混合绘制黑底加法贴图。

| mode | enable | source | destination | operation |
| --- | --- | --- | --- | --- |
| 0 / 1 | false | 原表 SRC_ALPHA | 原表 INV_SRC_ALPHA | ADD |
| 2 / 3 | true | SRC_ALPHA | INV_SRC_ALPHA | ADD |
| 4 | true | SRC_ALPHA | ONE | ADD |
| 5 | true | SRC_ALPHA | ONE | REVERSE_SUBTRACT |
| 6 | true | ZERO | SRC_COLOR | ADD |
| 7 | true | INV_DST_COLOR | ZERO | ADD |

TAP 火花与 reaction 的实际节点使用 mode 4。禁用混合的 mode 0/1 同时输出 `blendEnabled: false` 和 ONE/ZERO 的 RGB 兼容值。wrap 的原分支在 `0x1295190`：属性 300 前两词为 0 时分别 repeat，否则 clamp。依据文件位于本地 `out/effects-research/effect-blend-apply.asm`、`renderer-blend-apply.asm`、`node-blend-translate.asm`、`texture-state-binding.asm`。

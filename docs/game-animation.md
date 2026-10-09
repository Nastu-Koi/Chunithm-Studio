# 经典圆环动画：已解出的原始数据与预览边界

2026-10-09，从本机 `D:/chunithm/data/A000/stage/stage000001/st_label_basic_0001_yellowring.afb` 只读解码。该文件 SHA-256 为 `2e793272fed57c20074965c2e8ab3dc85fd4d7f11e86f44d5a5b205bfbba97a8`。原游戏和原资源未修改、未运行。

本轮实现为 `src/backend/game-animation.ts`（解析）和 `src/core/stage-animation.ts`（纯 TypeScript 采样）。`loadClassicStageAnimation(gameRoot)` 返回可序列化 JSON；所有播放数据可写进项目资源副本，采样器不读磁盘。JSON 中 `sourcePath` 为相对游戏根目录的来源记录。

## 已读出的资源关系

AFB 的 `AFRC` 表以其 chunk 起点为相对偏移原点，记录数据范围、原始路径与短文件名。它明确将圆环模型和十个独立 UVC 片段放在同一包中：

| 资源索引 | 名称 | AFB绝对偏移 | 字节数 |
|---:|---|---:|---:|
| 0 | st_00001_ring.svo | 17664 | 151296 |
| 1 | st_00001_ring_0.uvc | 168960 | 32768 |
| 2 | st_00001_ring_1.uvc | 201728 | 30464 |
| 3 | st_00001_ring_2.uvc | 232192 | 40192 |
| 4 | st_00001_ring_3.uvc | 272384 | 45824 |
| 5 | st_00001_ring_4.uvc | 318208 | 28544 |
| 6 | st_00001_ring_5.uvc | 346752 | 36096 |
| 7 | st_00001_ring_6.uvc | 382848 | 43520 |
| 8 | st_00001_ring_7.uvc | 426368 | 44672 |
| 9 | st_00001_ring_8.uvc | 471040 | 41856 |
| 10 | st_00001_ring_9.uvc | 512896 | 41088 |
| 11 | st_00001_grid.svo | 553984 | 47232 |

十段的自描述 `uva::SceneProperty` 都给出 `_frameNumber=901`、`_bQuaternion=true`、`_bIgnoreParentScale=false`、`_sceneNodeNumber=47`、`_transformAnimationNumber=37`、`_animationName=c3_yellowring_2`。名称一样，但曲线和起始姿态不同。不能把文件名序号自动解释为播放顺序。

## YABX 对象树与蒙皮

SVO 内的 YABX 带有类型表和字段大小。解析器根据这份内置 schema 顺序读取所有实例，并检查每个实例消耗的字节数与声明长度完全相等；引用还要符合目标对象类型。格式入口参考作者的 [SVO/YABX 研究](https://gzlxz190614.github.io/GekiChuMaiLocalizedDocument/Chunithm/Extra/svo/svo_format.html)，实际字段、数值、边界和引用以本机字节复核为准，未复制该项目代码。

已解出40个 `stevia::Node`，含父/子/兄弟引用、`_blendIndex`、缩放、四元数、平移、局部/世界/绑定矩阵。38个节点的 blendIndex 为0至37，其中36个实际被顶点使用。`root` 之下有六个 s315/s360 环节点及 `toge_root`，后者下有30个 box 节点。

顶点 declaration 明确给出 stride=28、count=4008，最后一个 element 为 semantics=1、type=8，占4字节。逐顶点读出的四个字节全部为 `[255, boneIndex, 0, 0]`；每个 boneIndex 都能映射到 `_blendIndex`。结合节点引用和绑定矩阵，这支持本模型的全权重单骨蒙皮，不需要猜测多骨权重。

矩阵按 row-major 3×4 存储，作用于列向量。局部矩阵以 `T·R·S` 构建，父世界矩阵左乘局部矩阵；蒙皮矩阵为 `world · bind`。例如 `box_1` 的 `_mtxBind` 把原模型坐标 `(0,70,0)` 送回 `(0,0,0)`。节点的 `_mtxWorldInv` 虽有名称，但本文件中多处仅存 identity 缓存；采样器**不使用它充当已经计算好的逆矩阵**。

## CVU/UVC 数据

UVC 外层头为 `CVU\0`。本轮十个文件都有6条256字节目录项；目录指向 YABX 元数据、版本20130903、NUL分隔名称表、节点表、float关键帧表与压缩关键帧表。每一块均以声明边界读取。

节点表为计数加47个172字节记录。前10个12字节描述符引用曲线，依次对应 translation XYZ、scale XYZ、quaternion XYZW。默认四元数以4个 int16 保存，平移和缩放为 float32。活动标志为1/2/4组合；未被活动组覆盖的属性继续使用原 SVO 局部姿态。

曲线有两种关键帧编码：

- 12字节：float32值、float32切线、uint16帧位置、uint16标志。
- 8字节：float32切线、int16值、uint16打包帧位置/标志；数值除以32767，帧位置取低14位，高2位为插值模式。

0.1.7 根据本地程序的 `0xe7c390` 分派、`0xe7c2a0` 压缩曲线采样和 `0xe7bd70` 分段函数，支持全部四种模式：0 为 Hermite；1 对输出切线取反后做 Hermite；2 保持前值；3 为按距下一帧剩余量计算的一帧混合。模式3忠实保留原函数的公式，不擅自按段长归一化。这些标志不是循环指令。

旋转由 `uva::AnimationBridge` 的 `0xe6e7d0` 处理：先在相邻整数帧取四元数，再按小数帧做最短弧 SLERP，并统一到 `w >= 0`。这与先对每个分量做小数帧 Hermite 再归一化并不相同。接口已更新为 `interpolation: 'uvc-native'`。

数值对照只在隔离的 x86 指令仿真器内调用上述数学函数及 `0xf27390` 四元数插值，不运行游戏入口、进程、网络或系统逻辑。测试夹具 `tests/fixtures/stage-sampler-native.json` 记录被检查程序的 SHA-256、函数地址和数值：40组标量用例覆盖四种模式，另有十个片段共300组实际旋转。纯 TypeScript 实现分别以 `2×10⁻⁶` / `3×10⁻⁶` 容差通过对照；不声称 JavaScript 与 x87/SSE 逐位一致。

## 播放接口

```ts
const animation = await loadClassicStageAnimation(gameRoot);
const matrices = sampleStageSkinMatrices(animation, clipIndex, frame);
const posed = transformStagePoint(
  matrices[animation.rig.vertexBones[vertexIndex]],
  originalVertex.position,
);
```

`frame` 使用源动画帧单位，采样钳在0至900，不自动循环。没有发现可证实每秒帧数的元数据，故 `framesPerSecond=null`。若界面用60帧/秒播放，这属于明确标出的预览时间基准。

单段模式保持原片段0至900帧的边界。经典舞台模式另外执行 AFNC 中已核对的编排：随机选片、800内部时间单位的线性位移和900单位后的同状态重建。重建会重选片段并重置位移，而非把十段按文件名连续拼接；父级矩阵和相机关系见 [AFNC 控制层研究](game-camera-decoding.md)。使用独立可回放随机种子，不声称与实机全部随机调用共享序列。

片段0的姿态范围示例：

| 原帧位置 | X/Y约束范围 | Z范围 |
|---:|---|---|
| 0 | 约±71 | -78.56..282.12 |
| 225 | 约±92.7 | -66.16..294.15 |
| 450 | 约±111.4 | -53.75..351.17 |
| 900 | 约±154 | -28.94..368.82 |

这些是模型自身蒙皮后的空间范围，尚未叠加 AFNC 舞台父变换。0.1.6 的单段预览使用 XY 适配；0.1.7 的经典舞台模式使用已核对的世界矩阵和背景相机。音符轨道相机与舞台背景相机分开处理，不能混用。

## 验证与尚未完成的部分

`tests/game-animation.test.ts` 检查 AFRC/UVC 边界、十段元数据、40节点 TRS、父矩阵组合、绑定坐标、关键帧、压缩时间位数以及上述340组原函数数值。TRS 与文件局部矩阵最大误差 `1.56×10⁻⁷`；全部节点父组合与源世界矩阵在 `1×10⁻⁴` 内。读取原文件的集成测试在原安装不可用时显式跳过，已复制资源和数学夹具的测试仍执行。

以上验证覆盖曲线与本模型骨骼采样，不能据此宣称完整舞台引擎已还原。AFNC 的内部时间与真实秒率、原引擎更新相位、材质/UV 动画及其余场景对象的行为须分别核验。浏览器数值精度、材质着色与原 GPU 渲染仍有差异。

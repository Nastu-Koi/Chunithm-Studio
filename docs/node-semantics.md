# CHUNITHM 长条节点语义核查

核查日期：2026-10-09。依据公开转换器的实际代码与用户本地 C2S，未运行原版游戏。公开链接指向 main，后续可能重构；以下用类／函数名定位，不把行号视为稳定接口。

## 已确认的文件语义

C2S 的每条长条记录描述一段：起点位置、持续时间、终点位置，以及**这一段终点**的节点种类。不能把记录的 D/C/X 后缀当成起点的显示开关。

| 长条 | 普通／动作终点 | 控制／无动作终点 | 影响范围 |
| --- | --- | --- | --- |
| SLIDE | `SLD`；EX 为 `SXD` | `SLC`；EX 为 `SXC` | 段末节点，保留整段轨迹与独立起头 |
| AIR HOLD | `AHD` | `AHX` | 段末动作，不能解释为整段消失或整段无判定 |
| AIR SLIDE | `ASD` | `ASC` | 段末动作；高度、宽度和位置变化仍存在 |

最直接的依据是 PenguinTools 的 [C2SChartConverter.Note.cs](https://github.com/ChuniPingu/PenguinTools/blob/main/PenguinTools.Chart/Converter/c2s/C2SChartConverter.Note.cs)：`ProcessAirSlide`、`ProcessAirHold`、`ProcessSlide`都用当前节点作记录起点，并用下一节点的 `Joint` 和时间作段末属性。

AHX 的完整映射可交叉核对：

- [MgxcParser.Note.cs](https://github.com/ChuniPingu/PenguinTools/blob/main/PenguinTools.Chart/Parser/mgxc/MgxcParser.Note.cs) 的 `ParseNote`／`ParseJoint`：AIR HOLD 的 Step/End 转为 D，Control/EndNoAct/CurveControl 转为 C。
- [Models/c2s/Notes.cs](https://github.com/ChuniPingu/PenguinTools/blob/main/PenguinTools.Chart/Models/c2s/Notes.cs) 的 `AirHold.Id`：AIR HOLD 的 C 写成 AHX，D 写成 AHD。
- [C2SParser.cs](https://github.com/ChuniPingu/PenguinTools/blob/main/PenguinTools.Chart/Parser/c2s/C2SParser.cs) 的 `ParseAirHold`：反向读取 AHX 为 C，同时保留持续时间和终点。

MuConvert 的 [UgcGenerator.cs](https://github.com/MuNET-OSS/MuConvert/blob/master/generator/chu/UgcGenerator.cs) `AppendFollowerLines` 也先累加段长，再在段末写 `c` 或 `s`。但其 [C2sGenerator.cs](https://github.com/MuNET-OSS/MuConvert/blob/master/generator/chu/C2sGenerator.cs) 把 AIR HOLD 的 `IsEx` 写成 AHX，与其解析器和以上映射不一致，不能单独用来认定 AHX 是 EX。

## 起头、连接与预览

SLIDE 的独立起头仍是可按的起头，首段为 SLC 不应把它藏掉。[Chunithm-Research 的 SLIDE 说明](https://github.com/beer-psi/Chunithm-Research/blob/main/Charting.md#slide) 明确提及独立 SLC 按 SLD 处理；同文把中间蓝点描述为外观差别。因此不能把“可见蓝点数”直接用作原版 SLIDE 判定总数。

AIR HOLD／AIR SLIDE 的 D 终点表示动作节点，C／X 终点表示控制或无动作节点。预览应保留控制段的带体与轨迹，不给控制终点制造普通动作条／动作音；这不等于删除持续判定。长条的独立起头、段末节点、持续状态应分别处理。

AIR 起头仍有待实机校准：转换器的 `HasAirArrow` 会独立输出 AIR（上述 `C2SChartConverter.Note.cs` 的 `ProcessAirHold` 与 `EmitAirArrow`），但本地统计同时满足 `T_NUM_AIR = T_NOTE_AIR + T_NOTE_AHD`。这支持 AIR 长条链还有隐含起头的解释，不能仅凭“没有显式 AIR 行”删去起头动作，也不能仅凭多条记录就叠加重复音效。

父类型也不是一律复制：SLIDE 使用通用 `SLD`，AIR HOLD 使用通用 `AHD`；AIR SLIDE 续段应保留前段实际 `ASD`／`ASC`。见 [C2SParser.cs](https://github.com/ChuniPingu/PenguinTools/blob/main/PenguinTools.Chart/Parser/c2s/C2SParser.cs) 的 `ParentTypeMatches`及转换器的 `previousSegment`。

## 本地样本与修复前复现

路径均在 `D:/chunithm/data/A000/music`；本次只读，未改动或复制整份谱面。

| 样本与行号 | 观察 |
| --- | --- |
| `music0067/0067_04.c2s:48` | SLC 从第 5 原生小节 tick 336 独立起头，随后接多个 SLC。修复前播放器隐藏该起头，音效时间表也漏掉它。 |
| `music0067/0067_04.c2s:812`、`:819` | AHX 从 tick 144 持续 141，在 tick 285 接 ALD；与无动作尾的映射相符，但单凭连接关系不足以证明全部判定行为。 |
| `music0063/0063_04.c2s:1106`、`:1110` | ASC 以 HLD 为父起头，后续 ASC 明确以 ASC 为父。修复前分割／接续会把后续父类型硬写成 ASD。 |
| `music2999/2999_01.c2s:872`、`:876` | AHD 之后接 duration 0 的 AHD。修复前播放器忽略零长度续段，重复绘制前段尾与零长度节点；音效的续段判断与播放器不一致。 |

另实读 `0067_04`：`T_NOTE_AIR=137`、`T_NOTE_AHD=74`、`T_NUM_AIR=211`；`2999_01` 对应为 39、54、93。统计字段的完整计数算法未在本次审计中复现。

## 编辑与回归要求

- 明确提供“普通／动作节点”和“控制／无动作节点”，并标明编辑的是段末。不能只叫“显示节点”。
- 插入节点应改变前半段的终点种类；后半段保留原来的终点种类。接续也应明确原尾变连接节点后的种类。
- Windows 集成覆盖：独立 SLC 起头；普通节点与控制节点交替的 SLIDE；AHD→AHX 与 ASD→ASC；ASC 接续父类型；零长度 AHD 末端；保存、重开、导出后的原生标签与父关联。
- 图形与声音使用同一套节点解析结果，检查共享节点不会重复显示／播放；控制点不产生额外动作音，同时带体保持连续。

本次确认的是文件的节点归属和转换行为。原版的持续判定间隔、碰撞窗口、隐含 AIR 起头与显式 AIR 的重叠规则、音效是否合并，以及特殊重复／分叉长条的执行效果仍未实机验证；自动预览不能据此宣称与原版逐判定等价。

## 0.1.10 SLC 贴图分隔修复

用户截图指出 SLC 连续曲线出现重复紫色横带。复现确认控制节点没有多画普通节点模型；原因是每条 C2S 记录分别把整个 SLIDE 图集从 1 取到 0，因此隐藏节点仍重复出现贴图首尾。修复让一个普通节点到下一个普通节点之间的 SLC 段共用 UV 区间；控制点处连续，SLD 终点保留原蓝色横条并重置下一段的贴图区间。

分支归属复用计分模块的原生记录顺序与当前尾消费逻辑，不按同坐标合并全部重叠长条；SLD/NCL 保持独立。测试覆盖变 BPM、反向滚速、控制尾、多个重合分支、普通点保留。计分和导出的标签不改变。Windows 图像回归以并排六段 SLC / SLD 曲线检查，预期分别为 2 条起止横条与 7 条普通横条。

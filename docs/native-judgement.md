# 原生 AUTO 判定与计分核对

核对日期：2026-10-09。实现位于 `src/core/judgement.ts`。这是依据用户本地原生 C2S 的可重复统计及原程序静态反汇编实现的判定模型；没有运行或修改原程序，也未完成逐帧原游戏计分录像比对。分类数量相同不能证明每个持续判定的时间、显示取整和特殊关卡规则完全相同。

## 依据及证据边界

- SEGA 的[开发者访谈第 9 节](https://info-chunithm.sega.jp/2088/)说明全 JUSTICE 基础分为 1,000,000，JUSTICE CRITICAL 另有 1% 加分，满分 1,010,000。该说明没有公开持续判定的生成算法或中途显示取整方式。
- [PenguinTools 的 C2SJudgeSummaryCalculator](https://github.com/ChuniPingu/PenguinTools/blob/main/PenguinTools.Chart/Writer/c2s/C2SJudgeSummaryCalculator.cs)将 Damage、Hold 头和 Slide 根计入 TAP，提供长条计数参考。其部分方法明确称为 Proxy；本项目没有将它当作原游戏算法，也没有直接复制其实现。
- [Chunithm-Research 原作者文档](https://github.com/beer-psi/Chunithm-Research/blob/main/Charting.md)记录 C2S 类型、PROGJUDGE 字段、MNE 避让及 ALD interval 的基础含义，并明确说明部分内容来自推测。该文档不能单独证明完整计分规则。
- [节点语义核对](node-semantics.md)记录了 AHD/AHX、ASD/ASC、SLD/SLC 作用于段末的解析与转换证据。
- SLIDE/AIR 关联及教学规则已从本地 `chusanApp.exe` 的 ScoreReader 和判定生成分支获得直接证据，见 [原生读取顺序](native-judgement-reader.md) 和 [教学／AIR 边界核查](judgement-edge-research.md)。
- 本次计数的全库验证使用 `/mnt/d/chunithm` 中实际启用的 8,205 张谱面。通过曲库扫描解析基础数据及 OPT 覆盖关系；8,193 张带有原生 `T_JUDGE_*` 统计，12 张没有该组统计。原谱只读，不放进仓库或发布包。

## 独立计算接口

`buildJudgementTimeline(chart)` 从音符、BPM 和 PROGJUDGE 参数生成有序判定点、五类数量、总数及诊断，按不可变 Chart 对象缓存。每帧的 `getAutoScoreAtTick(timeline, tick)` 仅二分查找，支持向前、向后定位和中途开始。

计算结束后才读取 `T_JUDGE_TAP/HLD/SLD/AIR/FLK/ALL` 作对照。原统计不会成为分母、补点依据或重分配权重。修改音符、事件、分辨率、版本或头部后，旧统计只作过期参考。没有统计的原创工程仍按实体独立计算。

`getC2SEntityOrder(chart)` 是序列化器与判定模块共享的实体顺序：原谱未改动时依照原始 records；新建或改变实体后稳定按 tick 排序，同刻保留实体顺序。分数 tick 不在此步骤量化；导出量化仍必须单独确认。

当前 AUTO 记分值为 `floor(1,010,000 × 已到达判定数 / 总判定数)`。这是全 JC 的显示模型；未声称已验证原游戏中途每一分的取整顺序。成功避让 DAMAGE 会产生 `avoid` 判定，不播放主动点击音。

`points` 的每项包含 tick、noteId、分类和 head/sustain/end/crush/avoid。CRUSH 的 noteId 指向命中位置实际所属的几何段，共享边界归后段，末点归最后一段，方便画面和音效共用同一时间表。

全谱最多生成 250,000 个判定点。超限明确标为 unsupported，报告时间表已截断，不能冒充完整总数；限制用于防止极长 WE 或过小 interval 分配无限内存。

## 已验证的计算结构

| 原生类别 | 计入的实体与处理 |
| --- | --- |
| TAP | TAP、CHR/EXTAP、MNE 的成功避让、HOLD/HXD 头、SLIDE/SXD 真正的链头 |
| FLK | 每个 FLK 一个判定 |
| HLD | 按逐点 BPM 生成持续判定，尾部附 AIR 时裁去释放窗口 |
| SLD | 正常 D 尾节点划分持续段，C 为控制节点；同链 AIR 释放窗口可跨越此前正常节点 |
| AIR | 独立 AIR、AIR-HOLD/AIR-SLIDE 链头、正常 D 末端动作、持续判定、ALD/CRUSH 间隔判定 |

默认 RESOLUTION 384、PROGJUDGE_BPM 240 时，BPM 120–239.999 的基本持续间隔为 48 tick，60–119.999 为 24 tick，240–479.999 为 96 tick。实际间隔用 `floor((resolution/4) × 2^floor(log2(BPM/PROGJUDGE_BPM)))`，至少 1 tick，至多 resolution。每一步重新读取该步起点的 BPM；连续密度积分或全程固定初始 BPM 不能复现变速谱的原始数量。

本地所有原生分辨率均为 384，因此“上限随 resolution 变化”是工程推广，只有 384 的原生上限被实谱验证。非默认 PROGJUDGE_BPM 已发现 480、1200、7.5；相应 WORLD’S END 谱也纳入测试。PROGJUDGE_AER 所有本地样本均为 0.999，其他取值仍明确降级。

HOLD：从起点逐步推进，保留首次到达或超过尾部的候选点。没有尾 AIR 时最后一点夹到尾部；有尾 AIR 时，恰好到尾删最后 1 点，越过尾删最后 2 点，最少为零。尾 AIR 与当时已读入的地面根按原程序创建顺序、当前尾位置、宽度和父类型关联，每个根只接收一个 AIR 起头。

SLIDE 的 AIR 释放窗口按候选点自身的下一间隔判断：当同链点 `p.tick <= AIR.tick` 且 `p.tick + intervalAt(p.tick) > AIR.tick` 时取消这个 SLD 判定。该窗口也适用于挂在中间控制点的 AIR，不取消链头 TAP。重叠链按 ScoreReader 的顺序重建：续段只匹配当时的当前尾端，优先较早创建的地面根；已延长的旧几何段不再作为 AIR 父候选。第 8 列是 `SLD/NCL` 两值枚举，其他字符串（包括少数原谱中的 `SXD`）回落到 `SLD`。不能按任意原始字符串拆根。

AIR-HOLD / AIR-SLIDE：正常 D 尾产生动作，C/X 尾没有动作；中间控制点不重新产生链头。持续段从上一正常节点或链头开始，逐点推进并剔除末尾动作窗口。正常尾保留候选数量减 2；控制尾对超出段尾的候选再多减 1。AIR 续段同样按照最早地面父根的创建顺序匹配，不能按照 AIR 起头时间或尾端加入队列的顺序匹配。正常／控制、位置、宽度和高度参与匹配，颜色不参与原程序这个连接条件。此为原统计支持的计数规则，具体窗口时间仍待原游戏逐帧验证。

AIR-CRUSH：连续几何段在尾/头 tick、位置、宽、高、颜色、interval 都相同时连接，并保留根段的 interval 相位；不能在每一段重打起点。interval 为零仅有视觉形状，没有判定。ALD 链与其他 AIR 长条独立，不凭接近位置将它们合并。

教学：当 `TUTORIAL > 0` 时，附有 AIR/AHD/ASD 的地面根禁用整个地面持续判定向量，保留头部。SFL 速度为零的开区间内，长条 sustain/end 判定禁用，区间边界保留。该分支不作用于普通谱，CRUSH 没有被套用未证实的冻结规则。

## 可重复测试

```sh
node_modules/node/bin/node --import tsx tests/native-judgement.test.ts
node_modules/node/bin/node --import tsx scripts/audit-native-judgement.ts --game-root=/mnt/d/chunithm --verify-roundtrip=true --output=out/native-judgement-audit.json
```

合成测试覆盖尾 AIR、D/C 区别、一对一关联、CRUSH 曲线共享相位、分段 BPM、超高 BPM、PROG 参数、旧统计失效和全局上限。原生代表测试只在本地文件存在时运行；包含低 BPM、原生普通谱、现代 AIR/CRUSH、变速、PROG 特殊 WE 和大量 MNE。

Windows 集成用 Kaleidoscope `2892_03`：独立计算得到 TAP 1471、HLD 94、SLD 153、AIR 301、FLK 36，总数 2055，与原始五类统计及 ALL 全部一致。先前的 2078 是长条分段和动作窗口错误，已修正。

## 最终全库结果

实际模块的最终审计于 **2026-10-09 12:00:50 UTC** 完成，重新调用曲库扫描，没有沿用旧测试路径清单。全部 **8,205 张**启用谱面读取和计算成功，文件处理错误为 **0**，同趟检查的 **8,205 张 C2S 均保持逐字原样往返**。8,193 张具有原统计，其中 **8,192 张五类数量及总数全部一致**，仍有 **1 张不一致**；12 张无统计，不能据此认定等价。

| 分类 | 与原统计一致 | 存在差异 |
| --- | ---: | ---: |
| TAP | 8192 / 8193 | 1 |
| HLD | 8193 / 8193 | 0 |
| SLD | 8193 / 8193 | 0 |
| AIR | 8193 / 8193 | 0 |
| FLK | 8193 / 8193 | 0 |
| ALL | 8192 / 8193 | 1 |

与初版 0.1.6 的 8,137 张全部匹配相比，本轮修复 55 张，未让任何原本匹配的谱面回退。53 张 SLIDE 差异全部消失，教学 `0050_00` 及 AIR 边界 `2033_03`、`2652_02` 全项匹配；部分分类差异发生在同一谱面。

唯一剩余为 `2477_01`：TAP 计算 452，原统计 456；ALL 计算 1201，原统计 1205。SLIDE 持续数量 611 已准确，但重建 72 个地面根与原 `T_NOTE_SLD=76` 不同。缺失可分为普通头 1、EX 头 3，尚无足够证据确定是额外规则还是原统计／生成过程差异，因此没有按原总数补点。详见 [剩余差异表](native-judgement-residuals.md)。

正式报告为 `out/native-judgement-final-audit.json`，`out/native-judgement-audit.json` 同步为该结果；原基线保存为 `out/native-judgement-v0.1.6-baseline.json`。39 项判定测试、5 项独立边界测试全部通过；核心测试 24 项通过、1 项既有可选本地谱测试跳过，TypeScript 检查通过。日志分别是 `out/native-judgement-native-roots.tap`、`out/native-judgement-edge-tests.tap`、`out/native-judgement-core-regression.tap`。

这些结果证明目前计数模型的覆盖程度，不等同于逐时刻原生计分和完整原游戏运行已验收。

## 尚未证实

- `2477_01` 的 4 个 TAP 差异仍未确定原因；不按曲号硬编码补偿。
- 未知 C2S 记录会标为 unsupported。无原生父音符的 AIR 保留独立预览但标为 unsupported；非默认 AER 和原统计不符会显示诊断。
- 即使分类全部一致，长条目前仍标为 estimated，保留“持续判定时间尚未完全核查”的说明。原游戏逐帧判定时刻、AUTO 显示取整，以及特殊模式的血条/技能均不能由 `T_JUDGE_*` 总数证明。
- 实谱统计只用于验证读入时的原始状态，不将原曲的结果灌入新建或修改后的谱面。

# 原生打击音：触发规则、音量、音高、包络与同时发声数

核对日期：2026-10-12。实现位于 `src/backend/game-audio.ts`（读取）与 `src/renderer/transport.ts`（播放）。依据是本机只读的 `D:/chunithm/data/sound/chu.acb`、`chu.acf`、`chu.h`、`chu_acf.h`、`data/db/*.bin` 数据表，以及对 `bin/chusanApp.exe` 的静态反汇编；没有启动、注入或修改游戏。

## 症状与原因

连续 FLICK、ExTAP 有轰隆声，HOLD / SLIDE 节点刺耳。各音效的波形都很长：FLICK 3.0 秒、HOLD / SLIDE 2.5 秒（两层）、AIR 3.1–3.3 秒。音效库给它们设了同时发声数限制，游戏里后一声会取代前一声；程序原先没有读这项限制，每一声都把整条尾音放完，密集段落里几十条尾音叠在一起。各级音量也没有读，音效之间的相对响度与原版不同，而且总线直连输出，叠加后会削波。

## 已确认并实现的命令

| 命令 | 含义 | 依据 |
| --- | --- | --- |
| 111 | 总线发送量（名称索引，0–10000） | 公开资料 [XV2-Tools `ACB_File.cs`](https://github.com/LazyBone152/XV2-Tools/blob/master/Xv2CoreLib/ACB/ACB_File.cs) 的 `VolumeBus`；原已实现 |
| 79 | Cue 的同时发声数，第一个 16 位值 | 同上，`CueLimit` |
| 87 | 音量，百分比 | `chu_acf.h` 给分类 `SE_Game` 的注释是 “Volume0.75”，该分类在 ACF 里的命令正是 87，值 75；`Voice` 分类同理为 120 |
| 65 | 所属分类，若干 32 位索引 | 每个打击音读出的索引与 `chu_acf.h` 的分类编号逐一对应：TAP 为 `SE`、`SE_Game`、`VolumeOptions_Tap`、`Limit_Tap`，HOLD 为 `…Hold`、`Limit_HoldSlideCritical`，依此类推 |
| 73（ACF 分类命令） | 分类的同时发声数与工作区编号 | 只出现在 `Limit_*`、`Ducking_*`、`Voice_*` 等分类上，第二个值恰好取遍 ACF 的 10 个 `CueLimitListWorks` |

总线取 `DspBusSetting_0`：`chusanApp.exe` 里只有这一个设置名的字符串。其中 `Phone_1pass` 的音量是 0.5，只带一个 257 字节参数的效果器（1 字节加 8×8 个浮点，是声道矩阵），再全量送往 `MasterOut`，这条路上没有压缩或限幅。

读出的结果（耳机路由，音量为各级相乘：总线发送 × Cue / 音轨音量 × `SE_Game` 0.75 × `Phone_1pass` 0.5）：

| 音效 | 音量 | 发声数限制 |
| --- | --- | --- |
| TAP `se_touch_tap_jcritical` → `…_action` + `se_touch_tap_loop_action` | 0.57 + 0.11 | 三个 Cue 各 1；分类 `Limit_Tap` 1 |
| ExTAP `se_touch_chara_laser`（与 TAP 同时） | 0.37 | Cue 1 |
| FLICK `se_touch_flick_jcritical` | 0.30 | Cue 1 |
| HOLD / SLIDE 起点 `…_loop` → 循环音 + `se_touch_tap_jcritical_action` | 0.34（0.1 秒内从 0.13 倍渐入）+ 0.57 | 循环音 Cue 4；TAP 采样同上 |
| HOLD 终点 / SLIDE 节点 `se_touch_hold_jcritical` / `…slide…` | 0.30 × 2 层 | 分类 `Limit_HoldSlideCritical` 1，两者共用 |
| AIR 上 / 下 `se_air_cut_up` / `…down` | 0.45 / 0.41 | Cue 1 |
| AIR HOLD 起点 / 循环 / 动作 `se_air_hold_in` / `se_air_hold_loop` / `se_air_hold_beat` | 0.375 / 0.41 / 0.30 | Cue 1 / 4 / 1 |
| AIR CRUSH `se_air_cut_break` | 0.43 × 2 层 | Cue 1 |

播放端按限制键（`cue:<名称>`、`category:<名称>`）记录正在发声的音，超出上限时让最早的一声进入释音。经动作轨启动的音效各自成组，限制只停本组：后来的 TAP 会顶掉 HOLD 起点的 TAP 采样，但不会停它的循环音。

## 触发规则：哪种音符播哪个音效

依据是 `chusanApp.exe`（32 位，未加壳）的静态反汇编和 `data/db/*.bin` 数据表。地址是该文件的虚拟地址，便于复查。

游戏把音效播放器分成 51 个声道（`SoundChTableRecord.bin`），代码里用的音效编号是 `SoundCue0TableRecord.bin` 的行号，表里写着它对应的 Cue 名称和编号。各音符类（`projView::TapNote` 等，类名来自程序里的类型信息）的发声函数如下：

| 音符类 | 函数 | 播放的音效 |
| --- | --- | --- |
| `TapNote`、`CharaTapNote`（ExTAP） | `0xc41680` → 判定音函数 `0xc3f970`，种类 0 | `se_touch_tap_<判定>` |
| 所有音符共用的判定处理 `0xc404b0` | ExTAP 成功时，声道 24（`FixSE_Charatap`）、音量项 `ExTapVolume` | `NotesCharaEffectTableRecord.bin` 第 8 列的音效，8 行全是 48 号，即 `se_touch_chara_laser` |
| `HoldNote` 起点 | `0xc4f480` | `se_touch_hold_<判定>_loop`；长度不超过 6 帧（0.1 秒）时改播 TAP 判定音 |
| `HoldNote` 终点 | `0xc4ddd0`，种类 1，时间到达终点后播一次（有“已发声”标记） | `se_touch_hold_<判定>` |
| `SlideNote` 起点 | `0xc34d60` | `se_touch_slide_<判定>_loop`；同样有 6 帧的下限 |
| `SlideNote` 之后的节点 | `0xc31f90`，种类 2，逐节点检查，只有带标记的节点发声 | `se_touch_slide_<判定>` |
| `FlickNote` | `0xc444b0`，种类 6 | `se_touch_flick_<判定>` |
| `AirNote` | `0xc424d0`，声道 4 | 方向 0–2 为 `se_air_cut_up`，3–5 为 `se_air_cut_down`，不分判定 |
| `AirHoldNote`、`AirSlideNote` | 起点 `0xc479e0` / `0xc4bee0`，声道 4 加一个循环声道；动作 `0xc46320` / `0xc4a340`，种类 7 | 起点 `se_air_hold_in` 加 `se_air_hold_loop`，每个动作 `se_air_hold_beat` |
| `AirLadderNote`（AIR CRUSH，谱面记号 ALD） | `0xc35d70`，种类 9 | `se_air_cut_break` |

判定音函数 `0xc3f970` 用三张表：`0x1914dd0`（种类 × 判定 → 组）、`0x1c1e8a0`（组 × 判定 → 声道）、`0x1c1e948`（组 × 判定 → 音效）。判定取 `NotesJudgeResultTableRecord.bin` 的 0–4（Miss、Attack、Justice、Justice Critical、Heaven）。预览固定用 Justice Critical 一档。

HOLD 的起止时间是 `HoldNote` 的 `+0x118` 和 `+0x11c`（谱面毫秒 × 0.06，单位是帧）；起点函数拿 `+0x11c` 减当前时间与 6.0 比较，终点判定音在当前时间不小于 `+0x11c` 时播。

由此改正了四处原先的映射：

- **TAP** 原先直接取 `se_touch_tap_jcritical_action`。游戏播的是 `se_touch_tap_jcritical`，它自身没有波形，靠两条动作轨启动 `…_action` 和 `se_touch_tap_loop_action`，50 毫秒后把两者都停掉，只剩释音。
- **ExTAP** 原先取 `se_touch_chara_fire`。游戏播的是 TAP 判定音加 `se_touch_chara_laser`；`chara_fire` 在音符代码里没有被引用。
- **AIR HOLD / AIR SLIDE** 原先取 `se_air_hold_jcritical`，音符代码里同样没有引用它。起点是 `se_air_hold_in`，动作是 `se_air_hold_beat`。AIR CRUSH 原先没有音效，现在是 `se_air_cut_break`。

- **HOLD / SLIDE 的起点** 原先播 `se_touch_hold_jcritical` / `…slide…`。游戏在起点播的是 `…_loop`：它启动整条 TAP 采样（不在 50 毫秒后停止）和一条循环音，循环音持续到长条结束。`se_touch_hold_jcritical` 在 HOLD 的终点播，`se_touch_slide_jcritical` 在 SLIDE 起点之后的各节点播。

SLIDE 的控制点不发声、AIR 上下的区分，这两条与原先的做法一致，没有改。

AIR HOLD / AIR SLIDE 的起点与同一位置的独立 AIR 音符是两个音符对象，各走各的发声函数，游戏代码里没有互相抑制的判断。预览也是各播各的：AIR 播 `se_air_cut_up` / `…down`，长条起点播 `se_air_hold_in` 加循环音（`getChartHits` 的起点取自判定时间表，每条 AIR 长条链都有自己的起点）。两者挂在同一个地面音符上的谱面，判定时间表会标为不支持，但声音仍然都播。

## 循环音

`se_touch_hold_loop`、`se_touch_slide_loop`、`se_air_hold_loop` 的波形带循环点（`WaveformExtensionDataTable`），释音 500 / 350 毫秒，Cue 上限 4。预览里从起点开始循环，到长条结束（SLIDE 与 AIR 取整条链的末端）时进入释音；从长条中间开始播放时只接上循环音，不重播起点。暂停、跳转和循环区间的末端都会停掉它。

### 同时起音的循环音会错开

这三个 Cue 的序列类型是 6，带四条波形相同的音轨，后三条各多一条命令 71（数值 10、20、30，范围 1）。

- **类型 6 是连发序列。** 选音轨的函数在 `0x137999b`，播放前调用：序号加一，超过音轨数就回到命令 94 的回绕音轨；随后如果距同一 Cue 上一次启动超过“连发时间 × 1000”微秒，序号归零。时间取运行库的微秒时钟 `0x1cea168`。命令 94 的处理在 `0x13597b7`：前 4 字节是连发时间（毫秒），接着 2 字节是回绕音轨，后 8 字节由运行库回写上一次启动的时刻。三条循环音都是 30 毫秒、回绕到第一条。公开头文件 `cri_atom_ex.h` 的 `CriAtomExAcbCueType` 里 6 也正是 `COMBO_SEQUENTIAL`。
- **命令 71 是预延迟。** 处理在 `0x1359455`：按“数值 ± 范围”在 0–60000 内取一个随机数，加到内部参数 0x8e 上；公开接口里写 0x8e 的是 `0x13310eb`，范围检查 0–10000，按名称顺序排在 `SetPitch` 之后，对应 `criAtomExPlayer_SetPreDelayTime`（毫秒）。

合起来：同一个循环音在 30 毫秒内再次启动时，依次晚 10、20、30 毫秒（各 ±1 毫秒）起音，第五个回到不延迟；隔得更久就从头算。两条同时开始的 HOLD 因此不会把同一段波形完全重合地叠成一声更响的。预览照此处理，各音轨的内容若不只差在延迟上，则只取第一条并在警告里列出。

### 带通滤波

HOLD / SLIDE 的循环音和 `se_touch_tap_loop_action` 的音轨带命令 32，数值 `0000 20d0`。处理在 `0x1358dcc`：第一个值（有符号）和第二个值各乘 0.0001，写进滤波参数的低切和高切；负的低切表示整条命令无效。换算函数 `0x1343c8b` 把 0–1 映射到 24–24000 Hz 的对数轴（`2^((x × 2.17358 + 1) × 4.58496)`，即 `24 × 1000^x`），取值函数 `0x1345f2a` 的默认值是低切 24、高切 24000，与公开文档对 `criAtomExPlayer_SetBandpassFilterParameters` 的说明一致。各级之间低切按 `1 − (1 − a)(1 − b)`、高切按相乘合并（`0x1344208`）。

所以这几条循环音是高切 0.84，即约 7947 Hz 的低通；`se_air_cut_break` 第一层的低切 0.25 约为 135 Hz。预览用二阶、无谐振的低通 / 高通实现。**滤波器的阶数没有读到**（参数经虚函数交给声部，后面的系数计算没有定位），这是这一项里唯一靠推定的地方。

### 随时间变化的音量

挂在序列或音轨上的 AISAC（`LocalAisacs`）的控制编号都是 2000 + 自身序号，类型为 1。运行库自己驱动它们：音序更新函数 `0x1352579` 每次更新都把参数“2000 + 序号”设成该部分已播放的毫秒数（`0x1352817`、`0x1352a98`，时间累加时乘 0.001 把微秒换成毫秒）；序号在建立音序实例时由 `0x1379546` 从 AISAC 列表里取类型为 1 的那一个，顶层启动和子音轨启动都走这个函数。所以这些 AISAC 的曲线横轴是毫秒，不需要游戏代码去设。

曲线类型的编号与公开头文件的 `CriAtomExAisacGraphType` 相同，配置文件可以印证：音量选项（`TapVolume` 等）用的是类型 1，耳机音量用类型 11，而 `BusNameIndexListForAisacGraphType` 的第 4 项正是 `Phone_1pass`（类型 7–14 是 8 条总线的发送量）；类型 41、42 的数值是 20、140、450 这样的毫秒数，对应包络的起音和释音。

| 音效 | 曲线 | 处理 |
| --- | --- | --- |
| `se_touch_hold_loop`、`se_touch_slide_loop` | 音量：0 毫秒 0.13 → 33 毫秒 0.14 → 57 毫秒 0.28 → 83 毫秒 0.51 → 101 毫秒 1.0 | 已套用。循环音在 0.1 秒内渐入，起点先听到的是 TAP 采样 |
| `se_touch_tap_loop_action` | 音量：0 毫秒 0.05 → 100 毫秒 1.0，第二个点的曲线类型为 1 | 已套用，按线性；TAP 判定音 50 毫秒就停，这一层只到一半音量 |
| `se_touch_chara_laser` | 发送量：`SE_Main` 62–250 毫秒从 1 降到 0，`SE_Sub` 47–334 毫秒从 0 升到 1 | 只动两条扬声器总线，耳机路由不受影响 |
| `se_touch_tap_jcritical_action` | 释音时间 500 毫秒 | 与包络命令给的数值相同，没有差别 |
| `se_air_cut_break` | 释音时间 15 毫秒 | 没有套用：它与包络如何合并没有核对。预览里被取代时淡出 20 毫秒，差别很小 |

`se_air_cut_up` 的一条音轨带“333 毫秒后到 1167 毫秒淡出”的音量曲线，但那条音轨在耳机路由上发送量为 0，听不到。超过曲线最后一个点之后保持末值，这一点是按常理推定的。

## 音高、包络与动作轨

公开资料没有这几条命令的含义，改从游戏内置的 CRI Atom 运行库核对。运行库的命令解释器在 `0x13584a5`（按命令码查 `0x135a287` 的跳转表），每条命令把数值写进一个内部参数；公开接口 `criAtomExPlayer_Set…` 写的是同一批内部参数，两边对上就能确定含义。

| 命令 | 内部参数 | 对应的公开接口 | 数值 |
| --- | --- | --- | --- |
| 87 | 0 | `SetVolume`（`0x133175c`） | 百分比 |
| 71 | 0x8e（累加） | `SetPreDelayTime`（`0x13310eb`） | 毫秒，随机范围 |
| 32 | 滤波参数的低切、高切 | `SetBandpassFilterParameters` | 万分比，0–1 对应 24–24000 Hz 的对数轴 |
| 94 | 序列的连发时间与回绕音轨 | —— | 毫秒，音轨序号 |
| 5 | 3 | `SetPitch`（`0x1330f4c`，带报错文字 “Pitch should not be modified…”） | 有符号，音分 |
| 121 | 4 | `SetMaxPitch` | 有符号，音分；只是声部的音高上限 |
| 36 | 0x7b–0x7d | `SetEnvelopeAttackTime` | 毫秒，曲线类型，曲线强度 |
| 37 | 0x7e | `SetEnvelopeHoldTime` | 毫秒 |
| 38 | 0x7f–0x81 | `SetEnvelopeDecayTime` | 毫秒，曲线类型，曲线强度 |
| 39 | 0x82 | `SetEnvelopeSustainLevel`（接口检查范围 0–1） | 万分比 |
| 40 | 0x83–0x85 | `SetEnvelopeReleaseTime` | 毫秒，曲线类型，曲线强度 |

包络五个接口在程序里按名称字母序相邻（`0x1330668` 起：Attack、Decay、Hold、Release、Sustain），写入的内部参数依次是 0x7b、0x7f、0x7e、0x83、0x82，正好是起音、保持、衰减、延音、释音的顺序；延音一项还有 0–1 的范围检查。命令 121 的依据是间接的：凡带它的声部，数值都等于各级命令 5 之和（TAP 默认音色 200、Kick 200 − 300 = −100、FLICK 500），和为 0 的音色没有这条命令。

动作轨的命令码取自公开资料：7100 播放、7101 停止，目标写在 `ActionTrackTable`；2001 是等待（毫秒）。

套用后的结果：

| 音效 | 音高 | 包络 |
| --- | --- | --- |
| TAP `se_touch_tap_jcritical_action` | +200 音分 | 50 毫秒后停止，释音 500 毫秒 |
| FLICK | +500 音分 | 无 |
| AIR 下 | +200 音分 | 释音 500 毫秒 |
| AIR CRUSH | +100 音分 | 无 |
| HOLD / SLIDE 第一层 | 0 | 保持 20 毫秒，100 毫秒内衰减到 0.4，释音 500 毫秒 |
| HOLD / SLIDE 第二层 | 0 | 保持 20 毫秒，130 毫秒内衰减到 0.1，释音 500 毫秒 |

HOLD / SLIDE 原先整条 2.5 秒尾音都按满音量播放，这是它们刺耳的直接原因。

## 未套用的部分

- **命令 31**（`se_air_cut_break`，双二阶滤波：类型、频率、Q、增益四个值，运行库里有对应的四个写入函数，但各值的单位没有核对），以及 11（`se_touch_chara_laser`，数值乘 0.1 写进内部参数 5）、82、99。
- **带通滤波的阶数**，见上文；按二阶处理。
- **曲线类型**只按线性处理。`se_touch_tap_loop_action` 的释音和音量曲线用了非线性类型。
- **超限时如何取代**。这里让被取代的一声进入它自己的释音（没有释音时间的淡出 20 毫秒），已经在释音中的不再打断。命令 79 的末字节是取代方式，各音效都是 0；运行库里超限后走哪条停止路径没有核对。
- **游戏内的音量选项**：`TapVolume`、`ExTapVolume`、`HoldVolume`、`AirVolume`、`FlickVolume` 由玩家设置决定（`PlayOptionJudgeSound*TableRecord.bin`，11 档，默认第 5 档 0.3）。各类默认档相同，所以没有折算进相对音量；播放栏的“打击音”滑块是它们之外的一个总音量。
- **DAMAGE**：`MineNote` 的 `0xc43810` 在两种情况下各播一个音效，哪种对应“躲开”没有读清，预览里仍不发声。

## 程序自己加的部分

- 整个混音末端有一个保护限幅：只在距满幅 1 dB 以内才起作用，音乐与打击音共用，所以它的预读延迟对两者相同。这不是游戏的总线效果。
- 打击音总音量滑块，默认 60%，存在本地设置里。

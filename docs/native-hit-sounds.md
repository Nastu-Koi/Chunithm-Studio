# 原生打击音：音量与同时发声数

核对日期：2026-10-12。实现位于 `src/backend/game-audio.ts`（读取）与 `src/renderer/transport.ts`（播放）。依据是本机只读的 `D:/chunithm/data/sound/chu.acb`、`chu.acf`、`chu.h`、`chu_acf.h` 和 `bin/chusanApp.exe` 里的字符串；没有启动、注入或修改游戏。

## 症状与原因

连续 FLICK、ExTAP 有轰隆声，HOLD / SLIDE 节点刺耳。各音效的波形都很长：FLICK 3.0 秒、ExTAP 1.5 秒、HOLD / SLIDE 2.5 秒（两层）、AIR 3.1–3.3 秒。音效库给它们设了同时发声数限制，游戏里后一声会取代前一声；程序原先没有读这项限制，每一声都把整条尾音放完，密集段落里几十条尾音叠在一起。各级音量也没有读，音效之间的相对响度与原版不同，而且总线直连输出，叠加后会削波。

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
| TAP `se_touch_tap_jcritical_action` | 0.57 | Cue 1；分类 `Limit_Tap` 1 |
| ExTAP `se_touch_chara_fire` | 0.27 | Cue 1 |
| FLICK `se_touch_flick_jcritical` | 0.30 | Cue 1 |
| HOLD / SLIDE `se_touch_hold_jcritical` / `…slide…` | 0.30 × 2 层 | 分类 `Limit_HoldSlideCritical` 1，两者共用 |
| AIR 上 / 下 `se_air_cut_up` / `…down` | 0.45 / 0.41 | Cue 1 |
| AIR HOLD `se_air_hold_jcritical` | 0.375 | Cue 1；分类 `Limit_AirHoldAttack` 1 |

播放端按限制键（`cue:<名称>`、`category:<名称>`）记录正在发声的音，超出上限时让最早的一声在 20 ms 内淡出。

## 未套用的部分

按“两处都对不上就不套用”的标准，以下保持原波形，并写进导入时的警告：

- 命令 5、82、121，以及 31 / 32（长度与数值像双二阶与带通滤波）、37–40（像包络的起音、保持、衰减、释音）。公开资料把它们列为未知，本次没有从 CRI 运行库核对换算，所以不套用。
- 超限时取代哪一声、淡出多久。这里取“取代最早的一声、淡出 20 ms”，是未经核对的取值；命令 79 的末字节和命令 40 可能与此有关。
- 动态 AISAC：`TapVolume`、`ExTapVolume`、`HoldVolume`、`AirVolume`、`FlickVolume`、`HeadphoneSEVolume` 等是游戏内的音量选项，取值由玩家设置决定。播放栏的“打击音”滑块是它们之外的一个总音量。
- 触发规则：SLIDE 中途节点是否发声、HOLD / SLIDE 按住期间的循环音（`se_touch_hold_loop` 等）、ExTAP 用 `chara_fire` 还是 `chara_laser`、AIR SLIDE / AIR CRUSH 用哪个音效。`chusanApp.exe` 里没有这些 Cue 的名称字符串，游戏按数字 ID 调用，本次没有定位到调用位置，映射保持原样。

## 程序自己加的部分

- 整个混音末端有一个保护限幅：只在距满幅 1 dB 以内才起作用，音乐与打击音共用，所以它的预读延迟对两者相同。这不是游戏的总线效果。
- 打击音总音量滑块，默认 60%，存在本地设置里。

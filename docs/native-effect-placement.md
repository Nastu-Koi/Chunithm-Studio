# 原始打击效果位置：已确认部分

本页只记录静态读取 `D:/chunithm/bin/chusanApp.exe` 得到的创建位置规则。二进制 SHA-256 与 [原生效果说明](native-effects.md) 相同；没有启动或修改原游戏。

`0xc404b0` 的 bomb 分支先复制调用方的 XYZ。在 `0xc40577` 调用 `0xb414f0(0, false, true)`，将 Z 设为原判定线常量 `-65`；随后 `0xc405ee`～`0xc4062c` 按效果族叠加表 `0x1c1e788` 的三浮点偏移。表共有 19 行，顺序对应 `NotesEffectTableRecord.bin` 的 19 个族：

| 效果族 | bomb 偏移 XYZ |
| --- | --- |
| Air、AirDown | `(0, 0, -30)` |
| AirHoldIn、AirHold、AirSlide、AirAction、Mine | `(0, 0, -40)` |
| 其它族 | `(0, 0, 0)` |

播放器已经将原判定线 Z=-65 映射为局部 Z=0，因此接入时只给 bomb 的局部 Z 加上表中偏移；再减 65 会重复移动。reaction、text 与 keep 没有经过这一 bomb 偏移分支，不能把同一偏移套到全部角色。

证据文件为 `out/effects-research/note-hit-effect.asm`、`effect-root-z.asm`、`effect-root-offsets.json`。原函数还存在玩家设置相关的额外 Z 分支，本页没有据此实现未确认的设置值。

创建包装 `0xb36350` 向内部 `0xb35e70` 传入 `(1,1,1)` 缩放；没有发现可支持统一缩小效果的依据。调用方的 Y、Acroarts 表的相机/图层关联，以及不同角色是否采用不同相机，尚未完成核对。这些未知项不能通过为了外观调整尺寸或高度来替代。

另外，`EscMaterial` 构造 `0x148c720` 将 property 101 的首词保存到 `+0x2c`，getter `0x148c820` 原样返回。原调用 `0x12b26ad`→`0x12b26bd`、`0x12b26e6`→`0x12b26f6` 将该值直接交给 `0x63d510` 解包并上传 shader 常量。当前基础颜色解包与该路径一致；这不能证明所有 RGB 动画的掩码命名和顶点布局，因此本轮只启用已核验的 alpha 动画。

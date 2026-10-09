# Margrete 界面参考

核查日期：2026-10-09。只依据 inonote 发布的文档和原图观察；未运行下载包。用户要求编辑器尽量接近 Margrete，下面区分原软件证据与本项目取舍。

## 来源与实际观察

| 一手来源 | 可确认内容 |
| --- | --- |
| [官网下载页](https://umgr.inonote.jp/en/docs/releases/) | 当前页面列出 Margrete v1.8.0。下载版本不能用来断言所有配图都来自该版本。 |
| [Margrete：画面要素](https://umgr.inonote.jp/margrete/getting-started/user-interface/)及[标注原图](https://umgr.inonote.jp/assets/images/mg-ui-ca9a5bbf98c88d039467104d46811cae.png) | 菜单与两排紧凑工具条在顶部，状态栏在底部；左侧 AIR 高度视图与纵向谱面共用时间方向，中间有小节标尺，时间事件在谱面旁。图中是中性深灰外壳、黑画布、细灰网格。图片标题可见版本 1.7.8.1。 |
| [官网主页](https://umgr.inonote.jp/en/)及[功能介绍原图](https://umgr.inonote.jp/img/feature-chart-editor.png) | 另一个官方示例使用浅色 Windows 工具条，说明不能认定 Margrete 只有一种主题。右侧停靠蓝色音频波形，底层谱面仍是黑色；长条有彩色半透明带体、中心线及细边框。 |
| [官方音符工具条图](https://umgr.inonote.jp/assets/images/mg-ui-notes-3f436c6cbd7bd92852aa6e572fba09c2.png) | 紧凑的彩色图标：红 TAP、黄 ExTAP、浅青 FLICK、蓝 SLIDE、橙 HOLD、绿 AIR、紫色 AIR 动作／控制图标；工具之间有细分隔线。 |
| [基本编辑](https://umgr.inonote.jp/margrete/getting-started/basic-edititng/) | 先选工具和音符，再点击插入；长条背景可插入中继／控制点；拖动调整位置与宽度；AIR 高度视图中的方形节点可拖动。 |
| [试听播放](https://umgr.inonote.jp/margrete/getting-started/preview/) | 红色光标是试听起点；Space 切换播放／停止，有变速播放工具条。 |
| [事件对象](https://umgr.inonote.jp/margrete/getting-started/event-objects/) | BPM、拍号、谱面速度、音符速度有各自事件；插入位置由编辑光标决定。 |
| [音频波形窗口](https://umgr.inonote.jp/margrete/userfuls/waveform/) | 波形用于音取与偏移调整，可停靠到谱面旁；并非主画布上的装饰背景。 |
| [快捷键](https://umgr.inonote.jp/margrete/userfuls/shortcut-keys/) | 官方分别提供编辑工具、音符、变形、播放快捷键；不能因为外观相似就声称本程序所有键位相同。 |

三张原图保存在 `docs/references/margrete-official-ui.png`、`margrete-official-feature.png`、`margrete-official-notes.png`，仅用于核查与注明来源，不作为程序的绘制素材或品牌资源。

## 本次实现对应

- 以文档的深灰标准布局为主：紧凑双工具条、直角／小圆角控件、黑底细网格、底部状态栏。颜色值是对官方截图的近似设计取值，不是从 Margrete 源码取得的主题常量。
- 音符用短条、箭头、带体及中心线表达，保留清晰的普通节点／控制点区别；编辑光标改为红线。
- 左侧增加实际 AIR 高度视图，方形节点与谱面共用时间轴；拖动节点调整 AIR SLIDE／CRUSH 的高度。高度范围随内容扩展，不截断工程数据。
- 保留音频波形的蓝色与独立区域；本次仍在左侧窄栏显示，未宣称实现 Margrete 的任意窗口停靠。
- 本程序仍以原生 C2S 为目标，保留右侧精确属性、WORLD’S END 参数、任意分音和原生标签。官网 FAQ 对非 1920 因数分音有限制；本项目已接受的分数精度不因此回退。[官方 FAQ](https://umgr.inonote.jp/margrete/faq/)
- 已有文件／导出／播放外壳由应用层处理；编辑器不放置没有实现功能的菜单。现有键位、拖动与选择操作保持兼容；这次没有声称完全复制 Margrete 的所有操作模式。

## 核查界限

依据是上述官网页面和截图。没有根据第三方视频猜测不可见菜单，也没有假称 Margrete 支持本项目的 C2S 导出、分数 tick 或 WORLD’S END 验收能力。视觉相近不等于格式兼容或原游戏判定一致。

## 0.1.10 实际编辑器资源

本次读取官方 [Margrete v1.8.0 发布包](https://umgr.inonote.jp/files/Margrete_v1.8.0_23b6ce2d.zip)，未执行其中的程序。`data/note_icons.png` 是 32×64 RGBA 图集，已原样复制为 `src/renderer/assets/margrete-note-icons.png`；来源、SHA-256 与行映射记录在相邻的 `margrete-source.json`。条形区域为 10×4，AIR 箭头为 12×8。编辑器的工具按钮和画布音符使用这张图集，SLIDE/HOLD 起头与普通末节点取不同原图区域。横向延伸保留两端像素，编辑选择框另画。

连续带体、网格和可操作的空心控制点仍由编辑器绘制；不把这些称为从 Margrete 导出的图形资源。控制节点默认没有横向分隔线，选中时才显示辅助线；SLC 的演示画面没有菱形编辑标记。原有官网截图继续仅作参考图，不作为绘制素材。

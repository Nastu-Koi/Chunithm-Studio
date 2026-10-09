# 经典舞台与 HUD 资源核对

本轮从本机 `D:/chunithm`（WSL 为 `/mnt/d/chunithm`）只读提取。原文件未修改，未启动原游戏。PNG 与解析后的顶点、索引和裁剪矩形已复制进项目 `assets/game`；播放器通过 `loadBundledGameResources` 读取副本。清单中的原路径、偏移用于追溯，不会触发运行时访问原安装。

## 经典舞台

`data/A000/stage/stage000001/Stage.xml` 明确给出：

- `name = (1, CHUNITHM)`，`releaseTagName = (0, v1 1.00.00)`。
- `notesFieldLine = (0, Orange)`。
- `notesFieldFile = nf_label_basic_0001_yellowring.afb`。
- `baseFile = st_label_basic_0001_yellowring.afb`。
- `objectFile.path` 为空；`enablePlate = true`。

这不是一张背景图。舞台由网格、圆环模型、材质和 AFB 动画组成。其 `CHU_UI_Stage_00001.dds` 缩略图实际是 **DUMMY 占位图**，因此未采用。另一个舞台 11 的 VERSE 文件虽有 1920×1080 背景图，但不是经典舞台，也未混入此副本。

`GameTextures.scene.materials` 保留以下角色。偏移是源 AFB 内 DDS 头的绝对字节偏移，尺寸取自 DDS 头。

| key | 源文件 | 原始名称 | 偏移 | 尺寸 |
|---|---|---|---:|---:|
| ringColor | st_label_basic_0001_yellowring.afb | st_00001_RingColor_df.dds | 47104 | 8×128 |
| grid | 同上 | st_00001_Grid_df.dds | 567936 | 256×256 |
| ringTail | 同上 | chu_st_basic_yellowring01_tail03_y_v10.dds | 601216 | 64×64 |
| ringOval | 同上 | chu_st_basic_yellowring01_oval02_y_v10.dds | 613632 | 128×128 |
| ringGradient | 同上 | chu_st_basic_yellowring01_grade01_y_v10.dds | 630144 | 8×512 |
| ringPoint | 同上 | chu_st_basic_yellowring01_point01_y_v10.dds | 646656 | 128×128 |
| notesField | nf_label_basic_0001_yellowring.afb | chu_nf_basic_yellowring01_mainfild_y_v10.dds | 22304 | 512×1024 |
| fieldSide | 同上 | chu_nf_basic_yellowring01_side_y_v10.dds | 1682464 | 32×512 |
| sideGlow | 同上 | chu_nf_basic_yellowring01_sideglow_y_v10.dds | 1617952 | 32×512 |

`fieldSide` 还在偏移 1595296 出现一次相同图像，存储按 PNG SHA-256 去重。名字来自 AFB 中的资源名字符串或嵌入 AVTS 目录；名称前的 `__HndToSvo__` 是原目录前缀。`ringOval` 是细长发光粒子，不能仅凭名称当成完整圆环照片；`grid` 是供重复采样的黑底边框纹理，不是天空图片。

可查看本地预览 `out/scene-research/classic-materials.png`。预览仅把原图片排列在深色底上，并未生成新的游戏素材。

### 原始几何

场景 AFB 中的 `AVTS` 容器使用 128 字节头、每项 1024 字节的目录。目录记录名称、种类、长度和相对位置。PNT 顶点为 24 字节（XYZ、打包法线、UV），PNTW 为 28 字节，另有 4 字节 attachment 值。保留 attachment 原值；0.1.6 已解析其单骨绑定，详见 game-animation.md。索引为 uint16 triangle strip，含连接不同条带的退化三角形。

| scene.geometry.meshes key | 源 VBO 偏移 | 顶点数 | 索引数 | 物体空间边界 |
|---|---:|---:|---:|---|
| ring | st…: 47744 | 4008 | 4451 | X ±84.638893，Y ±85，Z ±1 |
| grid | st…: 600832 | 8 | 11 | X ±5000，Y 约 ±1000，Z -10000..0 |
| notesField | nf…: 1603616 | 12 | 16 | X ±36，Y 约0，Z -470..0 |
| sideGlow | nf…: 1667232 | 88 | 94 | X 约 ±36，Y 约0，Z -470..0 |
| fieldSide | nf…: 1690784 | 8 | 11 | X ±36，Y 约0，Z -470..0 |

`notesField` 的最后四个顶点是内部轨道：X=-32..32，Z=-470..0。前八个顶点是两侧 X=-36..-32 与 32..36 的边带，所以**内部轨道宽 64，边带各宽 4**。`grid` 是 X=±5000 的两面墙，不能称为地板。浮点 Y 中约 1e-13 的误差按原样保留。

这些是物体空间坐标。它们不证明最终世界变换、相机位置、视场角或动画摆位。完整环网格可用于展示静态原始几何，但把它放入场景的方式必须另有布局证据或明确标作预览适配。

## HUD 图集与布局

源布局：`data/surfboard/play/musicInfo/CHU_UI_Playing_00_v10.srd`。源图集：`data/surfboard/texture/CHU_UI_playing_00_v11.dds`（2048×1368）。SRD 的 `SCN` 字段 0x40、0x41 给出的设计尺寸为 **1920×1080**。

SRD 是 `VTBF/SRFF`。本项目独立实现了受边界检查的静态记录读取：每条 `vtc0` 记录有长度、标签、字段数，字段附带类型。读取 `TEX/CROP`、`NODE/TRS2`、`CIMG/CNUM/CREF`；不求值 `MOT/TRK/KEY` 动画。格式核对时参考了 [Aqua Library 原作者的 VTBF 类型读取源码](https://github.com/Shadowth117/PSO2-Aqua-Library/blob/master/AquaModelLibrary.Helpers/PSO2/VTBFMethods.cs)；未复制其实现代码。

图集是此 SRD 的纹理索引 11。`CROP` 的 0x65 字段是 `[left,top,right,bottom]`；不是四舍五入推测的截图裁剪。以下 key 是稳定接口：

| HUD key | CROP 索引 | 图集像素区域/用途 |
|---|---:|---|
| musicBasic / Advanced / Expert / Master / WorldsEnd / Ultima | 0/1/2/3/4/89 | 每块586×182，实际起点与矩形存入清单 |
| bannerBasic / Advanced / Expert / Master / WorldsEnd / Ultima | 90/91/92/93/94/96 | 每块598×182；原静态节点显示宽586 |
| levelDigit0..9 | 78..87 | 28×42；`C_music_level_normal_num` 确认用途 |
| scoreDigit0..9 / comboDigit0..9 | 108..117 | 24×32；`C_score_num/C_combo_num` 确认同一数字集 |
| judgeDigit0..9 | 12..21 | 判定计数小数字 |
| trackDigit0..9 | 68..77 | 14×18，TRACK编号 |
| stars1..5 | 49/52/54/56/51 | 完整1至5星的整条图像，高16 |
| levelPlus | 88 | 难度加号 |
| judgeHeader | 129 | 判定名称条764×36 |
| musicOptions | 6 | SPEED/MIRROR条489×36 |
| gaugeBlue / gaugeYellow | 7/8 | 544×58 |

以下是静态父子节点位置相加、扣除 CIMG pivot 后得到的矩形，不含进场动画：

- 右侧曲目框 `(1334,0,586,182)`；左侧难度条 `(0,0,586,182)`。
- 判定名称条 `(578,0,764,36)`；曲目设置条 `(1362,0,489,36)`。
- 中央 gauge `(689,70,544,58)`。
- 分数数字中心 `(1150,56)`、COMBO 数字中心 `(905,56)`；父节点缩放均约0.9。
- 曲目 jacket 中心 `(1431,109)`、尺寸116×116；标题节点基点 `(1502,139)`、artist 基点 `(1502,159)`。这些节点不能与旧版本截图测量值混称为同一版本布局。
- 普通等级数字中心 `(1798,93)`，CNUM盒58×42、pivot=(29,21)；加号中心 `(1829,74)`，18×18。
- WORLD’S END 属性字中心 `(1799,87)`，原60×60节点缩放0.7，显示42×42。星条左上 `(1765,44)`，高16；满1至5星使用 CROP 49/52/54/56/51，宽14/28/42/55/70，不按各条宽度重新居中。
- TRACK 数字节点锚点 `(1572,56)`、pivot=(0,9)，所以字形左上 `(1572,47)`。数字0至9来自 CROP 68..77，各14×18。卡片原图已有 TRACK 标签。

中间 `DMY_Frame` 引用 `CHU_UI_DMY_Frame_00`。该名称和纹理指向运行时替换用占位对象，**本轮未把它当作真正分数框背景导入**。

此外提供完整原始文字图片：

- `comboLabel`：`data/acroarts/chu_count_combo.afb`，DDS 偏移285536，512×64。
- `scoreLabel`：`data/acroarts/chu_count_score.afb`，DDS 偏移28288，512×64。

文字 AFB 的变换与动画未求值，因此这两个 sprite 没有伪造 `layout`。它们和 SRD 顶栏数字的配合方式应由预览明确说明。

## 当前渲染的取舍

`renderer/classic-stage.ts` 保留原 triangle strip 的非重复索引三角形，按姿态 Z 排序后投影到 XY 平面；从每个面的单 UV 在原 `ringColor` 调色纹理取 RGBA 填色。缓存覆盖整幅 1920×1080 画面，避免原动画放大时被小缓存提前裁断；屏幕缩放固定，不随每帧包围盒变化。

有动画副本时，播放器按原骨骼、绑定矩阵和 UVC 曲线求姿态；缺少动画的旧副本才回退到静态原始网格。动作结束后保持末帧，可选择另一段动作或手动重播。关键帧插值、FPS、动作编排及最终世界变换的确认范围见 [game-animation.md](game-animation.md)。当前仍只是原动作片段预览，屏幕位置属于预览适配。

轨道主面和两侧边带采用原 `notesField/fieldSide` 图片，远端取 V=0、近端取 V=1，与原顶点方向一致；两片 Canvas 仿射三角形用于绘制透视四边形，尚不等同于原 GPU 的透视纹理插值。镜头、滚动与 AIR 高度仍使用预览标定。

右侧曲目卡片使用原难度图集，封面、曲名和作者取当前工程。分数与 COMBO 小数字使用原 SRD 对应裁剪，中央 COMBO 标签使用原 AFB 图片。中央背景、进度条和部分文字由编辑器绘制，不能称为完整原生 HUD。计分状态与原谱分类对照见 [native-judgement.md](native-judgement.md)。

资源加载只解码 bundled loader 返回的 `data:image/...` 和副本中的动画 JSON，不将 `sourcePath/sourceLayout` 当作图片 URL 或访问原游戏。

## 副本、验证与限制

执行 `node --import tsx scripts/copy-game-scene-resources.ts` 可在已有副本上追加本轮资源；该脚本不会读取音频或重新提取先前的205张图片。新场景共9项材质、74项HUD、12张去重 PNG 和5份几何数据。完整初始化脚本 `copy-game-resources.ts` 同样包含场景导入。

`assets/game/manifest.json` 存裁剪、布局、顶点与来源；`sha256.json` 记录每个 PNG 的完整摘要。测试检查所有场景 PNG 的 SHA-256、bundled路径、图集矩形边界、网格索引边界，以及环4008顶点、轨道宽64/长470这些已读事实。资源测试不是原游戏视觉验收。

以下源文件 SHA-256 标识本轮核对版本：

| 源 | SHA-256 |
|---|---|
| Stage.xml | 033d1ce06ba82531a6142c11406f9b0e931c43c1b8471ef44b85ac561ffa2c40 |
| nf_label_basic_0001_yellowring.afb | 7952f2f055eaf570fecc1e96694b0d6a27a0cda5a0a8ad3f706e463b4f30fec5 |
| st_label_basic_0001_yellowring.afb | 2e793272fed57c20074965c2e8ab3dc85fd4d7f11e86f44d5a5b205bfbba97a8 |
| CHU_UI_Playing_00_v10.srd | 6578aade87fb6b5dd75789751e3dc27889a1e99e8734d8dc6157dc8944efc07c |
| CHU_UI_playing_00_v11.dds | 8803878103a659f31e30074de00e418b9772c99b2ab858910df16a2e85f83afb |
| chu_count_combo.afb | 4e6ef667aeb770ca9e30de66146bd9462608055ed041193fa7ea90fdac4bad5a |
| chu_count_score.afb | 5abbe24ff4da4833d3fc3332e723143cad6a7441de121b9e127287d5b9df475e |

尚未确定：AFB 相机与世界变换的完整语义、动作编排与实际帧率、光照/雾/bloom、运行时替换的中央框、HUD 动画与部分原生计分规则。不能由贴图、静态顶点或界面相似度声称这些已经复现。


## 0.1.6 更新

静态网格预览已接入原 SVO 骨骼与 UVC 关键帧，详见 [game-animation.md](game-animation.md)。新的播放器缓存覆盖整幅 1920×1080 画面，保留动画原始缩放，不随每帧包围盒重新适配。世界摆位与 AFNC 片段控制层仍未确认，因此动画模式明确为原始片段预览，末帧保持、手动选择/重播；不编造循环。

计分入口已切换为独立判定时间表与分类统计对照，详见 [native-judgement.md](native-judgement.md)。上面的“参考计分”描述是 0.1.5 行为，当前 HUD 根据计算状态显示规则计算、估算或部分判定。

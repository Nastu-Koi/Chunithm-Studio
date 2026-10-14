# Chuni Studio

## 验证命令

项目位于 WSL，命令在 WSL 的项目根目录下运行（Node 版本见 `.nvmrc`）。

| 用途 | 命令 | 通过标准 |
| --- | --- | --- |
| 类型检查 | `npm run check` | 退出码 0，无输出错误 |
| 单元测试 | `npm test` | `fail 0` |
| 渲染端构建 | `npx vite build` | 退出码 0 |
| 格式检查 | `npm run format:check` | `All matched files use Prettier code style!` |
| 启动（浏览器，仅 UI 开发） | `npm run dev` | |
| 启动（桌面程序） | `npm run desktop` | |

- 前四条与 `.github/workflows/ci.yml` 一致，收尾时全部运行。格式检查不通过时先运行 `npm run format`。
- 项目没有配置 lint。
- 单元测试中有 6 项按环境跳过属正常：设置 `CHUNI_UI_URL` 启用编辑器交互测试，设置 `CHUNI_GAME_ROOT` 启用全库原生往返测试。
- Windows 桌面流程与实机验收无法在 WSL 内完成，做法与历史结果见 `docs/verification.md`；涉及这部分的验收标准要注明需在 Windows 上人工执行。

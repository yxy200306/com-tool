# AGENTS.md — COM-Tool

Electron 桌面串口/UDP 调试助手（类 SSCOM），支持多窗口、可插拔 HTML 协议解析工具、固件升级流程。UI 和文档均为中文。无框架、无打包器：主进程 + preload + `renderer/` 下的原生 JS。

## 结构

- `main.js` — 主进程：窗口 + **所有** IPC 实现（serialport 串口、dgram UDP、文件对话框、库/升级、设置持久化）。唯一能碰硬件/磁盘的地方。
- `preload.js` — `contextBridge` 白名单 API（`window.serialAPI` / `networkAPI` / `dialogAPI` / `libraryAPI` / `upgradeAPI` 等）。
- `renderer/app.js` — 收发、按间隔分包（默认 30ms）、选中、统计、自动解析 + 波特率自适应编排。
- `renderer/protocol.js` — 协议工具加载引擎：`srcdoc` iframe 驱动任意自包含 HTML 解析工具。
- `renderer/upgrade.js` — 本地升级库 UI + 升级包运行器（`Upgrade` 对象）。
- `renderer/index.html` + `style.css` — 三栏 UI（串口设置 / 收发 / 协议解析）+ 升级窗口。
- `scripts/prepare-build-cache.js` — 打包前置（见下方坑）。
- `release/` — 打包产物（不提交）。

## 常用命令

```powershell
npm start              # 开发运行
npm run dist           # 打包（predist 自动跑 prepare-build-cache.js）
npm run dist:portable  # 只出免安装单文件 exe
npm run pack           # 只解包到 release/win-unpacked（调试打包）
npm run prepare-cache  # 单独跑打包缓存准备
```

没有 lint / typecheck / test 基础设施；改动靠 `npm start` 手动验证。

## 架构边界（必须遵守）

- 渲染进程 `contextIsolation:true / nodeIntegration:false`，**没有** `require`/`fs`。任何需要读写文件、开串口/网络的新能力，固定三步：① `main.js` 写 `ipcMain.handle('xxx:yyy')` → ② `preload.js` 在对应 API 对象上暴露方法 → ③ 渲染层调用。
- UDP 相关 IPC 走 `network:` 前缀，串口走 `serial:`；升级库走 `library:` / `upgrade:`（详见 `开发指南.md` 第 5 节 IPC 清单）。
- 报文以包对象 `{id, time, dir:'rx'|'tx', bytes}` 存于 `app.js` 全局 `packets[]`，UI 只是投影；多包拼接解析靠 `selectedBytes()`。
- 协议工具接口约定（输入框 `#parse-input`、触发 `parseFrame()`/解析按钮、结果 `#parse-result`）识别逻辑全在 `protocol.js` 的 `detectApi()`；"乱码/正确"判定在 `evaluate()`（影响波特率自适应）。
- 升级包是**受信任的本地 JS 文件**（`module.exports = {manifest, create(context)}`），运行在无 Node API 的沙箱 context 中，仅暴露 `getChunk/send/progress/saveResume/loadResume/complete` 等助手。

## 已知坑

- `npm run dist` 在 Windows 普通用户下会因 winCodeSign 解压符号链接报"客户端没有所需的特权"——已由 `predist` 钩子自动修复，**无需管理员权限**，不要绕过 `predist`。
- `npm install` Electron 二进制下载失败（ECONNRESET）：`.npmrc` 已指向 npmmirror；仍失败则手动 `$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"; node node_modules/electron/install.js`。
- 打包报"Access is denied"删不掉 win-unpacked：先关掉所有运行中的 COM-Tool/electron 进程。
- serialport 用 N-API 预编译，无需 electron-rebuild；`build.asarUnpack: ["**/*.node"]` 必须保留。
- 固件镜像、协议文档、抓包、解析器、升级包**永不提交进仓库**；portable 构建把 `protocol-tools/` 和 `upgrade-packages/` 放在 EXE 旁（不可写时回退 user-data 目录）。

## 文档

改动前先读 **`开发指南.md`**（数据流图、IPC 清单、扩展点"照着做"小节、一眼定位表）；`README.md` 有协议工具接口约定和升级流程说明。

## Git 约定

当前工作分支 `codex/udp-upgrade-v2-1`（UDP + 升级工作流），主分支 `main`。提交信息用英文 conventional 风格（如 `feat: add UDP communication and upgrade workflow`）。

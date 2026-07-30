# COM-Tool V2.0 串口调试助手

一个类 SSCOM 的串口接收/发送工具，额外支持**多窗口独立串口**、**可插拔的 HTML 协议解析工具**、**自动解析**和**波特率自适应**。

V2.0 可通过顶部“新建窗口”或再次启动 V2 portable 创建多个窗口。每个窗口拥有独立的串口对象、波特率、收发缓存、多字符串列表和协议解析状态，可同时操作不同 COM 口。V1.0 与 V2.0 使用不同的用户数据目录，可以并存运行。

## 运行 / 打包

```powershell
npm install            # 已配置 .npmrc 走国内镜像
npm start              # 开发运行
npm run dist           # 打包：release/ 下生成 单文件 exe + 安装包（含自动修复 winCodeSign 解压问题）
```

打包产物（`release/`）：
- **`COM-Tool-V2-portable.exe`** — V2 免安装单文件，后续构建持续覆盖更新
- **`V1.0/COM-Tool-1.0.0-portable.exe`** — 保留的 V1.0 免安装版

> 说明：`npm run dist` 已通过 `predist` 钩子自动跑 `scripts/prepare-build-cache.js`，
> 解决 electron-builder 在 Windows 普通用户下 winCodeSign 解压"客户端没有所需的特权"
> 报错，**无需管理员权限/开发者模式**。详见 `开发指南.md` 第 8 节。
>
> 若 `npm install` 时 Electron 二进制下载失败（ECONNRESET），重跑：
> ```powershell
> $env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
> node node_modules/electron/install.js
> ```

## 基础功能（对标 SSCOM）

- 串口号/波特率/数据位/停止位/校验位/流控 设置，打开/关闭串口
- DTR / RTS 信号控制
- 接收区：HEX / ASCII 显示、时间戳、自动滚屏、**按间隔分包**（默认 30ms）
- 发送：单条发送（HEX/文本、加回车换行、定时发送、发送文件）
- 多条发送：多行编辑、逐条发、循环发
- 多窗口：每个窗口独立打开一个串口；重复启动 V2 会新增窗口
- RX/TX 字节统计、分包计数、清空、保存数据到文件

## 协议解析（额外功能）

1. **加载协议工具**：点右上「加载协议工具…」，选择一个 HTML 协议解析页面
   。工具会被载入隐藏 iframe 并自动识别其
   *输入框 / 解析按钮 / 结果区*（默认匹配 `#parse-input`、解析按钮、`#parse-result`，
   也支持通用启发式：textarea + 含「解析/parse」的按钮 + 含「result」的容器）。

2. **解析选中**：在接收区单击 / Shift / Ctrl 选择**一条或多条**报文，点「解析选中」。
   多条报文（哪怕被时间戳截断成多包）会按时间顺序**自动拼接**后再解析。
   结果以协议工具的**原生样式**渲染到右侧窗口。

3. **自动解析（实时）**：勾选后，每收到一包数据即自动调用协议工具解析并展示。

4. **波特率自适应**：勾选后，当解析结果判定为乱码/错误时，自动在候选波特率
   （可在输入框里改）之间切换，逐个尝试并解析新到的数据，直到解析正确为止，
   然后锁定该波特率。

## 协议工具接口约定

任何满足以下条件的自包含 HTML 页面都能作为协议工具被加载：
- 有一个**输入框**（`#parse-input`，或任意 `textarea` / `input[type=text]`）填入 HEX 报文；
- 有一个**解析触发**：全局函数 `parseFrame()`（或 `parse`/`decode` 等），或一个文字含「解析/parse」的按钮；
- 有一个**结果容器**（`#parse-result`，或 id 含 `result` 的元素 / `.result-box`），解析后在其中渲染结果。

「乱码/正确」判定基于结果中的标记词（如 `CRC ✓/✗`、`错误`、`crc-fail` 等）与结构长度，
可用于用户自行提供的 HTML 解析工具。

## 结构

```
main.js        Electron 主进程：窗口 + serialport 真实串口 IPC
preload.js     contextBridge 暴露 serialAPI / dialogAPI
renderer/
  index.html   三栏 UI（串口设置 / 收发 / 协议解析）
  style.css
  app.js       串口收发、分包、选择、统计、自动解析+波特率自适应编排
  protocol.js  协议工具加载引擎（iframe 驱动 + 原生结果镜像）
scripts/
  prepare-build-cache.js  打包前置：修复 winCodeSign 解压（predist 自动执行）
release/       打包产物（exe）
```

> 二次开发请先读 **`开发指南.md`**（代码框架、数据流、IPC 清单、扩展点）。

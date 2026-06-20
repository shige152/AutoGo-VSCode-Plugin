# AutoGo VS Code 扩展

AutoGo VS Code 扩展用于在 VS Code 中完成 AutoGo 项目的初始化、运行、调试、设备连接与 Android/iOS 编译工作。

## 功能概览

- 在 VS Code 中运行、停止项目并查看日志
- 管理 Android / iOS 设备连接
- 初始化 AutoGo 项目骨架
- 编译 Android 二进制、APK 与 iOS 相关产物
- 推送文件、目录与项目资源到设备
- 按需下载并管理 ADB / AutoGo 工具链

## 📣本插件正在测试阶段, 欢迎大家测试~

- 如有问题请点击链接加入群聊[【AutoGo-技术交流】：753399754](https://qm.qq.com/q/8uh1RtqsEM)
- MCP 服务器相关功能已独立到[【https://www.npmjs.com/package/autogo-mcp】](https://www.npmjs.com/package/autogo-mcp)

## 环境要求

- VS Code 1.96.2+
- Go 开发环境（用于 AutoGo 项目开发）
- Android NDK（编译 Android 二进制或 APK）

## 安装方式

- 在 VS Code 扩展市场搜索 `AutoGo-Plugin`
- 或下载 `.vsix` 后在 VS Code 中手动安装

## 快速开始

### 1. 准备开发环境

1. 安装 Go：可从 [Go 官方网站](https://golang.org/dl/) 下载
2. 如需国内镜像，可使用 [Go 语言中文网](https://studygolang.com/dl)
3. 如需编译 Android 二进制，请安装 Android NDK
   - 支持通过 `ANDROID_NDK_HOME` 指定 NDK 目录
   - Windows 默认目录：`C:\Users\Public\android-ndk-r27c`
   - macOS 默认目录：`/Users/Shared/android-ndk-r27c`

### 2. 连接设备

1. 在手机上开启开发者选项与 USB 调试
2. 通过 USB 或无线 ADB 连接设备
3. 在扩展中执行“连接设备”命令并选择目标设备

### 3. 初始化项目

1. 打开一个空工作区目录
2. 执行“初始化项目”命令
3. 选择目标平台（Android / iOS）

> 初始化会覆盖工作区中的 AutoGo 相关目录与文件，请先确认当前目录内容。

### 4. 运行与调试

- 使用命令面板或日志视图中的按钮执行运行、停止、同步、编译等操作
- 默认快捷键：
  - `F5`：运行项目
  - `F12`：停止运行

## 贡献与安全

- 贡献说明见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全漏洞报告见 [`SECURITY.md`](./SECURITY.md)
- 行为准则见 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)

## License

本项目基于 [MIT License](./LICENSE) 开源。

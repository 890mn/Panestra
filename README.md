<p align="center">
  <img src="./assets/branding/readme-lockup.svg" width="560" alt="Panestra — ONE CORE, EVERY DEVICE." />
</p>

**A local-first personal control plane for the screens you already use.**  
让 Windows 成为核心，把状态、工具、媒体与自动化能力带到电脑、手机和平板。

[快速开始](#快速开始) · [功能](#功能) · [接入能力](#接入能力) · [架构](#架构) · [安全](#安全) · [源码构建](#源码构建) · [更新日志](./CHANGELOG.md) · [Releases](https://github.com/890mn/Panestra/releases)

> [!NOTE]
> Panestra 仍处于早期开发阶段。当前主要面向 **Windows x64** 与 **Android 10+ ARM64**，接口、插件能力与 UI 仍可能快速变化。

## Panestra 是什么？

Panestra 不是远程桌面，也不只是系统监控面板。

它把一台 Windows PC 作为 **Panestra Core**：工作空间、布局、设备身份、权限和实时状态都由 Core 统一管理；桌面、手机和平板则作为不同的 **Surface**，使用同一套 React / TypeScript 界面连接它。

你可以把系统指标、Codex 用量、模型账户、音乐播放器、代理状态、自动化任务，以及之后更多本机软件或硬件能力，组织成同一套可编辑的 Workspace。

**同一个 Core，不同的屏幕，不同的布局。**

## 功能

<table>
<tr>
<td width="50%" valign="top">

### 自由编排的 Workspace

卡片可以移动、缩放、交换和自动整理，并支持 Undo / Redo。

Desktop、Tablet、Mobile 分别使用 **12 / 8 / 4 列布局**。同一个 Widget 可以共享数据与配置，同时在不同 Surface 保存独立位置和尺寸。

</td>
<td width="50%" valign="top">

### 实时状态与跨端同步

Core 维护权威状态，客户端通过 HTTPS / WebSocket 同步。

配置修改使用 revision 与 operation ID 做冲突控制和幂等；实时指标按 topic 订阅，慢客户端不会阻塞 Core。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 插件与本机适配

System Monitor 已通过 Panestra Backplane 作为独立 Worker 运行，使用 manifest、capability 授权、健康检查与崩溃重启。

Codex、账户额度、Clash、网易云音乐和 ALAS 目前由 Core adapters 接入。

</td>
<td width="50%" valign="top">

### Local-first 与设备身份

数据默认留在自己的 Core 上。

首次连接需要配对；客户端固定 Core 公钥指纹，设备使用独立密钥身份，Owner 可以批准、分配角色或撤销设备。

</td>
</tr>
</table>

## 接入能力

| 能力 | 当前实现 | 可做什么 |
| --- | --- | --- |
| **System Monitor** | Backplane Plugin | CPU、内存、磁盘、网络、主机信息；授权后锁定 Windows 会话 |
| **Codex** | Core Adapter | 读取本机 Codex ChatGPT 订阅额度、剩余额度与重置时间 |
| **GLM Coding Plan** | Core Adapter | 查询智谱中国区 Coding Plan 用量窗口与工具用量 |
| **DeepSeek** | Core Adapter | 查询 API 账户人民币 / 美元余额 |
| **网易云音乐** | Core Adapter | 当前歌曲、歌手、封面与播放状态；授权后播放、暂停、切歌与调整进度 |
| **Clash Verge** | Core Adapter | 代理模式、实时流量、策略组状态；授权后切换模式与节点 |
| **ALAS** | Core Adapter | 查看实例状态、当前任务、等待任务与下一次调度 |

读取能力和控制能力分开授权。设备也有独立角色：Viewer 只读，Operator 可以编辑和执行允许的操作，Owner 负责设备、权限与高风险设置。

## Dashboard

Panestra 的 Dashboard 不是固定模板，而是可编排页面。

- 创建页面并添加 Widget
- 拖动、Resize、交换、自动对齐
- 网格位置与自由尺寸实时预览
- Widget 内部内容可以调整顺序、列宽和对齐
- 不同尺寸可使用不同 presentation
- Desktop / Tablet / Mobile 保存独立布局
- 白昼、黑夜或跟随系统主题
- 自定义点缀色
- 离线保留最近快照，重新连接后恢复实时状态

布局编辑只在手势结束时提交持久化变更；拖动过程保持本地预览，从而避免把每一帧移动都写入数据库。

## 快速开始

### 1. 在 Windows 启动 Core

优先从 [GitHub Releases](https://github.com/890mn/Panestra/releases) 下载对应版本。尚未提供安装包时，可以按下方的源码构建流程运行。

首次启动时，Windows 应用会同时启动 Panestra Core。

### 2. 启用 System Monitor

进入 **插件 → System Monitor**，授予读取系统指标的能力，然后把需要的 Widget 添加到工作空间。

### 3. 配对 Android

在 Windows 打开 **设备与连接 → 添加设备**。

Android 与 PC 位于同一局域网时，可以通过 mDNS 自动发现 <code>_panestra._tcp</code> 服务，也可以扫描配对二维码或手工填写 HTTPS Endpoint。

客户端会先验证 Core 身份指纹，再提交设备公钥和签名挑战；Windows 端批准后完成配对。

### 4. 从任意 Surface 编辑

手机、平板和桌面都可以编辑 Workspace。数据与 Widget 实例共享，但各 breakpoint 的布局分别保存。

## 源码构建

### Requirements

- Node.js 22.12+
- npm
- Go 1.27+
- Rust stable 1.90+
- MSVC C++ Toolchain
- Windows SDK
- WebView2

Android 额外需要 JDK 17、Android SDK 36、Build Tools 36、NDK 28.2.13676358，以及 Rust <code>aarch64-linux-android</code> target。

### Clone

<pre><code>git clone https://github.com/890mn/Panestra.git
cd Panestra
npm ci</code></pre>

### Core + Web

<pre><code>.\scripts\build.ps1
.\scripts\start.ps1</code></pre>

默认 Core Endpoint 为 <code>https://localhost:9443</code>，本地数据存放在 <code>.data</code>。

### Windows

<pre><code>.\scripts\build.ps1 -Desktop</code></pre>

安装包输出到 <code>shell/desktop/target/release/bundle/nsis</code>。

### Android

<pre><code>rustup target add aarch64-linux-android
.\scripts\build-android.ps1 -Debug -OptimizedNative</code></pre>

APK 输出到 <code>shell/desktop/gen/android/app/build/outputs/apk/arm64/debug</code>。

### Verify

<pre><code>.\scripts\verify.ps1</code></pre>

验证脚本覆盖 TypeScript、Prettier、gofmt、rustfmt、Go vet、Go tests，以及桌面 / 平板 / 手机尺寸的 Playwright 测试。

## 更新

应用内可以查看版本与更新日志。

Windows 使用 Tauri Updater 对安装包签名进行验证；Android 在安装前校验下载摘要、包名、版本和应用签名。更新过程保留现有布局与设备配对。

完整开发记录见 **[CHANGELOG.md](./CHANGELOG.md)**。

## Contributing

Panestra 目前仍以快速迭代为主。

如果你发现 Bug、希望接入新的本机软件 / Agent / 硬件，或者对跨设备 Dashboard 有新的交互想法，欢迎提交 [Issue](https://github.com/890mn/Panestra/issues)。

---

<div align="center">

<img src="./assets/branding/icon.png" width="44" alt="Panestra" />

### Panestra

**ONE CORE, EVERY DEVICE.**

</div>

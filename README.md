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

每台 Windows PC 都可以运行自己的 **Panestra Core**，管理工作空间、布局、设备身份、权限和实时状态。桌面、手机和平板作为 **Surface**，使用同一套 React / TypeScript 界面，同时连接已配对的多个 Core，在总览查看各台主机的数据

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

System Monitor、Codex、账户额度、Clash、网易云音乐和 ALAS 均以独立插件进程运行，支持权限授权、健康检查与崩溃重启。

插件源码和独立构建工具位于 [Panestra-Plugins](https://github.com/890mn/Panestra-Plugins)，主程序通过清单和本机 IPC 接入。

</td>
<td width="50%" valign="top">

### Local-first 与设备身份

数据默认留在自己的 Core 上。

首次连接需要配对；客户端固定 Core 公钥指纹，设备使用独立密钥身份，Owner 可以批准、分配角色或撤销设备。

</td>
</tr>
</table>

## 接入能力

| 能力                | 当前实现 | 可做什么                                                         |
| ------------------- | -------- | ---------------------------------------------------------------- |
| **System Monitor**  | 独立插件 | CPU、内存、磁盘、网络、主机信息；授权后锁定 Windows 会话         |
| **Codex**           | 独立插件 | 读取本机 Codex ChatGPT 订阅额度、剩余额度与重置时间              |
| **GLM Coding Plan** | 独立插件 | 查询智谱中国区 Coding Plan 用量窗口与工具用量                    |
| **DeepSeek**        | 独立插件 | 查询 API 账户人民币 / 美元余额                                   |
| **网易云音乐**      | 独立插件 | 当前歌曲、歌手、封面与播放状态；授权后播放、暂停、切歌与调整进度 |
| **Clash Verge**     | 独立插件 | 代理模式、实时流量、策略组状态；授权后切换模式与节点             |
| **ALAS**            | 独立插件 | 查看实例状态、当前任务、等待任务与下一次调度                     |

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

进入 **插件 → System Monitor → 状态与设置**，授权并启用读取，再向工作空间添加组件。未附带插件包的构建可先打开插件目录安装。

### 3. 配对 Android

在 Windows 打开 **设备与连接 → 添加设备**。

Android 与 PC 位于同一局域网时，可以通过 mDNS 自动发现 <code>_panestra._tcp</code> 服务，也可以扫描配对二维码或手工填写 HTTPS Endpoint。

客户端会先验证 Core 身份指纹，再提交设备公钥和签名挑战；Windows 端批准后完成配对。

### 4. 从任意 Surface 编辑

手机、平板和桌面都可以编辑 Workspace。数据与 Widget 实例共享，但各 breakpoint 的布局分别保存。

### 5. 聚合多台主机与切换工作区

点击左下角的连接标识打开 **Core 连接**，通过 **添加新 Core** 配对另一台电脑。每台主机使用自己的地址、身份指纹与配对码，分别保存工作空间、插件、权限和离线快照

填好地址与 SHA-256 后，可以先点 **测试连接** 验证目标主机身份，无需填写配对码，也不会切换当前主机或新增配对。连接通过后填写配对码并发送请求，在目标主机批准；配对码过期时重新打开目标主机的添加设备窗口

失败提示会标明目标地址、失败步骤与原生连接原因。端口拒绝说明该地址的端口没有接受连接；超时应检查主机与映射是否在线；TLS 或身份错误应核对映射目标、目标主机的 SHA-256 和系统时间。使用浏览器时，还需先信任目标 Core 的证书并满足来源限制

**总览** 同时显示已配对主机各页面的组件，按主机分组，卡片标明来源、实时或缓存状态。点击卡片执行操作时，请求发往该卡片所属的主机；各主机独立同步和重连，一台断线不会中断其他主机

从左下角切换 Core，或点击总览中的 **打开工作区**，进入该主机的页面、布局编辑、插件与设备管理。切换会先验证目标身份和设备权限，验证失败时保留当前连接，其他已配对主机继续在总览同步。原有默认页面在侧栏显示为 **主机工作区**

展开某个 Core 的连接地址，选择 **添加连接地址**，可为同一台电脑保存局域网地址或远程映射地址，沿用已有配对与身份指纹

#### 通过 UU 远程端口映射连接

[UU 远程官方说明](https://www.bilibili.com/video/BV1FX5V6LEqR/)介绍了把远端 TCP 服务映射到手边电脑的方式。远端保持 Panestra Core 运行；在手边电脑的 UU 远程客户端，为远端设备创建端口映射，示例配置如下

| 配置项                            | 示例                      |
| --------------------------------- | ------------------------- |
| 目标服务地址（远端主机上的 Core） | `127.0.0.1`               |
| 远端 TCP 端口                     | `9443`                    |
| 本地端口（手边电脑）              | `19443`                   |
| 手边电脑上 Panestra 的 Core 地址  | `https://127.0.0.1:19443` |

默认 Core 端口是 `9443`，自定义启动参数时以实际端口为准；本地端口选空闲端口即可。HTTPS 请求与 WSS 实时同步共用一个 TCP 映射，保持 HTTPS，不关闭身份校验

在手边电脑的 Panestra Windows 客户端中，选择 **添加新 Core**，通过远程桌面打开远端 Panestra 的 **设备与连接 → 添加设备**，填写远端主机的身份指纹、配对码与上述映射地址，再在远端批准请求。已经配对这台远端主机时，为它添加上述连接地址即可；不同主机不能复用本机的指纹和配对码

这里的 `127.0.0.1` 是手边电脑的本机地址，手机和平板不能直接使用这台电脑的回环地址。远程映射不会转发局域网自动发现，需要手动填写地址；更适合用原生客户端连接，浏览器仍需满足本地证书和来源限制

## 插件安装与开发

插件源码、设置清单和独立发布工具位于 [Panestra-Plugins](https://github.com/890mn/Panestra-Plugins)，主程序只保留插件管理、通信、布局和共用可视化组件

「插件 → 打开插件目录」显示本地随包提供的插件；「检查插件更新」手动获取插件仓库的 GitHub Release 目录。选择安装或更新后，Core 下载到本机、验证发布者签名和文件摘要，再展示权限确认；候选进程通过检查才替换原版本，失败继续运行旧版本

也可使用「导入插件包」选择同一插件的 ZIP、JSON 与 SIG 三个文件，支持分块传输。卸载会停止运行并保留本机配置和已有布局，重新安装后可恢复；已安装插件在断网时照常运行

只运行受信发布者签名的 Windows 原生插件，独立进程与权限检查不等同于操作系统沙箱。Android 只显示状态和发送授权操作，不下载或执行 Windows 插件

### 网易云音乐进度

部分网易云 Windows 版本没有系统播放时间轴，可在插件的「状态与设置」中保存本机进度端口（例如 `19228`），点击「修复启动方式」，再退出网易云并从原快捷方式打开。修复会给桌面、开始菜单、任务栏快捷方式和已有用户自启动项保留进度参数，不自动重启播放器

「恢复启动设置」还原已修改的参数，修改前的备份仅保存在本机。直接运行 EXE 或使用其他启动器，需要自行携带 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=19228`；更换端口后需重新保存和修复启动方式。播放器内部接口不兼容时保留播放与切歌控制，禁用进度跳转

公共目录的快捷方式不可写时，在当前用户的桌面或开始菜单创建对应入口，不需要管理员权限；恢复时移除新增的用户快捷方式，公共入口保持原样

### 构建时附带离线插件包

两仓库分别构建。普通主程序构建不需要插件源码；可从正式发布获取签名包，或在插件仓库用自己的发布密钥独立构建。自定义发行者需要同时替换主程序的公开信任根 `core/plugins/publisher.pub`，私钥始终留在仓库外

准备包含 `catalog.json`、ZIP、JSON 与 SIG 的目录后，在主仓库构建时指定

```powershell
.\scripts\build.ps1 -Desktop -PluginPackages '..\Panestra-Plugins\artifacts\packages\1'
```

只附带已构建的签名包，不把插件源码复制到主仓库。自动测试插件的实际进程、安装生命周期和协议时，也需要预先准备这些包；纯网页开发、类型与格式检查不需要运行插件

## 架构

Windows Core 管理数据、设备身份、权限和插件生命周期；插件在本机读取软件状态与执行授权操作；Windows 和 Android 使用同一套界面显示状态与编辑布局。已安装插件运行时无需连接插件仓库。

## 安全

设备通过 HTTPS / WSS 通信，原生客户端固定 Core 公钥指纹。Windows 使用 DPAPI、Android 使用 Keystore 保存身份；插件安装先校验发布者签名，读取与控制分别授权。原生插件是受信代码，进程隔离不等同于操作系统文件或网络沙箱。

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

### 本地打包与产物整理

运行 `scripts/package.ps1` 后，安装包的固定入口是 `artifacts/latest`，包含 Windows 安装包、便携 ZIP、Android 开发 APK、版本号与 SHA-256 校验文件。旧版本保存在 `artifacts/archive/releases/<版本号>`，截图、日志与验证记录分别收纳在 `archive` 下，构建程序和离线插件包位于 `artifacts/build`

打包会自动更新最新完整版本；单独整理测试输出可运行 `scripts/organize-artifacts.ps1`，保留已有文件。整个 `artifacts` 目录均在 Git 忽略范围内

### Verify

<pre><code>.\scripts\verify.ps1</code></pre>

验证脚本覆盖 TypeScript、Prettier、gofmt、rustfmt、Go vet、Go tests，以及桌面 / 平板 / 手机尺寸的 Playwright 测试。宿主的插件生命周期测试需预先提供签名包；软件适配与 ALAS 桥接测试在独立插件仓库运行。

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

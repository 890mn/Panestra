# Panestra / 星序

**one core, every device.**

中文名为星序，版本变更和提交约定见 [版本记录](docs/release-history.md)。开发前运行 `npm run format:check`，完整检查使用 `./scripts/verify.ps1`，每个小版本完成后创建本地提交。

Panestra 是本地优先的个人控制面。Windows 上的 Panestra Core 保存工作空间与设备权限；电脑、Android 手机和平板通过同一套 Surface 界面查看状态、编辑页面和布局。Backplane 在独立进程中运行插件。

本项目按 `Panestra-deep-research-report.md` 的 MVP 路线实现。界面以白昼、黑夜两种黑白主题为主，雾绿仅用于点缀；设置中可跟随系统，也可自定义点缀色。原有两个 icon 用于应用、安装包和连接页。

## 开始使用

Windows 安装版或便携版启动 `Panestra.exe`，Core 会随应用启动。首次连接页自动填入本机地址、身份指纹和一次性认领码，点击“认领并进入工作空间”。进入“插件”，授权读取系统指标并启用 System Monitor，即可看到真实 CPU、内存、磁盘、网络和系统信息。

在“设备与连接”打开两分钟的配对窗口。Android Surface 会通过 NSD 列出局域网 Core；选择地址，填入电脑显示的身份指纹与配对码，再在电脑端核对并批准请求。发现结果只提供候选地址，身份由固定公钥和签名验证。

Android 连接页也可点击“扫描电脑配对二维码”，允许相机后扫描电脑上的二维码，地址、指纹与配对码会自动填入。二维码过期需要在电脑重新打开配对窗口。多网卡电脑可选择二维码中的局域网地址。已经连接的手机可在“设备与连接 → 连接其他 Core”使用扫码入口；新 Core 批准之前会保留当前连接。再次连接已配对的 Core 会验证身份并直接登录，无需重复注册设备。

手机和平板也能添加、配置、删除组件及拖动、缩放布局。编辑器可切换桌面、平板、手机预览；三个断点分别保存。离线时显示缓存，编辑和操作暂时不可用；重连后自动恢复。

Codex 订阅额度已接入：在电脑「插件 → Codex → 额度与设置」授权读取，再通过「添加组件」将额度放入工作空间。复用本机 Codex 的 ChatGPT 登录，无需复制凭据。详情见 [Codex 适配说明](docs/codex-adapter.md)。

布局编辑支持触摸拖动、网格吸附、卡片交换、自动对齐和整组撤销。平板默认 8 列，各屏幕布局分别保存。见 [布局编辑说明](docs/layout-editor.md)。

卡片现支持六档预制尺寸与自由拉伸，可选择数值、趋势、进度或详情等呈现方式。小尺寸展示摘要，点击标题可看完整详情。Android 使用沉浸式全屏隐藏系统状态栏和导航栏。见 [尺寸与呈现规范](docs/widget-presentation.md)。

## 从源码运行

需要 Node.js 22+、Go 1.27+。首次构建会先生成共享界面，再将其嵌入 Core。

```powershell
npm ci
.\scripts\build.ps1
.\scripts\start.ps1
```

默认地址为 `https://localhost:9443`。终端输出本机首次认领码和 Core SHA-256 指纹。浏览器访问需要先确认本地证书；原生 Surface 使用固定公钥验证，无需关闭 TLS 校验。

Windows 原生构建另外需要 Rust、MSVC、Windows SDK 和 WebView2：

```powershell
.\scripts\build.ps1 -Desktop
```

Android 构建需要 JDK 17、Android SDK 36、Build Tools 36、NDK 28.2.13676358，以及 Rust Android ARM64 target：

```powershell
.\scripts\build-android.ps1 -Debug -OptimizedNative
```

Android 最低版本为 10 / API 29，传输强制 TLS 1.3。脚本兼容 Windows 未开启 Developer Mode 的环境，用复制 JNI 库替代符号链接。发布 APK 的签名说明见 [运维说明](docs/operations.md)。

当前工作目录内的 `.tools` 保存本次构建使用的便携工具链，构建脚本优先使用它；常规开发机也可使用已安装的工具链。TLS 下载适配器仅用于本次环境的依赖下载，不属于 Panestra 运行依赖。

## 已实现

- Go Core、SQLite WAL、逻辑单写者、迁移与在线备份／离线恢复。
- HTTPS / WSS、P-256 身份、Windows DPAPI、Android Keystore、挑战认证、短会话与即时撤销。
- 默认关闭的限时配对、设备角色、明确审批、限流与审计。
- 页面和组件编辑、12 / 8 / 4 列布局、拖拽缩放、精确配置、撤销／重做与跨端同步。
- `opId` 去重、实体 `rev`、全局 `serverSeq`、断线补齐、墓碑和明确冲突；安全的不同配置字段可自动重基。
- 已知地址、手动 HTTPS 地址、mDNS 广播、Windows mDNS / Android NSD 候选发现。
- 独立插件进程、framed JSON-RPC、握手、显式能力授权、心跳、崩溃恢复与 Windows Job Object。
- 声明式系统组件、真实系统数据、经确认且单独授权的锁定会话操作。
- 有界实时订阅、样本合并、慢客户端断开，以及签名发行包验证／分阶段激活工具。
- 离线发行签名、逐文件摘要、第一方插件健康检查后热切换、失败保留旧版本及重启后使用已批准版本。

完整验证结果见 [验收记录](docs/acceptance.md)，逐项对应研究计划的结果见 [实施对照](docs/implementation-checklist.md)。当前为 0.1.8 开发版，不作为稳定版发布。

后续阶段、优先级、依赖与验收标准见 [长期发展规划](docs/roadmap.md)。优先优化底层、UI 与使用手感，仅开发 Windows / Android。按键与尺寸见[设计规范](docs/design-system.md)，网易云音乐、Codex、GLM Coding Plan、Clash Verge、ALAS 见[软件适配设计](docs/software-adapters.md)；本轮目录和详情已落地，适配 Worker 尚未实现。

## 验证

```powershell
.\scripts\verify.ps1
```

包含 TypeScript 检查、Go vet、Go 单元／集成测试，以及真实 Core 的 Playwright 桌面、平板、手机三端测试与重启恢复。浏览器测试使用本机 Chrome；Windows DPAPI 测试须在真实用户配置下执行。规模测试覆盖 10 个 WS 客户端、300 个组件、200 个主题、同时重连、慢订阅者，以及 21 个 System Plugin 进程的隔离与恢复。原生壳测试脚本位于 scripts/test-native-desktop.mjs 和 scripts/test-native-android.mjs。Android 测试必须显式指定设备；完整配对／撤销测试用于专用测试设备，仅在显式设置 `PANESTRA_TEST_FRESH=1` 时清除本项目应用的数据。

保留现有配对的 USB 实机检查使用 scripts/test-physical-connection.mjs，实际镜头识别使用 scripts/test-physical-scanner.mjs，均需设置 `PANESTRA_TEST_ANDROID` 为已授权的 USB 设备序列号。本次已在 M367FC 平板、Android API 37 上通过原生 NSD 发现、镜头扫码、取消扫码及已配对 Core 重连；没有清除平板数据。

## 目录

| 目录             | 用途                                                        |
| ---------------- | ----------------------------------------------------------- |
| `core`           | 权威状态、认证、API、实时总线、Backplane、签名发行工具      |
| `client`         | React / TypeScript 共享 Surface                             |
| `shell/desktop`  | Windows Tauri 壳与共享原生入口                              |
| `shell/android`  | Android 配置；生成的 Gradle 工程位于 desktop/gen/android    |
| `shell/bridge`   | Windows TLS／DPAPI／mDNS 与 Android Keystore／NSD／TLS 桥接 |
| `plugins/system` | 第一方 System Plugin 与 manifest                            |
| `packages`       | API / Widget / Layout 类型契约                              |
| `scripts`        | 构建、验证、运行与打包                                      |
| `docs`           | 架构、协议、安全、运维与验收                                |
| `artifacts`      | 本次构建产物、截图和测试记录，未纳入源码                    |

不包含公共插件市场、任意宿主 JS、云中继、CRDT、通用终端或厂商隧道 SDK。Tailscale、ZeroTier、FRP 等只改变到 Core 的网络可达性。

0.1.7 编辑布局保留实时卡片，可原位拖动和缩放。样式即时预览，内容块的顺序、列宽、对齐和显示按组件、屏幕、尺寸分别保存，窄屏设置使用底部面板。操作方式与插件要求见 [尺寸与呈现规范](docs/widget-presentation.md)。

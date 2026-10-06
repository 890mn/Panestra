# Panestra

**ONE CORE, EVERY DEVICE.**

Panestra（星序）把电脑的状态和控制放到你常用的屏幕上。Windows 电脑运行 Core，保存工作空间、布局和设备权限；Android 手机与平板连接 Core，查看实时数据、操作组件，也能直接编辑自己的页面

目前支持 Windows x64 和 Android 10 及以上的 ARM64 设备，项目处于早期开发阶段

## 可以做什么

- 查看 CPU、内存、磁盘、网络流量和电脑运行状态，支持实时趋势图
- 查看本机 Codex 的订阅额度、剩余额度与重置时间，需先在电脑上授权
- 创建页面、添加组件，直接在卡片上拖动和缩放，支持交换、自动对齐及撤销与重做
- 为桌面、平板和手机分别保存布局，为每种卡片尺寸选择样式、调整内容顺序、列宽与对齐方式
- 使用白昼、黑夜或跟随系统主题，自定义点缀色
- 通过局域网发现或二维码配对设备，管理角色与权限，随时撤销设备访问
- 在授权后锁定电脑会话，自动备份工作空间，离线时查看缓存

插件在独立进程运行，能力需要明确授权。网易云音乐、GLM Coding Plan、Clash Verge 和 ALAS 目前提供适配设计与功能目录，尚不能实际控制或获取状态；Codex 当前接入的是订阅额度

## 安装与连接

从 [GitHub Releases](https://github.com/890mn/Panestra/releases) 下载与你的设备对应的版本。尚未发布安装包时，可按下文从源码构建

1. 在 Windows 上安装并打开 Panestra，Core 会随应用启动。连接页自动填入本机信息，首次使用点击「建立并进入工作空间」
2. 进入「插件」，授权并启用 System Monitor，再向工作空间添加需要的组件
3. 电脑打开「设备与连接」中的配对窗口，Android 与电脑连接同一局域网，扫描电脑二维码或选择自动发现的 Core
4. 在电脑上核对并批准请求，完成后 Android 会保存配对，下次打开可自动重连

扫码需要相机权限，二维码只在配对窗口开放期间有效。无法发现时检查防火墙是否允许 Panestra 的局域网连接，也可手动填写 HTTPS 地址、身份指纹和配对码

连接其他 Core 可从「设备与连接」进入。编辑布局后，不同设备会同步工作空间数据，屏幕尺寸对应的布局各自保存。离线期间只读，重新连接后恢复编辑和控制

Codex 额度需在 Windows 的「插件 → Codex → 额度与设置」授权读取，复用电脑上已有的 Codex ChatGPT 登录，无需复制凭据

## 从源码构建

### 依赖

- Node.js 22.12+ 与 npm
- Go 1.27+
- Windows 原生应用：Rust stable 1.90+、MSVC C++ 工具链、Windows SDK、WebView2
- Android：JDK 17、Android SDK 36、Build Tools 36、NDK 28.2.13676358，以及 Rust `aarch64-linux-android` target

构建脚本使用 PowerShell，在项目根目录运行，需允许下载 npm、Go、Cargo 与 Gradle 依赖

```powershell
git clone https://github.com/890mn/Panestra.git
cd Panestra
npm ci
```

### Core 与网页界面

```powershell
.\scripts\build.ps1
.\scripts\start.ps1
```

默认监听 `https://localhost:9443`，数据保存在 `.data`。首次认领码和身份指纹会在终端显示，浏览器需要确认本地证书；原生应用通过固定公钥校验 Core 身份

开发界面可另开终端运行 `npm run dev`。生产界面会在构建时嵌入 Core

### Windows 应用

```powershell
.\scripts\build.ps1 -Desktop
```

安装包位于 `shell/desktop/target/release/bundle/nsis`。普通源码构建无需更新签名私钥；自行发行的版本需配置自己的更新公钥与签名密钥

### Android 应用

设置 `JAVA_HOME` 和 `ANDROID_HOME` 后安装 Rust target，再构建开发 APK

```powershell
rustup target add aarch64-linux-android
.\scripts\build-android.ps1 -Debug -OptimizedNative
```

APK 位于 `shell/desktop/gen/android/app/build/outputs/apk/arm64/debug`。首次构建会生成 Android 工程，Windows 未开启 Developer Mode 时脚本会用复制方式放置 JNI 库

发布 APK 需使用持续保留的签名密钥，设置以下环境变量后运行 `.\scripts\build-android.ps1`：`PANESTRA_ANDROID_KEYSTORE`、`PANESTRA_ANDROID_STORE_PASSWORD`、`PANESTRA_ANDROID_KEY_ALIAS`、`PANESTRA_ANDROID_KEY_PASSWORD`。密钥和密码不应写入仓库，正式 APK 与开发 APK 的签名不同，不能相互覆盖安装

### 检查

```powershell
.\scripts\verify.ps1
```

检查包括 TypeScript、Prettier、gofmt、rustfmt、Go vet 与测试，以及桌面、平板和手机尺寸的 Playwright 测试。浏览器测试需要本机 Chrome，Windows 身份与传输测试需要真实用户配置；原生 Android 验收需显式指定授权设备

## 更新

点击左上角品牌可查看软件简介、当前版本与更新日志，通过「GitHub 项目」打开源码仓库和问题反馈页面

「设置 → 应用更新」显示当前版本，手动检查 GitHub Releases 的正式版本，可在「更新日志」查看本地记录和检查到的新版本说明

Windows 通过 Tauri 官方更新器验证安装包签名，下载成功后安装并重启应用。Android 下载 APK 后校验 SHA-256、应用包名、版本和签名，再打开系统安装窗口；首次需要允许 Panestra 安装应用，最终安装由系统确认。更新保留已有布局与配对

尚无正式 Release、发布包不完整或网络不可用时，界面会显示相应状态，保留当前版本

### 发行者

Windows 自动更新采用 [Tauri 官方 updater](https://v2.tauri.app/plugin/updater/) 与 GitHub Releases 静态 `latest.json`，不需要维护更新服务器

1. 用 `npm exec -- tauri signer generate -w <安全目录中的密钥文件>` 生成更新密钥，将公钥内容配置到 `shell/desktop/tauri.conf.json` 的 `plugins.updater.pubkey`。妥善备份私钥，已安装的客户端依赖此公钥
2. 在构建环境设置 `TAURI_SIGNING_PRIVATE_KEY` 与可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，构建 Windows 安装包。`requireSignedVersion` 要求签名绑定版本，防止重放旧包
3. 在 `artifacts` 中准备 `Panestra-版本-windows-x64-setup.exe`，运行 `node scripts/create-update-manifest.mjs` 生成 `latest.json` 和安装包签名
4. 创建标签为 `v版本` 的正式 GitHub Release，上传 Windows 安装包、对应 `.sig` 与 `latest.json`。Android 上传使用原发布签名的 `Panestra-版本-android-arm64.apk`，GitHub 的资源元数据提供下载摘要

Release 正文用于新版本更新说明。推送源码、创建标签和公开发布都是独立操作，构建脚本不会自动上传

## 源码结构

| 目录              | 内容                                    |
| ----------------- | --------------------------------------- |
| `core`            | 数据、身份认证、API、实时同步与插件管理 |
| `client`          | React / TypeScript 共享界面             |
| `shell/desktop`   | Windows Tauri 壳与 Android 共享原生入口 |
| `shell/android`   | Android 主 Activity 与平台配置          |
| `shell/bridge`    | 原生发现、身份存储、网络与扫码桥接      |
| `plugins/system`  | 系统监控插件                            |
| `packages`        | 协议与布局类型                          |
| `assets/branding` | 原始品牌图标                            |
| `scripts`         | 构建、验证与打包脚本                    |

Core 数据默认保留在本机，设备通过 HTTPS / WSS 通信。Windows 使用 DPAPI、Android 使用 Keystore 保存身份。配对需要电脑批准，插件操作受设备角色和授权范围限制

## 更新说明

### 0.1.11

点击左上角品牌查看软件简介、当前版本和更新日志，通过菜单内的 GitHub 按钮打开项目页面

### 0.1.10

新增应用更新与分层更新日志，将 GitHub 入口移到品牌区，整理品牌素材和开源使用说明

### 0.1.9

恢复纯英文主品牌，统一全大写 slogan，调整连接页位置与版本标记

### 0.1.8

统一主题、控件和界面文案，简化工作空间导航与设置

### 0.1.7

原位动态编辑布局，增加尺寸与内容样式预设，完善触摸操作并接入 Codex 订阅额度

更早记录与后续版本见 [CHANGELOG.md](CHANGELOG.md)

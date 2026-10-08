# 天王星 23° 视觉资源

此目录包含 Panestra 彩蛋主题使用的壁纸资源，随应用离线打包

- 黑夜：来自用户指定对话 `01a11b72-d4b2-7791-a610-e9b1205a1fba` 的细节重建 4K 壁纸，源文件为 `D:/Hinar2Future/Uranus23/renders/final/Uranus23_wallpaper_4K_detail_restored.png`
- 白昼：使用内置 imagegen 工具，以该黑夜壁纸为编辑目标生成，底板实际尺寸为 1672×941，保留冰原、行星和星环布局，转换为明亮冰白天光
- `day.webp` / `night.webp`：日常界面资源，白昼保留生成底板尺寸，黑夜压缩至 1920×1080
- `*-small.webp`：960px 宽的触屏与外观预览资源
- `night-detail.webp`：3840×2160 的观景资源，仅在打开黑夜观景时加载

WebP 只做格式压缩与尺寸适配，未用锐化、滤镜或二次绘制修改视觉。原始图保留在来源目录。星点静止，无音轨。23° 是彩蛋的名称与斜向星环图形角度，不表示天王星的自转轴倾角

白昼生成提示见 [day-prompt.txt](./day-prompt.txt)

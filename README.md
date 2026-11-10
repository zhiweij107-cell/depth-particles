# 深度粒子 · Depth Particles

置换底图 + 边缘粒子可视化：彩图 / 白模切换，深度差大处密而快向后飘。

## 下载

**Release 页面：** https://github.com/zhiweij107-cell/depth-particles/releases

| 系统 | 文件 |
|------|------|
| Windows x64 | `DepthParticles-*-win-x64-portable.exe` |
| macOS Apple Silicon | `DepthParticles-*-mac-arm64.dmg` |
| macOS Intel | `DepthParticles-*-mac-x64.dmg`（需 CI 打出 x64） |

### macOS 提示「已损坏」？

不是安装包坏了。未签名 + 浏览器下载会触发隔离标记，系统误报损坏。终端执行：

```bash
xattr -cr /Applications/深度粒子.app
```

推送 `v*` tag 后，GitHub Actions 会自动构建并发布到 Releases。

## 开发

```bash
npm install
npm run dev
```

## 本地打包

```bash
# Windows 便携版
npm run dist

# macOS（必须在 Mac 上执行）
npm run dist:mac
```

## 交互

- **Move** — 旋转观察
- **Click** — 全息扫描
- **DblClick** — 散开 / 聚合
- **Space** — 自动环视

详见 `使用说明.txt` / Release 中的 `USAGE.txt`。

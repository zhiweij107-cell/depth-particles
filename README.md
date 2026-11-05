# 深度粒子 · Depth Particles

置换底图 + 边缘粒子可视化：彩图 / 白模切换，深度差大处密而快向后飘。

## 下载

**Release 页面：** https://github.com/zhiweij107-cell/depth-particles/releases

| 系统 | 文件 |
|------|------|
| Windows x64 | `DepthParticles-*-win-x64-portable.exe` |
| macOS Apple Silicon | `DepthParticles-*-mac-arm64.dmg`（需启用 CI 后自动产出） |
| macOS Intel | `DepthParticles-*-mac-x64.dmg`（需启用 CI 后自动产出） |

当前 **v1.1.0** 已上传 Windows 便携版。Mac 包需要在 macOS 上构建（本机是 Windows，无法本地交叉打包）；把仓库里的 `docs-release-workflow.yml` 放到 `.github/workflows/release.yml` 并授予 GitHub `workflow` 权限后，推送 `v*` tag 即可自动打 Win + Mac。

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

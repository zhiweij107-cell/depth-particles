# 深度粒子 · Depth Particles

置换底图 + 边缘粒子可视化：彩图 / 白模切换，深度差大处密而快向后飘。

## 下载（推荐）

到 [Releases](../../releases) 下载对应系统安装包：

| 系统 | 文件 |
|------|------|
| Windows x64 | `深度粒子-*-win-x64-便携版.exe` |
| macOS Apple Silicon | `深度粒子-*-mac-arm64.dmg` |
| macOS Intel | `深度粒子-*-mac-x64.dmg` |

详见 `使用说明.txt`。

## 开发

```bash
npm install
npm run dev
```

## 本地打包

```bash
# Windows 便携版
npm run dist

# macOS（需在 macOS 上执行）
npm run dist:mac
```

推送形如 `v1.1.0` 的 tag 后，GitHub Actions 会自动构建 Win + Mac 并发布到 Releases。

## 交互

- **Move** — 旋转观察
- **Click** — 全息扫描
- **DblClick** — 散开 / 聚合
- **Space** — 自动环视

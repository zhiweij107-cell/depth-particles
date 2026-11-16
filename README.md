# 深度粒子 · Depth Space v2

互动空间：把多张图片变成可移动 / 旋转 / 缩放的浮雕模型，整场作品可落盘，一键截图。

## 功能

- **添加图片**：自动估深并放入空间（可连续添加）
- **选中模型**：侧栏显示变换参数与浮雕参数
- **G / R / S**：移动 / 旋转 / 缩放手柄
- **粒子开关**：默认关闭，按需开启以省性能
- **保存作品**：`.depthspace.json` 写到本地磁盘（原图 + 深度 + 参数 + 变换）
- **截图**：隐藏变换手柄后导出 PNG

## 开发

```bash
npm install
npm run dev
```

打开 http://localhost:5173/

## 打包

```bash
npm run dist       # Windows 便携版
npm run dist:mac   # macOS（需在 Mac 上）
```

推送 `v*` tag 后 GitHub Actions 会发布 Release。

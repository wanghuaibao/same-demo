# same-demo

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.15. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## 本地运行指北

1. **启动开发服务器**
   ```bash
   bun run dev
   ```
   服务器将在 `http://localhost:3000` 启动，支持热重载。

2. **打开浏览器测试**
   - 访问 http://localhost:3000
   - 输入要克隆的网站地址（如：`https://example.com`）
   - 点击 "Clone" 按钮
   - 等待克隆完成后自动下载 ZIP 文件

3. **生产环境运行**
   ```bash
   bun run start
   ```

## 常见问题排查

<details>
<summary>❌ Chromium 下载失败</summary>

**现象：** 安装 puppeteer 时报错 `Failed to set up Chrome`

**解决方案：**
```bash
# 方案 1：手动安装 Chromium
npx puppeteer browsers install chrome

# 方案 2：使用系统 Chrome
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
bun run dev

# 方案 3：重新安装（跳过下载）
PUPPETEER_SKIP_DOWNLOAD=true bun install
```
</details>

<details>
<summary>❌ 端口 3000 被占用</summary>

**现象：** `EADDRINUSE: address already in use :::3000`

**解决方案：**
```bash
# 查找占用进程
lsof -i :3000

# 杀死占用进程
kill -9 <PID>

# 或修改端口（编辑 src/server.ts）
port: 3001  // 改为其他端口
```
</details>

<details>
<summary>❌ macOS 权限问题</summary>

**现象：** `Permission denied` 或 `Operation not permitted`

**解决方案：**
```bash
# 给予终端完全磁盘访问权限
# 系统偏好设置 → 安全性与隐私 → 隐私 → 完全磁盘访问权限 → 添加终端

# 或临时修改目录权限
sudo chmod 755 /tmp
mkdir -p /tmp/website-clone
chmod 777 /tmp/website-clone
```
</details>

<details>
<summary>❌ 克隆超时或失败</summary>

**现象：** 网站克隆过程中超时或网络错误

**解决方案：**
1. **检查网络连接**：确保能正常访问目标网站
2. **增加超时时间**：编辑 `src/clone.ts`，调整 `timeout` 参数
3. **使用代理**：
   ```bash
   export HTTP_PROXY=http://proxy.example.com:8080
   export HTTPS_PROXY=http://proxy.example.com:8080
   bun run dev
   ```
4. **跳过大文件**：目前已配置跳过 >10MB 文件，如需调整可修改 `maxResourceSize`
</details>

<details>
<summary>❌ ZIP 下载失败</summary>

**现象：** 浏览器无法下载生成的 ZIP 文件

**解决方案：**
1. **检查浏览器下载设置**：确保允许自动下载
2. **清除浏览器缓存**：刷新页面重试
3. **手动下载**：
   ```bash
   curl -X POST http://localhost:3000/api/clone \
     -H "Content-Type: application/json" \
     -d '{"url":"https://example.com"}' \
     --output site.zip
   ```
</details>

## 技术栈

- **运行时**：Bun
- **后端**：TypeScript + Bun 原生 HTTP 服务器
- **爬虫**：website-scraper + puppeteer
- **前端**：原生 JavaScript + Tailwind CSS
- **打包**：JSZip

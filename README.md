# Website Cloner - 专业网站克隆工具

一个基于 Bun + TypeScript + Puppeteer 构建的专业级网站克隆工具，支持一键克隆任何网站并提供在线预览和ZIP下载功能。

## ✨ 主要特性

- 🚀 **极速克隆**：30-90秒完成完整网站克隆
- 👁️ **在线预览**：生成可访问的预览链接，无需下载即可查看
- 📦 **ZIP下载**：完整打包所有资源，支持本地离线访问
- 🔍 **实时进度**：Server-Sent Events 实时显示克隆进度和详细日志
- 💎 **完美兼容**：智能处理CORS、Next.js、动态内容等复杂场景
- 🛡️ **资源完整**：自动下载CSS、JS、图片、字体等所有外部资源
- 🔧 **冲突解决**：智能处理文件路径冲突，确保克隆成功
- 🌐 **开箱即用**：解压后支持file://协议直接访问

## 🎯 支持的网站类型

- ✅ 静态网站（HTML/CSS/JS）
- ✅ React/Vue等SPA应用
- ✅ Next.js网站（含SSR/SSG）
- ✅ 含有CDN资源的网站
- ✅ 使用外部字体的网站
- ✅ 复杂布局和动画网站

## 🚀 快速开始

### 安装依赖

```bash
bun install
```

### 启动开发服务器

```bash
bun run dev
```

服务器将在 `http://localhost:3000` 启动。

### 使用方法

1. 打开浏览器访问 http://localhost:3000
2. 输入要克隆的网站地址（如：`https://example.com`）
3. 选择操作模式：
   - **👁️ 在线预览**：生成预览链接，可直接在浏览器查看
   - **📥 下载ZIP**：打包下载，支持离线访问
4. 实时查看克隆进度和详细日志
5. 克隆完成后获取预览链接或下载文件

### 生产环境运行

```bash
bun run start
```

## 🔧 API接口

### 克隆网站
```bash
POST /api/clone
Content-Type: application/json

{
  "url": "https://example.com",
  "preview": true,  // true=预览模式，false=下载模式
  "sessionId": "session_12345"
}
```

### 实时进度
```bash
GET /api/progress?sessionId=session_12345
```
返回Server-Sent Events流，实时推送克隆进度。

## 🛠️ 技术架构

- **运行时**：Bun (非Node.js)
- **后端**：TypeScript + Bun HTTP服务器
- **爬虫引擎**：Puppeteer + Cheerio
- **前端**：原生JavaScript + Tailwind CSS
- **实时通信**：Server-Sent Events (SSE)
- **文件处理**：JSZip
- **静态服务**：支持预览文件托管

## 📋 项目结构

```
same-demo/
├── src/
│   ├── server.ts    # Bun HTTP服务器
│   ├── clone.ts     # 核心克隆逻辑
│   └── index.ts     # 程序入口
├── public/
│   └── index.html   # 前端界面
├── preview/         # 预览文件存储目录
├── downloads/       # 下载文件存储目录
└── package.json
```

## 本地运行指北

1. **启动开发服务器**
   ```bash
   bun run dev
   ```
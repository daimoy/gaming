# 十点半 · 暗夜赌局（联机版）

Node.js + Socket.io 的实时双人网页游戏，支持观战、快速匹配、房间链接微信分享。

## 本地运行（你自己电脑上玩）

```bash
npm install
npm start
```

浏览器打开 `http://localhost:3000`。

## 免费部署到公网（发微信给朋友玩）

推荐 **Render**：免费、无需信用卡、支持 Node 长连接（Socket.io 需要，纯静态托管不行）。

### 方法一：Render（推荐）

1. 把 `ten-half-server` 整个文件夹传到 GitHub（新建一个仓库，上传所有文件，包含 `package.json`，**不要**传 `node_modules`）。
2. 注册 https://render.com（可用 GitHub 账号直接登录）。
3. 点 **New + → Web Service**，连接刚才的 GitHub 仓库。
4. 配置项：
   - Name：随便填，比如 `ten-half`
   - Runtime：`Node`
   - Build Command：`npm install`
   - Start Command：`npm start`
   - Instance Type：`Free`
5. 点 **Create Web Service**，等 1-2 分钟部署完成，会得到一个 `https://xxx.onrender.com` 的链接。
6. 把这个链接发到微信，朋友点进去 → 选「十点半」→ 快速匹配或输入房间号即可一起玩。

> 注意：Render 免费层在 15 分钟没人访问后会休眠，第一次访问要等约 30 秒冷启动。玩的时候一直有人在线就不会休眠。

### 方法二：Railway（备选）

1. 注册 https://railway.app（GitHub 登录，有免费额度）。
2. New Project → Deploy from GitHub repo → 选仓库。
3. 它会自动识别 Node 项目并部署，完成后在 Settings 里生成公开域名。
4. Build/Start 命令同样是 `npm install` / `npm start`。

## 关于微信分享的两个现实提醒

1. **Socket.io 需要长连接**，不能只传到纯静态托管（如 GitHub Pages、普通 CDN），必须能跑 Node 进程的平台（Render / Railway 都行）。
2. 微信对**未备案域名**有时会提示「已停止访问该网页」。免费平台给的 `onrender.com` / `railway.app` 域名属于国外域名，多数情况能打开，但不稳定。要长期稳定分享，最终还是建议国内云服务器 + 已备案域名（那是后话，先玩起来再说）。

## 以后加新游戏

项目已经做成「大厅 + 子游戏」结构：

- `public/index.html` 是游戏大厅，列所有游戏入口。
- `public/tenhalf.html` 是十点半页面。
- 加新游戏：新建一个 `public/xxx.html`，在大厅里加一个 `<a class="card live" href="/xxx.html">` 卡片即可。
- 联机逻辑在 `server.js`，用 socket 事件区分不同游戏（可用 socket.io 的 namespace 隔离）。

## 文件说明

- `server.js`：服务端权威状态机（房间、下注、发牌、结算、观战、匹配）。
- `public/index.html`：游戏大厅。
- `public/tenhalf.html`：十点半前端。
- `test-flow.js`：端到端测试（模拟 2 玩家 + 1 观战）。

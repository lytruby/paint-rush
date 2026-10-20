# 抢地盘 Paint Rush

浏览器实时 1v1 涂色对战：60 秒内走过的格子染成你的颜色，占地多者获胜。

在线地址：https://paint-rush.onrender.com （免费套餐闲置后会休眠，首次打开可能需要等待几十秒）

> 开发中。完整的 README（玩法、架构、同步策略、生命周期、取舍）会在收尾阶段补全。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)，进度见 [docs/PROGRESS.md](docs/PROGRESS.md)。

## 本地运行

```bash
npm install
npm run dev          # 前端 http://localhost:5173（热更新），后端 :3000
```

生产模式：

```bash
npm run build && npm start   # http://localhost:3000，单服务同时提供页面和 WebSocket
```

冒烟测试（模拟两个客户端通过 WebSocket 连接）：

```bash
npm run smoke -- http://localhost:3000
```

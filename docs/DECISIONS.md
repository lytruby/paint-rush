# 决策记录

| # | 决策内容 | 理由 |
|---|---|---|
| 1 | 玩法定为 16×16 网格涂色对战，每局 60 秒 | 规则一句话就能说清，双方有直接对抗；状态很小，适合用全量快照同步（用户已确认） |
| 2 | 固定 2 人房间 | 用户确认只做 2 人，可以简化结算、房主和中途加入的逻辑 |
| 3 | 不支持手机，只做键盘操作；音效放在 P1 | 用户确认 |
| 4 | 服务器权威，客户端只发方向意图，服务器以 12 Hz 广播全量快照 | 从根本上避免作弊和两端不一致；全量快照对丢包和乱序天然免疫，256 格的数据量很小 |
| 5 | 技术栈：Node + TypeScript + Express + Socket.IO，前端用 Vite + 原生 TS + Canvas | Socket.IO 自带房间、重连和心跳，最省时间；视图很少，不需要框架 |
| 6 | 单服务部署：生产环境由 Express 托管 vite build 的产物，同源提供 WebSocket | 不需要处理 CORS 和 Origin 配置，一个平台、一个进程就能上线 |
| 7 | 开发模式：Vite（5173）通过代理把 /socket.io、/api、/healthz 转发到后端（3000），`npm run dev` 一条命令同时启动前后端 | 前端可以热更新，同时与生产环境保持同源结构一致 |
| 8 | 生产环境直接用 tsx 运行 TS 服务端，不单独编译 | 省掉服务端构建配置，以节省时间；代价是启动略慢，这里可以接受 |
| 9 | 构建所需的工具（vite、typescript、tsx）放在 dependencies 中 | 部署平台在 NODE_ENV=production 下安装依赖时可能跳过 devDependencies，放在 dependencies 可以避免构建失败 |
| 10 | 重连 token 存 sessionStorage，昵称存 localStorage（DESIGN.md 已同步更新） | 面试官很可能在同一个浏览器里开两个标签页自测；如果 token 用 localStorage，两个标签页会共用同一个座位并互相挤掉 |
| 11 | 增加 `/healthz` 健康检查和 `npm run smoke` 冒烟脚本（双客户端强制走 WebSocket） | 部署平台需要健康检查；脚本提供可复制运行的验收命令，并能在公网验证 wss 是否可以穿透代理 |
| 12 | 阶段 1 的"首次部署"使用沙箱临时公网 HTTPS 地址验证 | 正式平台（Render、Railway、Fly.io）需要用户账号，目前不可用；临时地址已经验证了 HTTPS 代理加 wss 这条链路，正式部署待用户确认 |
| 13 | 正式部署平台定为 Render（用户确认），由 Agent 通过 Render 连接器（API key）创建服务、部署和查看日志；区域选新加坡，免费套餐，构建命令 `npm install && npm run build`，启动命令 `npm start` | 部署是风险最高的一环，Agent 能直接查看日志并排查问题，不需要用户转述；新加坡离用户最近 |
| 14 | 代码托管在 GitHub 私有仓库 lytruby/paint-rush，按阶段提交并推送 | 用户确认使用 GitHub 连接器；默认私有，提交面试前再决定是否公开 |

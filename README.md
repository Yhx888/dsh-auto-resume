# dsh-auto-resume

后端重启/断连后**自动继续被打断的对话**：不用手动再发一条"继续"。

## 功能

- 周期性探测 `/` 连通性（1.5s）；从正常→失败记下断开时刻（同时落 localStorage，防页面 reload 丢状态），持续超过 2.5s 才算一次真实"重启"（滤掉瞬时抖动）。
- 断开→恢复后（或页面重新加载时发现记录且后端已通），检查当前会话：**最后一条用户指令之后没有助手回复**（AI 被打断没跑完）→ 自动通过官方 `session.prompt`（mode=queue）提交一条可见的"自动续接"消息。
- 并发安全：localStorage 原子领取（claim-and-clear）+ 模块级忙标志，多 watcher / 页面 reload 都不会重复提交。

## 安全边界

- 用户断连后**自己发过新消息**（最后用户消息晚于断开时刻 5s）→ 不抢跑。
- 会话内**已有助手回复** → 不续（不打断正常回复）；被截断的流式输出 v1 不自动重放（工具副作用安全考虑），可配合 dsh-chat-recovery 手动重试。
- 续接消息会以一条可见的用户消息进入会话（前缀【自动续接】），来源与历史都完整。

## 安装

```bash
# profile 注册（link: 依赖），然后重启 dsh web
pnpm install   # 在 ~/.dsh/profiles/web 下
```

host 半是 noop（仅装配锚点），全部逻辑在浏览器半。

## 依赖机制（均为官方 API）

- `connection.api.sessions.history` → 判断尾部轮次是否未收尾
- `connection.api.sessions.prompt({ sessionId, mode: 'queue', content })` → 提交续接消息（冷会话由官方 API remotes 自动 resume）

## License

MIT
// dsh-auto-resume — host half（noop）。
// 能力全部在浏览器半（lib/client.js）：监听后端连接，断连恢复后自动提交
// 续接消息。host 半仅作为 bundle patch 的装配锚点存在。

export const name = 'dsh-auto-resume'

export function apply() {
  // noop：本插件的全部逻辑在 client 半。
}

export default { name, apply }
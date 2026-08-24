// dsh-auto-resume — host half（轻量：仅续接链路的服务端观测端点）。
// 能力主体在浏览器半（lib/client.js）；host 半作为 bundle patch 装配锚点，
// 并提供 loopback-only /api/dsh-auto-resume/log 接收 client 续接链路的关键
// 步骤/失败上报，追加写入 $DSH_HOME/auto-resume.log（服务重启后依然可查）。
// 只 import node: 内置模块。

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-auto-resume'
export const inject = ['webServer']

const LOG_API = '/api/dsh-auto-resume/log'
/** 日志路径：优先 $DSH_HOME，其次服务进程的家目录。 */
const LOG_FILE = (process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'auto-resume.log')
  : join(homedir(), '.dsh', 'auto-resume.log'))

function appendLogLine(line) {
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf8')
    return null
  } catch (error) {
    return String(error)
  }
}

/** 仅接受环回地址的控制面请求。 */
function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LOG_API,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, code: 'forbidden' })
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const session = typeof parsed.sessionId === 'string' ? ' ' + parsed.sessionId.slice(0, 8) : ''
          const type = typeof parsed.type === 'string' ? parsed.type : 'event'
          const message = typeof parsed.message === 'string' ? parsed.message : ''
          const line = `${new Date().toISOString()} [${type}]${session}: ${message}`
          const writeError = appendLogLine(line)
          const log = (ctx.logger || console)
          if (log.info) log.info(`[dsh-auto-resume] ${type}${session}: ${message}`)
          writeJson(res, 200, { ok: true, log: LOG_FILE, ...(writeError === null ? {} : { writeError }) })
        } catch (error) {
          writeJson(res, 400, { ok: false, code: 'bad-request' })
        }
      })
    },
  }), 'dsh-auto-resume: log')
}

export default { name, inject, apply }
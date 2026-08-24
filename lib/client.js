// dsh-auto-resume — web client half.
// 后端重启/断连后自动继续被打断的对话：
//   1. 周期性探测 /（根页面）连通性；从"正常 → 失败"记断开时刻（并落
//      localStorage，防页面 reload 丢状态），持续超过阈值才算一次"重启"；
//   2. 与 dsh-reload-button 联动（优先路径）：点击重载按钮时它写入
//      localStorage 标记 `dsh-auto-resume:resume-request`，本插件恢复后
//      直接消费该标记续接——显式请求，不依赖断连猜测；
//   3. 无论走哪条路径，都检查当前会话：若最后一条用户指令之后没有助手回复
//      （即 AI 被打断没跑完），自动通过 session.prompt 提交一条续接消息；
//   4. 全页面同一时刻只有一个续接执行者（标记原子清除 + 模块级忙标志），
//      多会话 watcher 并发也不会重复提交。
//
// 安全边界：用户断连后自己又发过新消息（最后用户消息晚于断开时刻）时不续；
// 会话内已有助手回复时不续（v1 保守：不打断正常回复，被截断的流式输出由
// 用户按需重试）。续接消息会以一条可见的用户消息进入会话，文本见 RESUME_TEXT。

window.__ModuleLoader__.load({
  id: 'dsh-auto-resume',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');

    var DISC_KEY = 'dsh-auto-resume:disconnected';
    /** 与 dsh-reload-button 的联动标记（由它写入，本插件消费）。 */
    var RESUME_KEY = 'dsh-auto-resume:resume-request';
    var POLL_MS = 1500;
    /** 断开持续超过该时长（毫秒）才视为一次真实重启，滤掉瞬时抖动。 */
    var DISC_MIN_MS = 2500;
    var HISTORY_MESSAGES = 16;
    var RESUME_TEXT =
      '【自动续接】服务刚经历一次重启，我上一条指令的执行被打断。' +
      '请回顾我上一条消息及你进行中的工作（包括尚未完成的工具调用与生成内容），' +
      '从断点继续完成，不需要向我确认。';

    var continuing = false;

    function delay(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function pingBackend() {
      try {
        var response = await fetch('/', { cache: 'no-store' });
        return response.ok;
      } catch (error) {
        return false;
      }
    }

    /** 续接链路打点：fire-and-forget 上报 host 日志端点（服务端可观测）。 */
    function report(type, message, sessionId) {
      try {
        fetch('/api/dsh-auto-resume/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: type,
            message: String(message).slice(0, 300),
            ...(sessionId === undefined ? {} : { sessionId: sessionId }),
          }),
        }).catch(function () {});
      } catch (error) {
        /* ignore */
      }
    }

    function loadDisc() {
      try {
        var raw = window.localStorage.getItem(DISC_KEY);
        if (raw === null) return null;
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed.sessionId === 'string' && typeof parsed.ts === 'number' ? parsed : null;
      } catch (error) {
        return null;
      }
    }

    function saveDisc(value) {
      try {
        window.localStorage.setItem(DISC_KEY, JSON.stringify(value));
      } catch (error) {
        /* localStorage 不可用：仅当前页面内状态也能工作 */
      }
    }

    function clearDisc() {
      try {
        window.localStorage.removeItem(DISC_KEY);
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * 原子领取续接资格：disc 必须存在且 sessionId 匹配；领取即清除，
     * 任何并发 watcher / 页面 reload 都只会有一个执行者拿到 ts。
     */
    function claimDisc(sessionId) {
      var disc = loadDisc();
      if (disc === null || disc.sessionId !== sessionId) return null;
      clearDisc();
      return disc.ts;
    }

    /** 读取联动标记（dsh-reload-button 点击时写入）。ts 未来时间 = 失败后的
     *  冷却重试窗口（刻意为未来时间戳，此时视为未成熟，不消费）。 */
    function loadResumeRequest() {
      try {
        var raw = window.localStorage.getItem(RESUME_KEY);
        if (raw === null) return null;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ts !== 'number' || parsed.ts > Date.now()) return null;
        return parsed;
      } catch (error) {
        return null;
      }
    }

    function clearResumeRequest() {
      try {
        window.localStorage.removeItem(RESUME_KEY);
      } catch (error) {
        /* ignore */
      }
    }

    /** 失败后恢复联动标记，并设 30 秒冷却（避免 tick 每 1.5s 疯狂重试）。 */
    function restoreResumeRequest(ts) {
      try {
        window.localStorage.setItem(RESUME_KEY, JSON.stringify({ ts: Math.max(Date.now() + 30000, ts + 30000) }));
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * 领取一条"待续接"请求：联动标记优先（显式请求），其次断连记录。
     * @returns {{ts:number, source:'request'|'disc'}|null} null = 无待办。
     */
    function claimPendingResume(sessionId) {
      var rr = loadResumeRequest();
      if (rr !== null) {
        clearResumeRequest();
        return { ts: rr.ts, source: 'request' };
      }
      var discTs = claimDisc(sessionId);
      if (discTs !== null) return { ts: discTs, source: 'disc' };
      return null;
    }

    /** 会话里是否存在（用户发起的）消息——空会话/纯系统会话不续。 */
    function hasUserMessage(entries) {
      for (var i = 0; i < entries.length; i += 1) {
        var event = entries[i];
        if (event && event.type === 'user/message' && event.surfaceOp === 'append' &&
            event.data && event.data.source && event.data.source.kind === 'user') {
          return true;
        }
      }
      return false;
    }

    /**
     * 判断该会话是否需要续接（断连兜底路径用，保守）：
     * - 最后一条用户消息（append 面、kind=user）之后没有任何助手回复；
     * - 且该用户消息不晚于断开时刻（晚于 = 用户自己已继续，不抢跑）。
     * 注意：按钮联动路径（source='request'）不走本判定——用户点击重载即
     * 显式续接意图，即使流式中断已产生部分 assistant 事件也要续（AI 自行
     * 判断历史决定是否继续）。
     */
    function needsContinuation(entries, discTs) {
      var userSeq = [];
      var assistantSeqs = [];
      for (var i = 0; i < entries.length; i += 1) {
        var event = entries[i];
        if (!event || typeof event.type !== 'string') continue;
        if (event.type === 'user/message' && event.surfaceOp === 'append' &&
            event.data && event.data.source && event.data.source.kind === 'user' &&
            typeof event.seq === 'number') {
          userSeq.push({ seq: event.seq, time: typeof event.time === 'number' ? event.time : 0 });
        } else if (event.type === 'assistant/message' && typeof event.seq === 'number') {
          assistantSeqs.push(event.seq);
        }
      }
      if (userSeq.length === 0) return false;
      var lastUser = userSeq[userSeq.length - 1];
      // 不可靠的最后排序（分页顺序不保证）：取 seq 最大者。
      for (var k = 1; k < userSeq.length; k += 1) {
        if (userSeq[k].seq > lastUser.seq) lastUser = userSeq[k];
      }
      // 用户断连后自己又发了消息 → 不抢跑。
      if (discTs > 0 && lastUser.time > discTs + 5000) return false;
      for (var j = 0; j < assistantSeqs.length; j += 1) {
        if (assistantSeqs[j] > lastUser.seq) return false;
      }
      return true;
    }

    async function maybeContinue(connection, sessionId, ts, source) {
      if (continuing) return;
      continuing = true;
      try {
        var value = null;
        var attempts = 0;
        // history 可能赶上会话恢复窗口（session-not-found），小退避重试。
        while (attempts < 3) {
          try {
            var response = await connection.api.sessions.history({
              sessionId: sessionId,
              maxMessages: HISTORY_MESSAGES,
            });
            var result = response && response.result;
            if (!result || result.ok !== true) throw new Error(result && result.error ? result.error.message : 'history rejected');
            value = result.value;
            break;
          } catch (error) {
            attempts += 1;
            if (attempts >= 3) throw error;
            await delay(1500 * attempts);
          }
        }
        var entries = (value && value.events || []).map(function (row) { return row && row.event; });
        if (source === 'disc') {
          // 断连兜底：保守判定（避免打扰已收尾的轮次）。
          if (!needsContinuation(entries, ts)) {
            report('skip', 'disc 路径：最后用户消息之后已有助手回复，不续', sessionId);
            return;
          }
        } else if (!hasUserMessage(entries)) {
          // 按钮联动：无条件续接（用户显式意图），但空会话/纯系统会话除外。
          report('skip', 'request 路径：会话无用户消息，不续', sessionId);
          return;
        }
        report('continue', '判定通过（source=' + source + '），提交续接', sessionId);
        await delay(500);
        // prompt 有重试：服务刚恢复时 agent 可能仍在挂载（agent-busy 等）。
        var promptAttempts = 0;
        var promptError = null;
        while (promptAttempts < 3) {
          try {
            await connection.api.sessions.prompt({
              sessionId: sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: RESUME_TEXT }],
            });
            promptError = null;
            break;
          } catch (error) {
            promptError = error;
            promptAttempts += 1;
            if (promptAttempts >= 3) break;
            await delay(2000 * promptAttempts);
          }
        }
        if (promptError !== null) throw promptError;
        window.console.info('[dsh-auto-resume] 已自动续接会话', sessionId);
        report('sent', '【自动续接】消息已入队', sessionId);
      } catch (error) {
        window.console.warn('[dsh-auto-resume] 自动续接失败：', error);
        report('failed', '续接失败：' + String(error), sessionId);
        // 失败不放弃：request 标记恢复（带 30s 冷却），后续 tick/boot 会重试。
        if (source === 'request') restoreResumeRequest(ts);
      } finally {
        continuing = false;
      }
    }

    // ---- React 槽位组件 ----
    function Overlay(props) {
      return React.createElement(
        props.SessionProvider,
        { empty: () => null },
        () => props.renderSlot('auto-resume.watch', {}),
      );
    }

    /** 会话级监听器：无 UI，只管断连检测与续接。 */
    function Watcher(props) {
      const sessionId = props.sessionId;
      const connection = props.connection;
      React.useEffect(() => {
        let disposed = false;
        let disconnectedSince = 0;
        // 装配标记：便于页面侧验证 client 半已运行（data-dsh-auto-resume=active）。
        document.documentElement.dataset.dshAutoResume = 'active';
        window.console.info('[dsh-auto-resume] watcher active', sessionId);

        const boot = async () => {
          if (disposed) return;
          if (!(await pingBackend())) return;
          // 页面（重新）加载后后端已通：消费联动标记或断连记录（原子领取）。
          const pend = claimPendingResume(sessionId);
          if (pend !== null) await maybeContinue(connection, sessionId, pend.ts, pend.source);
        };

        const tick = async () => {
          if (disposed) return;
          const ok = await pingBackend();
          if (ok) {
            // 联动标记：重载按钮的显式续接请求（页面可能刚加载或一直开着）。
            const rr = loadResumeRequest();
            if (rr !== null) {
              clearResumeRequest();
              await maybeContinue(connection, sessionId, rr.ts, 'request');
            }
            if (disconnectedSince > 0) {
              const discTs = disconnectedSince;
              disconnectedSince = 0;
              if (Date.now() - discTs >= DISC_MIN_MS) {
                const ts = claimDisc(sessionId);
                if (ts !== null) await maybeContinue(connection, sessionId, ts, 'disc');
              }
            }
          } else if (disconnectedSince === 0) {
            disconnectedSince = Date.now();
            saveDisc({ sessionId: sessionId, ts: disconnectedSince });
          }
        };

        void boot();
        const timer = setInterval(() => { void tick(); }, POLL_MS);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, [sessionId, connection]);
      return null;
    }

    var inject = ['slots', 'sessions', 'connection'];

    function apply(ctx) {
      const connection = ctx.get('connection');
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'auto-resume-host',
            order: 200,
            children: { 'auto-resume.watch': { kind: 'single', scope: 'session' } },
          },
          Overlay,
        ),
      );
      ctx.slots.inject('auto-resume.watch', () =>
        ctx.slots.register(
          {
            name: 'auto-resume.watch',
            inject: (sessionId) => ({ sessionId, connection }),
          },
          Watcher,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
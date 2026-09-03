// adapters/echo.mjs — Echo 假适配器（确定性、零网络、零 token，MVP 端到端验证）

/**
 * Echo 适配器：接收到 prompt 后，原样回显（加时间戳），用于：
 * 1. 整条链路端到端演练（不花 token、不走网络）
 * 2. CI / 单元测试（确定性输出，可断言）
 * 3. 验证 bus / registry / orchestrator 链路是否正确
 */
export default {
  id: 'echo',
  displayName: 'Echo Agent',
  outputProtocol: 'cli-text',

  /** 健康探测 */
  async probe() {
    return {
      ok: true,
      status: 'available',
      resolved: null,
      version: '1.0.0-echo',
      code: 0,
      error: null,
      checkedAt: Date.now(),
    };
  },

  /** 运行（Generator 形式，yield 事件） */
  async *run({ taskId, runId, prompt, cwd, timeoutMs = 30000, signal, onEvent }) {
    const startTs = Date.now();

    if (signal?.aborted) return;

    yield { type: 'run.started', taskId, runId, agentId: 'echo', ts: startTs };

    // 模拟短暂思考延迟
    yield { type: 'run.thinking', taskId, runId, text: 'Processing...' };
    await new Promise(resolve => {
      const timer = setTimeout(done, 10);
      const onAbort = () => {
        clearTimeout(timer);
        done();
      };
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    if (signal?.aborted) return;

    const echoText = `[Echo @ ${new Date().toISOString()}] ${prompt}`;
    yield { type: 'run.stdout', taskId, runId, text: echoText };

    const duration = Date.now() - startTs;
    yield {
      type: 'run.completed',
      taskId,
      runId,
      agentId: 'echo',
      text: echoText,
      cost: 0,
      duration,
      ts: Date.now(),
    };
  },

  /** 中断（Generator 的 return） */
  async interrupt() {
    return { ok: true, message: 'Echo interrupted' };
  },
};

// adapters/human-bridge.mjs — 人工桥接适配器（GUI 型 Agent 无 CLI，唯一通路）
// Trae / Trae SOLO / WorkBuddy 实测无 CLI，human-bridge 作为平级后端接入总线

/**
 * 人工桥接适配器
 * 流程：生成 briefing → 用户复制到剪贴板 → 在对方 GUI 执行 → 粘贴结果回写
 * 产出同等标记：meta.via = "human-bridge" + meta.untrusted = true
 */
export default {
  id: 'human-bridge',
  displayName: 'Human Bridge',
  outputProtocol: 'human-bridge',
  capabilityTags: ['human-judgment', 'gui-only'],

  async probe() {
    return {
      ok: true,
      status: 'available',
      resolved: null,
      version: '1.0.0',
      code: 0,
      error: null,
      checkedAt: Date.now(),
    };
  },

  /** 生成 briefing（供复制粘贴到 GUI Agent） */
  generateBriefing({ taskId, runId, prompt, context }) {
    const briefing = `[AWB Workbench Task]

Task ID: ${taskId}
Run ID: ${runId}
Time: ${new Date().toISOString()}

Instructions:
${prompt}

${context ? `Context:\n${context}\n` : ''}

---
完成后，将以上任务的执行结果粘贴回 AWB Workbench。
粘贴内容将作为此 Run 的唯一产出记录入总线。
`;
    return briefing;
  },

  /** 标记回执为来自 human-bridge */
  processReceipt({ taskId, runId, receiptText }) {
    return {
      type: 'run.completed',
      taskId,
      runId,
      agentId: 'human-bridge',
      text: receiptText,
      cost: 0,
      duration: 0,
      ts: Date.now(),
      meta: {
        untrusted: true,
        via: 'human-bridge',
        humanNote: 'Produced by GUI agent via human bridge. Verify before applying.',
      },
    };
  },

  async *run({ taskId, runId, prompt, cwd, onEvent }) {
    yield { type: 'run.started', taskId, runId, agentId: 'human-bridge', ts: Date.now() };
    yield { type: 'run.awaiting-human', taskId, runId, text: 'Task sent to clipboard. Paste results when ready.' };

    const briefing = this.generateBriefing({ taskId, runId, prompt });
    yield { type: 'run.briefing-ready', taskId, runId, briefing };

    // 等待用户在外部完成并通过总线回填（由 UI 层触发）
    // 这里直接 yield awaiting，无需等待
    yield { type: 'run.awaiting-human', taskId, runId, instruction: 'Copy the briefing above, complete in GUI agent, then paste result below.' };
  },

  async interrupt() {
    return { ok: true };
  },
};

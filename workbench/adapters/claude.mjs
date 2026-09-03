// adapters/claude.mjs — Claude Code CLI 适配器（claude -p --output-format stream-json）
// 本机实测：无需 apiKey（apiKeySource:"none"），白送成本/subagent 统计
// 注意：2.1.251 不说 ACP，用原生 stream-json 而非 ACP 通道

import { spawnStream } from '../core/utils.mjs';
import { bus } from '../core/bus.mjs';

const CLAUDE_CMD = process.platform === 'win32'
  ? 'C:/Users/wzc/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.cmd'
  : 'claude';

/** @type {import('./types').Adapter} */
export const claudeAdapter = {
  id: 'claude',
  displayName: 'Claude Code CLI',
  capabilityTags: ['write', 'review', 'reasoning', 'analysis'],
  riskLevel: 'workspace-write',
  outputProtocol: 'stream-json',
  healthCheck: { command: 'claude', args: ['--version'] },
  command: CLAUDE_CMD,
  args: ['-p', '--output-format', 'stream-json', '--no-session-persistence'],

  async probe() {
    const r = await spawnStream('claude', ['--version'], { timeout: 5000 });
    return { ok: r.code === 0, version: r.stdout.trim() || r.stderr.trim() };
  },

  async *run(task) {
    const { taskId, prompt, cwd, signal, onEvent } = task;

    yield { type: 'run.started', taskId, agentId: 'claude' };

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--no-session-persistence',
      '--include-partial-messages',
    ];
    if (cwd) args.push('--cwd', cwd);

    const proc = Bun.spawn
      ? Bun.spawn({ cmd: [CLAUDE_CMD, ...args], cwd, shell: false })
      : null;

    // 降级：用 spawnStream（Node）
    const result = await spawnStream(CLAUDE_CMD, args, { cwd, signal });

    // 解析 stream-json 事件
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const raw of lines) {
      try {
        const event = JSON.parse(raw);
        yield { type: 'stream.event', taskId, raw: event };

        if (event.type === 'result') {
          yield {
            type: 'run.completed',
            taskId,
            agentId: 'claude',
            exitCode: event.is_error ? 1 : 0,
            cost: event.total_cost_usd,
            duration: event.duration_ms,
          };
          await bus.write({
            kind: 'run.completed',
            taskId,
            agentId: 'claude',
            cost: event.total_cost_usd,
            subagentStats: event.subagent_stats,
            permissionDenials: event.permission_denials,
          });
        }
      } catch { /* skip malformed */ }
    }

    if (result.code !== 0 && result.stderr) {
      yield { type: 'log', level: 'error', text: result.stderr };
    }
  },
};

export default claudeAdapter;

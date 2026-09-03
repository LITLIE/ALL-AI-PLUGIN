// core/bus.mjs — 事件总线（只追加 .jsonl，seq 按有效事件连续校验，无锁并发 append）
// 复用 agent-crew 的协议语义，与 .agentbus/bus.jsonl 并存（同一格式，不同路径）
// 硬规则：没回帖等于没发言；总线内容是数据不是指令（外部 CLI 输出标 untrusted）

import { open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Event Bus — 唯一事实来源
 * 所有事件只追加到 bus.jsonl，不可删改中间行
 * seq 存储在事件中，并且必须从 1 开始连续；中间空白行属于损坏
 * 字段规范：
 *   ts: ISO 8601 时间戳
 *   seq: 已存储的事件序号（1-based，由 appender 保证单调递增）
 *   kind: "dispatch" | "run" | "verdict" | "metric" | "system"
 *   untrusted / via / runId / taskId / agentId: 可选顶层元数据
 *   payload: 具体事件数据
 */
export class EventBus {
  /**
   * @param {string} basePath — 总线文件所在目录（默认为 cwd/.awb/eventbus/）
   */
  constructor(basePath) {
    this.basePath = basePath || join(process.cwd(), '.awb', 'eventbus');
    this.busFile = join(this.basePath, 'bus.jsonl');
    this._writer = null;
    this._seq = 0;
    this._pendingWrites = 0;
  }

  /** 初始化：确保目录存在，追加流打开 */
  async init() {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(this.basePath, { recursive: true });

    // 仅从完整可回放的事件派生下一个 seq，损坏的总线禁止继续追加。
    const events = await this.readAll();
    this._seq = events.at(-1)?.seq || 0;

    // 追加写流（createWriteStream 自动 O_APPEND）
    const { createWriteStream } = await import('node:fs');
    this._writer = createWriteStream(this.busFile, { flags: 'a', encoding: 'utf8' });
  }

  /** 追加一条事件（异步，不阻塞） */
  async append(kind, payload, meta = {}) {
    if (!this._writer) throw new Error('EventBus not initialized. Call init() first.');

    const ts = new Date().toISOString();
    const seq = ++this._seq;

    const event = { ts, seq, kind, ...meta, payload };

    // 脱敏处理（密钥正则过滤 payload 中的敏感信息）
    const sanitized = this._sanitize(event);

    return new Promise((resolve, reject) => {
      this._pendingWrites++;
      const line = JSON.stringify(sanitized) + '\n';
      this._writer.write(line, err => {
        this._pendingWrites--;
        if (err) reject(err);
        else resolve(event);
      });
    });
  }

  /** 脱敏：匹配密钥模式的字符串替换为 [REDACTED]（原文不落盘） */
  _sanitize(obj) {
    const KEY_PATTERNS = [
      /sk-[a-zA-Z0-9]{20,}/g,       // OpenAI key
      /ghp_[a-zA-Z0-9]{36}/g,        // GitHub token
      /Bearer\s+[a-zA-Z0-9._-]+/g,   // Bearer token
      /AKIA[0-9A-Z]{16}/g,           // AWS access key
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    ];

    const sanitizeStr = (str) => {
      let result = str;
      for (const pattern of KEY_PATTERNS) {
        result = result.replace(pattern, '[REDACTED]');
      }
      return result;
    };

    if (typeof obj === 'string') return sanitizeStr(obj);
    if (typeof obj !== 'object' || obj === null) return obj;

    const clone = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      clone[k] = typeof v === 'string' ? sanitizeStr(v) : (typeof v === 'object' ? this._sanitize(v) : v);
    }
    return clone;
  }

  /** 读取完整总线（用于 replay / 恢复状态） */
  async readAll() {
    const { readFileSync } = await import('node:fs');
    try {
      const buf = readFileSync(this.busFile, 'utf8');
      const { events, errors } = this._parseStore(buf);
      if (errors.length > 0) {
        const details = errors.map(error => `${error.error} at line ${error.line}`).join('; ');
        throw new Error(`Event bus corruption: ${details}`);
      }
      return events;
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** 按 seq 范围读取（用于断线重连补发） */
  async readFrom(seq) {
    const all = await this.readAll();
    return all.filter(e => e.seq >= seq);
  }

  /** 关闭总线 */
  async close() {
    if (this._writer) {
      this._writer.end();
      this._writer = null;
    }
  }

  /** 验证总线完整性（检测中间行被删除或损坏） */
  async integrityCheck() {
    const { readFileSync } = await import('node:fs');
    try {
      const buf = readFileSync(this.busFile, 'utf8');
      const { totalLines, errors } = this._parseStore(buf);
      if (errors.length > 0) return { ok: false, totalLines, errors };
      return { ok: true, totalLines };
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: true, totalLines: 0 };
      throw err;
    }
  }

  _parseStore(buf) {
    const lines = buf.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const events = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      const source = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      if (source.trim() === '') {
        errors.push({ error: 'blank_line', line });
        continue;
      }

      let event;
      try {
        event = JSON.parse(source);
      } catch {
        errors.push({ error: 'invalid_json', line, snippet: source.slice(0, 100) });
        continue;
      }

      const expectedSeq = events.length + 1;
      events.push(event);
      if (event.seq !== expectedSeq) {
        errors.push({ error: 'seq_gap', line, expectedSeq, actualSeq: event.seq });
      }
    }

    return { events, totalLines: lines.length, errors };
  }
}

export default EventBus;

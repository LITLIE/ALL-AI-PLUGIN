// 回归测试：适配器构建 spawn 计划时不得覆盖 spawnPlan 产出的完整参数。
// 历史 bug：`{ ...spawnPlan(...), args, command }` 会把含 /d /s /c 的 cmd 路由参数
// 覆盖成原始模板，导致真实执行变成裸 `cmd.exe <模板>`（打印横幅 + More?，Agent 从未启动）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configuredPlan } from '../adapters/claude-stream-json.mjs';
import { commandPlan } from '../adapters/codex-app-server.mjs';

// 在 PATH 前插入一个临时 .cmd shim 目录，模拟 npm 安装的 Windows 命令包装脚本。
async function withShimOnPath(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'awb-shim-'));
  await writeFile(join(dir, 'fake-agent.cmd'), '@echo off\r\nnode %*\r\n');
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${dir};${originalPath || ''}`;
    await fn(dir);
  } finally {
    process.env.PATH = originalPath;
  }
}

test('claude configuredPlan keeps /d /s /c shim args and exposes substituted templates', async () => {
  await withShimOnPath(async (dir) => {
    const plan = configuredPlan({ command: 'fake-agent', args: ['-p', '{{prompt}}'] }, { prompt: 'hello world' });
    assert.equal(plan.viaShell, true);
    assert.equal(plan.file.toLowerCase().endsWith('cmd.exe'), true);
    assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(plan.args.includes(resolve(dir, 'fake-agent.cmd')));
    assert.ok(plan.args.includes('hello world'));
    assert.deepEqual(plan.templates, ['-p', 'hello world']);
  });
});

test('codex commandPlan keeps /d /s /c shim args and exposes substituted templates', async () => {
  await withShimOnPath(async (dir) => {
    const plan = commandPlan({ command: 'fake-agent', args: ['app-server'] }, {}, ['app-server']);
    assert.equal(plan.viaShell, true);
    assert.equal(plan.file.toLowerCase().endsWith('cmd.exe'), true);
    assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(plan.args.includes(resolve(dir, 'fake-agent.cmd')));
    assert.ok(plan.args.includes('app-server'));
    assert.deepEqual(plan.templates, ['app-server']);
  });
});

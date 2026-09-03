// Filesystem layout for the agent-crew message bus.
// Everything the crew shares lives under <project>/.agentbus so it can be
// inspected, diffed and committed like any other project artifact.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function projectRoot() {
  const raw = process.env.AGENTBUS_PROJECT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.resolve(raw);
}

export function busDir() {
  return process.env.AGENTBUS_DIR
    ? path.resolve(process.env.AGENTBUS_DIR)
    : path.join(projectRoot(), '.agentbus');
}

export function paths() {
  const dir = busDir();
  return {
    project: projectRoot(),
    dir,
    roles: path.join(dir, 'roles.json'),
    bus: path.join(dir, 'bus.jsonl'),
    state: path.join(dir, 'state.json'),
    artifacts: path.join(dir, 'artifacts'),
    runs: path.join(dir, 'runs'),
  };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write via temp file + rename so a crashed writer can never leave a
// half-written registry or cursor file behind.
export function writeJson(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function ensureBus() {
  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true });
  fs.mkdirSync(p.artifacts, { recursive: true });
  fs.mkdirSync(p.runs, { recursive: true });
  if (!fs.existsSync(p.bus)) fs.writeFileSync(p.bus, '', 'utf8');
  if (!fs.existsSync(p.state)) writeJson(p.state, { cursors: {}, updated: new Date().toISOString() });
  return p;
}

export function tmpDir() {
  return process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
}

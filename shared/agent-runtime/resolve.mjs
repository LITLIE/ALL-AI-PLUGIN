import fs from 'node:fs';
import path from 'node:path';

function settings(options = {}) {
  const platform = options.platform || process.platform;
  const windows = platform === 'win32';
  return {
    platform,
    windows,
    pathValue: options.pathValue ?? process.env.PATH ?? '',
    pathext: options.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    comSpec: options.comSpec ?? process.env.ComSpec ?? 'cmd.exe',
  };
}

function hasExplicitPath(command, windows) {
  return command.includes('/') || command.includes('\\') || (windows && /^[A-Za-z]:[\\/]/.test(command));
}

function findCandidate(base, config) {
  if (fs.existsSync(base) && (path.extname(base) || !config.windows)) return base;
  if (!config.windows) return fs.existsSync(base) ? base : null;
  for (const ext of config.pathext.split(';').filter(Boolean)) {
    const candidates = [base + ext.toLowerCase(), base + ext.toUpperCase()];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve a command against an injectable platform/PATH environment. */
export function resolveExecutable(command, options = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const config = settings(options);
  const value = command.trim();
  if (hasExplicitPath(value, config.windows)) return findCandidate(path.resolve(value), config);
  const delimiter = config.windows ? ';' : ':';
  for (const dir of config.pathValue.split(delimiter).filter(Boolean)) {
    const hit = findCandidate(path.join(dir, value), config);
    if (hit) return hit;
  }
  return null;
}

/** Build a shell-disabled process plan, routing only Windows cmd/bat shims. */
export function spawnPlan(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('spawnPlan: command is required');
  const config = settings(options);
  const resolved = resolveExecutable(command, options);
  const extension = path.extname(resolved || command).toLowerCase();
  const viaShell = config.windows && (extension === '.cmd' || extension === '.bat');
  const file = viaShell ? config.comSpec : (resolved || command);
  const plannedArgs = viaShell ? ['/d', '/s', '/c', resolved, ...args] : [...args];
  return {
    file,
    args: plannedArgs,
    command: file,
    shell: false,
    viaShell,
    shimmed: viaShell,
    resolved,
  };
}

export default { resolveExecutable, spawnPlan };

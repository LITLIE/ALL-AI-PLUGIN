// core/flags.mjs — 极简 CLI flag 解析（不引入依赖）
// 支持 --key value 与 --flag（无值）格式；不识别 --xx 形式以外的混合。

export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

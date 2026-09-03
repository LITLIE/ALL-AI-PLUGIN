const SHELL_METACHARS = /[&|<>^"`'%$()!\r\n]/;

export function hasShellMetachars(value) {
  return SHELL_METACHARS.test(String(value || ''));
}

export function substituteArgs(args = [], vars = {}) {
  return args.map(value => String(value).replace(/\{\{(\w+)\}\}/g, (match, key) => Object.hasOwn(vars, key) ? String(vars[key] ?? '') : match));
}

export default { hasShellMetachars, substituteArgs };

import { createHash } from 'node:crypto';
import { normalizePlan } from './dag.mjs';

export function extractPlanText(run = {}) {
  let text = typeof run.text === 'string' ? run.text.trim() : '';
  if (!text) return '';
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export function parsePlannerPlan(text, parentTask) {
  const source = extractPlanText({ text });
  let rawPlan;
  try {
    rawPlan = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: { code: 'invalid_plan_json', message: `Planner output is not valid JSON: ${error.message}` } };
  }
  return normalizePlan(rawPlan, parentTask);
}

export function hashPlannerText(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

export default { extractPlanText, parsePlannerPlan, hashPlannerText };

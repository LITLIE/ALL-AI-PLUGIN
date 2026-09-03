const prompt = await new Promise(resolve => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
});
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ type: 'system', subtype: 'init', session_id: 'fixture-session', model: 'fixture-model', tools: [] });
emit({ type: 'assistant', message: { content: [{ type: 'text', text: `echo:${prompt}` }] } });
emit({ type: 'result', subtype: 'success', result: `echo:${prompt}`, total_cost_usd: 0.01, duration_ms: 4, usage: { input_tokens: 1, output_tokens: 1 } });

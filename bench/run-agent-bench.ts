/** Run the real chat orchestrator against stable live-derived fixtures. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamChat } from '../src/lib/ai/client';
import { buildChatSystem } from '../src/lib/ai/prompt';
import type { AiChatEvent, AiSettings } from '../src/lib/ai/types';
import type { ToolCall } from '../src/lib/ai/tools';
import { AGENT_SCENARIOS } from './agent-scenarios';

const here = process.env.BENCH_DIR ?? dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.BENCH_API_KEY;
if (!apiKey) throw new Error('Set BENCH_API_KEY in the environment. It is never written to disk.');
const provider = (process.env.BENCH_PROVIDER ?? 'deepseek') as AiSettings['provider'];
const model = process.env.BENCH_MODEL ?? 'deepseek-chat';
const outputArg = process.env.BENCH_OUTPUT;
const outputPath = outputArg
  ? (isAbsolute(outputArg) ? outputArg : join(process.cwd(), outputArg))
  : join(here, 'out', 'agent-results.json');
const settings: AiSettings = { provider, model, apiKeyEnc: '' };
const selectedIds = new Set((process.env.BENCH_SCENARIOS ?? '').split(',').map(value => value.trim()).filter(Boolean));
const scenarios = selectedIds.size ? AGENT_SCENARIOS.filter(scenario => selectedIds.has(scenario.id)) : AGENT_SCENARIOS;

const results = [];
for (const scenario of scenarios) {
  const calls: ToolCall[] = [];
  const events: AiChatEvent[] = [];
  let answer = '';
  const started = Date.now();
  const { system } = buildChatSystem(scenario.envelope);
  await streamChat({
    settings,
    apiKey,
    system,
    history: scenario.history ?? [],
    text: scenario.prompt,
    onEvent(event) {
      events.push(event);
      if (event.kind === 'text-delta') answer += event.delta;
    },
    executeTool: async (call) => {
      calls.push(call);
      return scenario.execute(call);
    },
  });

  const names = calls.map(call => call.name);
  const errors: string[] = [];
  if (calls.length > scenario.maxCalls) errors.push(`used ${calls.length} tools; max ${scenario.maxCalls}`);
  scenario.expectedPrefix.forEach((name, index) => {
    if (names[index] !== name) errors.push(`tool ${index + 1}: expected ${name}, got ${names[index] ?? '(none)'}`);
  });
  const forbidden = names.filter(name => scenario.forbiddenTools.includes(name));
  if (forbidden.length) errors.push(`forbidden tools: ${forbidden.join(', ')}`);
  for (const pattern of scenario.answerPatterns) {
    if (!pattern.test(answer)) errors.push(`answer missing ${pattern}`);
  }
  const providerError = events.find(event => event.kind === 'error');
  if (providerError?.kind === 'error') errors.push(`provider: ${providerError.message}`);

  const result = {
    id: scenario.id,
    description: scenario.description,
    passed: errors.length === 0,
    errors,
    ms: Date.now() - started,
    calls: calls.map(call => ({ name: call.name, input: call.input })),
    answer,
  };
  results.push(result);
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} ${result.ms}ms tools=[${names.join(' → ')}]${errors.length ? ` ${errors.join('; ')}` : ''}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify({ provider, model, generatedAt: new Date().toISOString(), results }, null, 2));
const passed = results.filter(result => result.passed).length;
console.log(`\n${passed}/${results.length} passed; output=${outputPath}`);
if (passed !== results.length) process.exitCode = 1;

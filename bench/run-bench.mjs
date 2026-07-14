/**
 * Run the EC-correctness benchmark against any provider supported by the
 * extension, using its real chat system prompts (bench/out/prompts.json,
 * produced by bundle.mjs).
 *
 * One plain chat completion per (config, task) — no tools, default
 * temperature — mirroring the pure-knowledge path of the chat pipeline.
 *
 * Usage:
 *   BENCH_PROVIDER=deepseek BENCH_API_KEY=... node bench/run-bench.mjs
 *
 * The API key is read from the environment only; it is never written to disk.
 * Output: bench/out/results.json (replies + extracted fenced snippets +
 * usage/latency per call).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const PROVIDERS = JSON.parse(readFileSync(join(outDir, 'providers.json'), 'utf8'));
const KEY_ENVS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  grok: 'XAI_API_KEY',
};

const PROVIDER = (process.env.BENCH_PROVIDER || 'deepseek').toLowerCase();
const provider = PROVIDERS[PROVIDER];
if (!provider) {
  console.error(`Unknown BENCH_PROVIDER=${PROVIDER}. Choose: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}
const keyEnv = KEY_ENVS[PROVIDER];
const API_KEY = process.env.BENCH_API_KEY || process.env[keyEnv];
if (!API_KEY) {
  console.error(`Set BENCH_API_KEY or ${keyEnv} in the environment.`);
  process.exit(1);
}
const BASE_URL = (process.env.BENCH_BASE_URL || provider.baseUrl).replace(/\/$/, '');
const MODEL = process.env.BENCH_MODEL
  || (PROVIDER === 'deepseek' ? process.env.DEEPSEEK_MODEL : null)
  || provider.defaultModel;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || 4);

const prompts = JSON.parse(readFileSync(join(outDir, 'prompts.json'), 'utf8'));

/** Optional subset filters (cheap re-runs):
 *    --config=a,b   only these configs
 *    --tasks=id1,id2  only these task ids
 *  With no flags, runs the full suite (all tasks x the two primary configs,
 *  plus the primer subset). */
function argVal(name) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(',').map(s => s.trim()).filter(Boolean) : null;
}
function argString(name) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : null;
}
const onlyConfigs = argVal('--config');
const onlyTasks = argVal('--tasks');
const advancedOnly = process.argv.includes('--advanced');
const repeats = Math.max(1, Number(argString('--repeats') || 1));
const outputArg = argString('--output');
const thinking = argString('--thinking') || 'default';
if (!['default', 'enabled', 'disabled'].includes(thinking)) {
  throw new Error('--thinking must be default, enabled, or disabled');
}
if (thinking !== 'default' && PROVIDER !== 'deepseek') {
  throw new Error('--thinking is a DeepSeek-only benchmark control');
}
const wantConfig = c => !onlyConfigs || onlyConfigs.includes(c);
const wantTask = t => (!onlyTasks || onlyTasks.includes(t.id)) && (!advancedOnly || t.advanced === true);

/** (config, task) pairs to run. Full task set on the two primary configs;
 *  the primer config re-runs only the primer-sensitive subset. */
const jobs = [];
for (const config of ['selection-scorecard', 'synthetic-scorecard', 'no-context']) {
  if (!prompts[config] || !wantConfig(config)) continue;
  for (const t of TASKS) {
    if (!wantTask(t)) continue;
    for (let sample = 1; sample <= repeats; sample++) jobs.push({ config, task: t, sample });
  }
}
if (prompts['no-context-primer'] && wantConfig('no-context-primer')) {
  for (const t of TASKS.filter(t => t.primer)) {
    if (!wantTask(t)) continue;
    for (let sample = 1; sample <= repeats; sample++) jobs.push({ config: 'no-context-primer', task: t, sample });
  }
}

/** All fenced code blocks (lang tag + body), mirroring prompt.ts matchFences. */
function fences(reply) {
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(reply)) !== null) {
    out.push({ lang: m[1].trim(), code: m[2].replace(/\n$/, '') });
  }
  return out;
}

function normalizeAnthropicUsage(usage) {
  return {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    prompt_cache_hit_tokens: usage?.cache_read_input_tokens ?? 0,
    prompt_cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

async function callOpenAiCompat(system, user) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(thinking === 'default' ? {} : { thinking: { type: thinking } }),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const ms = Date.now() - t0;
  return { ms, usage: body.usage, reply: body.choices?.[0]?.message?.content ?? '' };
}

async function callAnthropic(system, user) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const ms = Date.now() - t0;
  const reply = (body.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text ?? '')
    .join('');
  return { ms, usage: normalizeAnthropicUsage(body.usage), reply };
}

function callOnce(system, user) {
  return provider.openAiCompat
    ? callOpenAiCompat(system, user)
    : callAnthropic(system, user);
}

async function runJob(job) {
  const system = prompts[job.config].system;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await callOnce(system, job.task.prompt);
      return {
        provider: PROVIDER,
        model: MODEL,
        config: job.config,
        taskId: job.task.id,
        sample: job.sample,
        category: job.task.category,
        kind: job.task.kind,
        ms: r.ms,
        usage: r.usage,
        reply: r.reply,
        snippets: fences(r.reply),
      };
    } catch (e) {
      if (attempt >= 3) {
        return { provider: PROVIDER, model: MODEL, config: job.config, taskId: job.task.id, error: String(e) };
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await runJob(job);
    results.push(r);
    console.log(`[${results.length}/${jobs.length}] ${r.config} ${r.taskId} ` +
      (r.error ? `ERROR ${r.error}` : `${r.ms}ms out=${r.usage?.completion_tokens}t snippets=${r.snippets.length}`));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

results.sort((a, b) => a.config.localeCompare(b.config) || a.taskId.localeCompare(b.taskId) || a.sample - b.sample);
const outputPath = outputArg
  ? (isAbsolute(outputArg) ? outputArg : join(process.cwd(), outputArg))
  : join(outDir, 'results.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(results, null, 2));

const ok = results.filter(r => !r.error);
const totIn = ok.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0);
const totOut = ok.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0);
const cacheHit = ok.reduce((s, r) => s + (r.usage?.prompt_cache_hit_tokens ?? 0), 0);
const msArr = ok.map(r => r.ms).sort((a, b) => a - b);
console.log(`\ncalls=${ok.length} errors=${results.length - ok.length}`);
console.log(`provider=${PROVIDER} model=${MODEL} thinking=${thinking} repeats=${repeats} output=${outputPath}`);
console.log(`tokens: in=${totIn} (cacheHit=${cacheHit}) out=${totOut}`);
console.log(`latency ms: min=${msArr[0]} median=${msArr[Math.floor(msArr.length / 2)]} max=${msArr[msArr.length - 1]}`);

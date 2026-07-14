/**
 * Run the EC-correctness benchmark against DeepSeek using the extension's
 * real chat system prompts (bench/out/prompts.json, produced by bundle.mjs).
 *
 * One plain chat completion per (config, task) — no tools, default
 * temperature — mirroring the pure-knowledge path of the chat pipeline.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... node bench/run-bench.mjs
 *
 * The API key is read from the environment only; it is never written to disk.
 * Output: bench/out/results.json (replies + extracted fenced snippets +
 * usage/latency per call).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('Set DEEPSEEK_API_KEY in the environment.');
  process.exit(1);
}
const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
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

async function callOnce(system, user) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
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

async function runJob(job) {
  const system = prompts[job.config].system;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await callOnce(system, job.task.prompt);
      return {
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
      if (attempt >= 3) return { config: job.config, taskId: job.task.id, error: String(e) };
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
console.log(`model=${MODEL} thinking=${thinking} repeats=${repeats} output=${outputPath}`);
console.log(`tokens: in=${totIn} (cacheHit=${cacheHit}) out=${totOut}`);
console.log(`latency ms: min=${msArr[0]} median=${msArr[Math.floor(msArr.length / 2)]} max=${msArr[msArr.length - 1]}`);

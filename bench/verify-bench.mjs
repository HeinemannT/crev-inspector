/**
 * Execute benchmark snippets through the live read-only bridge and grade their
 * observable result. This deliberately uses deterministic program execution as
 * the primary grader; static checks cover intent that a successful preview
 * cannot prove (for example, avoiding a known-broken helper).
 *
 * Examples:
 *   CREV_SERVERS_FILE=../crev/servers.json node bench/verify-bench.mjs --references
 *   CREV_SERVERS_FILE=../crev/servers.json node bench/verify-bench.mjs --input=/tmp/baseline.json
 */
import { readFileSync } from 'node:fs';
import { TASKS } from './tasks.mjs';

function argString(name) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : null;
}

function targetFromEnv() {
  const bridgeUrl = process.env.CREV_BRIDGE_URL || 'http://127.0.0.1:4100';
  const file = process.env.CREV_SERVERS_FILE;
  if (!file) throw new Error('Set CREV_SERVERS_FILE to the ignored CREV servers.json.');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const serverId = process.env.CREV_SERVER_ID || 'steadfast';
  const server = parsed.servers?.find(item => item.id === serverId);
  const actors = parsed.credentials?.[serverId];
  const actor = process.env.CREV_SERVER_ACTOR || parsed.activeIds?.[serverId] || (actors ? Object.keys(actors)[0] : null);
  const credential = actor ? actors?.[actor] : null;
  if (!server?.bmpUrl || !credential?.bmpUser || !credential?.bmpPass) {
    throw new Error(`No complete ${serverId}/${actor || '(no actor)'} target in CREV_SERVERS_FILE.`);
  }
  return {
    bridgeUrl,
    bmpUrl: server.bmpUrl.endsWith('/') ? server.bmpUrl : `${server.bmpUrl}/`,
    bmpUser: credential.bmpUser,
    bmpPass: credential.bmpPass,
  };
}

async function preview(target, code) {
  const response = await fetch(`${target.bridgeUrl}/extended`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      bmp_url: target.bmpUrl,
      bmp_user: target.bmpUser,
      bmp_pass: target.bmpPass,
      transactional: false,
    }),
  });
  const body = await response.json();
  const log = Array.isArray(body.result?.log) ? body.result.log.join('\n') : body.result?.log || '';
  if (!response.ok || !body.ok || body.result?.has_error) {
    throw new Error(body.error || log || `Bridge HTTP ${response.status}`);
  }
  return log;
}

async function assertBridgeHealth(target) {
  try {
    const response = await fetch(`${target.bridgeUrl}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Bridge unavailable at ${target.bridgeUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonical(value) {
  return String(value)
    .replace(/[╔╗╚╝═╤╧╠╣╟╢─┼│║]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function snippetFrom(result) {
  const snippets = Array.isArray(result.snippets) ? result.snippets : [];
  for (let i = snippets.length - 1; i >= 0; i--) {
    if (/^(extended|ec)$/i.test(snippets[i]?.lang || '') && snippets[i]?.code?.trim()) return snippets[i].code;
  }
  for (let i = snippets.length - 1; i >= 0; i--) {
    if (typeof snippets[i]?.code === 'string' && snippets[i].code.trim()) return snippets[i].code;
  }
  return null;
}

async function grade(target, task, code) {
  const failures = [];
  for (const forbidden of task.forbidCode || []) {
    if (code.includes(forbidden)) failures.push(`forbidden code: ${forbidden}`);
  }
  for (const required of task.requireCode || []) {
    if (!code.includes(required)) failures.push(`missing code: ${required}`);
  }
  let log = '';
  try {
    log = await preview(target, code);
    const actual = canonical(log);
    for (const expected of task.resultIncludes || []) {
      if (!actual.includes(canonical(expected))) failures.push(`result missing: ${expected}`);
    }
  } catch (error) {
    failures.push(`preview: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { pass: failures.length === 0, failures, log };
}

const target = targetFromEnv();
await assertBridgeHealth(target);
const advanced = TASKS.filter(task => task.advanced);
const references = process.argv.includes('--references');
let jobs;
if (references) {
  jobs = advanced.map(task => ({ task, code: task.referenceCode, label: task.id }));
} else {
  const input = argString('--input');
  if (!input) throw new Error('Pass --input=<results.json> or --references.');
  const results = JSON.parse(readFileSync(input, 'utf8'));
  const byId = new Map(advanced.map(task => [task.id, task]));
  jobs = results
    .filter(result => byId.has(result.taskId))
    .map(result => ({
      task: byId.get(result.taskId),
      code: snippetFrom(result),
      label: `${result.config}/${result.taskId}#${result.sample || 1}`,
    }));
}

let passed = 0;
for (const job of jobs) {
  if (!job.code) {
    console.log(`FAIL ${job.label}: no non-empty fenced code block`);
    continue;
  }
  const result = await grade(target, job.task, job.code);
  if (result.pass) {
    passed++;
    console.log(`PASS ${job.label}`);
  } else {
    console.log(`FAIL ${job.label}: ${result.failures.join(' | ')}`);
  }
}

console.log(`\nscore=${passed}/${jobs.length} (${jobs.length ? Math.round(100 * passed / jobs.length) : 0}%)`);
if (passed !== jobs.length) process.exitCode = 1;

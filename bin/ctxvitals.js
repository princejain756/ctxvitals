#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const VERSION = '0.1.0';
const HOME = os.homedir();
const TOK = (s) => Math.ceil(Buffer.byteLength(String(s || ''), 'utf8') / 4);

// ---------- args ----------
const args = process.argv.slice(2);
const opt = {
  json: args.includes('--json'),
  noProbe: args.includes('--no-probe'),
  html: getVal('--html'),
  badge: args.includes('--badge'),
  quiet: args.includes('-q') || args.includes('--quiet'),
  help: args.includes('-h') || args.includes('--help'),
};
function getVal(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith('-') ? v : 'ctxvitals-report.html';
}

if (opt.help) {
  console.log(`ctxvitals ${VERSION} - vitals check for your AI agent stack

usage: ctxvitals [options]

  --probe / --no-probe   measure real token cost by launching stdio MCP
                         servers and reading tools/list (default: probe)
  --json                 machine-readable report to stdout
  --html [file]          write a shareable HTML report card
  --badge                print README badge markdown with your grade
  -q, --quiet            skip the terminal report
  -h, --help             this help

what it checks: skills, MCP servers, commands, agents, hooks, and rules
files across Claude Code, Cursor, Windsurf, Copilot, Codex, Devin, and
project-level .claude/.cursor/.devin/.agents dirs in the cwd.`);
  process.exit(0);
}

// ---------- discovery ----------
const CLIENT_DIRS = [
  ['claude', '.claude'],
  ['cursor', '.cursor'],
  ['windsurf', '.codeium/windsurf'],
  ['copilot', '.copilot'],
  ['devin', '.config/devin'],
  ['agents', '.agents'],
  ['codex', '.codex'],
  ['gemini', '.gemini'],
];

const MCP_CONFIGS = [
  ['claude-code', path.join(HOME, '.claude.json'), 'json.mcpServers'],
  ['cursor', path.join(HOME, '.cursor/mcp.json'), 'json.mcpServers'],
  ['windsurf', path.join(HOME, '.codeium/windsurf/mcp_config.json'), 'json.mcpServers'],
  ['claude-desktop', path.join(HOME, 'Library/Application Support/Claude/claude_desktop_config.json'), 'json.mcpServers'],
  ['project', path.join(process.cwd(), '.mcp.json'), 'json.mcpServers'],
  ['project-vscode', path.join(process.cwd(), '.vscode/mcp.json'), 'json.servers'],
  ['cursor-project', path.join(process.cwd(), '.cursor/mcp.json'), 'json.mcpServers'],
  ['codex', path.join(HOME, '.codex/config.toml'), 'toml'],
];

function* walk(dir, depth = 5) {
  if (depth < 0) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.') || depth === 5) yield* walk(p, depth - 1); }
    else { try { fs.statSync(p); yield p; } catch { } }
  }
}

function findSkillFiles(root) {
  const out = [];
  for (const p of walk(root)) if (path.basename(p) === 'SKILL.md') out.push(p);
  return out;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; fm[key] = kv[2].replace(/^["']|["']$/g, ''); }
    else if (key && /^\s/.test(line)) fm[key] += ' ' + line.trim();
  }
  return fm;
}

function collectInventory() {
  const items = { skills: [], commands: [], agents: [], rules: [], hooks: [], mcps: [] };
  const seen = new Set();

  const roots = [];
  for (const [client, rel] of CLIENT_DIRS) {
    const d = path.join(HOME, rel);
    if (fs.existsSync(d)) roots.push({ client, dir: d, scope: 'global' });
  }
  for (const rel of ['.claude', '.cursor', '.devin', '.agents', '.windsurf']) {
    const d = path.join(process.cwd(), rel);
    if (fs.existsSync(d)) roots.push({ client: rel.slice(1), dir: d, scope: 'project' });
  }

  for (const { client, dir, scope } of roots) {
    for (const f of findSkillFiles(dir)) {
      let real; try { real = fs.realpathSync(f); } catch { real = f; }
      if (seen.has(real)) continue;
      seen.add(real);
      const text = fs.readFileSync(f, 'utf8');
      const fm = parseFrontmatter(text);
      const body = text.replace(/^---[\s\S]*?---/, '');
      const skillDir = path.dirname(f);
      let extraBytes = 0;
      for (const p of walk(skillDir, 3)) {
        if (p === f) continue;
        try { extraBytes += fs.statSync(p).size; } catch { }
      }
      items.skills.push({
        kind: 'skill', client, scope, path: f, dir: skillDir,
        name: fm.name || path.basename(skillDir),
        description: fm.description || '',
        frontmatter: Object.keys(fm).filter(k => !['name', 'description'].includes(k)),
        alwaysTokens: TOK((fm.name || '') + (fm.description || '')),
        triggerTokens: TOK(body) + Math.ceil(extraBytes / 4),
        text, files: [...walk(skillDir, 3)],
      });
    }
    for (const sub of ['commands', 'agents']) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      for (const p of walk(d, 3)) {
        if (!p.endsWith('.md')) continue;
        let real; try { real = fs.realpathSync(p); } catch { real = p; }
        if (seen.has(real)) continue;
        seen.add(real);
        const text = fs.readFileSync(p, 'utf8');
        const fm = parseFrontmatter(text);
        (sub === 'commands' ? items.commands : items.agents).push({
          kind: sub, client, scope, path: p, name: fm.name || path.basename(p, '.md'),
          alwaysTokens: TOK(fm.description || ''), bodyTokens: TOK(text),
        });
      }
    }
    const settings = path.join(dir, 'settings.json');
    if (fs.existsSync(settings)) {
      try {
        const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
        if (s.hooks) items.hooks.push({ client, path: settings, count: Object.keys(s.hooks).length });
      } catch { }
    }
  }

  // rules files: always injected into context
  const rulePaths = [
    ['claude', path.join(process.cwd(), 'CLAUDE.md')],
    ['claude', path.join(HOME, '.claude/CLAUDE.md')],
    ['agents', path.join(process.cwd(), 'AGENTS.md')],
    ['codex', path.join(HOME, '.codex/AGENTS.md')],
    ['gemini', path.join(process.cwd(), 'GEMINI.md')],
    ['gemini', path.join(HOME, '.gemini/GEMINI.md')],
    ['cursor', path.join(process.cwd(), '.cursorrules')],
    ['windsurf', path.join(process.cwd(), '.windsurfrules')],
    ['windsurf', path.join(HOME, '.codeium/windsurf/memories/global_rules.md')],
  ];
  for (const rp of walk(path.join(process.cwd(), '.cursor/rules'), 3)) if (rp.endsWith('.mdc')) rulePaths.push(['cursor', rp]);
  for (const [client, p] of rulePaths) {
    if (!p || !fs.existsSync(p)) continue;
    let real; try { real = fs.realpathSync(p); } catch { real = p; }
    if (seen.has(real)) continue;
    seen.add(real);
    const text = fs.readFileSync(p, 'utf8');
    items.rules.push({ kind: 'rule', client, path: p, name: path.basename(p), alwaysTokens: TOK(text), text });
  }

  // MCP server configs
  const mcpSeen = new Set();
  for (const [source, cfgPath, kind] of MCP_CONFIGS) {
    if (!fs.existsSync(cfgPath)) continue;
    if (kind === 'toml') {
      const text = fs.readFileSync(cfgPath, 'utf8');
      for (const m of text.matchAll(/\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=\[|$)/g)) {
        const name = m[1].trim();
        if (mcpSeen.has(name)) continue;
        mcpSeen.add(name);
        const cmd = m[2].match(/command\s*=\s*"([^"]+)"/);
        items.mcps.push({ name, source, command: cmd ? cmd[1] : '', args: (m[2].match(/args\s*=\s*\[([^\]]*)\]/)?.[1] || '').split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean), env: {} });
      }
      continue;
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const servers = cfg.mcpServers || cfg.servers || {};
      for (const [name, def] of Object.entries(servers)) {
        if (mcpSeen.has(name)) continue;
        mcpSeen.add(name);
        items.mcps.push({
          name, source, command: def.command || '', args: def.args || [],
          env: def.env || {}, url: def.url || def.serverUrl || def.baseUrl || '',
          type: def.type || def.transport || 'stdio',
          cwd: def.cwd, raw: def,
        });
      }
    } catch { items.broken = items.broken || []; items.broken.push(cfgPath); }
  }
  return items;
}

// ---------- MCP probe: launch stdio servers, measure real schema cost ----------
function probeOne(def, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const done = (r) => { try { proc.kill('SIGKILL'); } catch { } resolve(r); };
    if (!def.command) return resolve({ ok: false, reason: 'remote-or-no-command' });
    let proc;
    try {
      proc = spawn(def.command, def.args, {
        env: { ...process.env, ...def.env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) { return resolve({ ok: false, reason: 'spawn-failed: ' + e.code }); }

    let buf = '';
    let sentToolsList = false;
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); done({ ok: false, reason: 'spawn-failed: ' + e.code }); });

    const send = (m) => { try { proc.stdin.write(JSON.stringify(m) + '\n'); } catch { } };
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          sentToolsList = true;
        } else if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          const tools = msg.result.tools || [];
          const schemaBytes = Buffer.byteLength(JSON.stringify(tools));
          done({ ok: true, tools: tools.length, schemaBytes, tokens: Math.ceil(schemaBytes / 4) });
          return;
        }
      }
    });
    proc.on('exit', () => { clearTimeout(timer); if (!sentToolsList) done({ ok: false, reason: 'exited-early' }); else done({ ok: false, reason: 'no-tools-list' }); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ctxvitals', version: VERSION } } });
  });
}

async function probeAll(mcps, concurrency = 4) {
  const queue = [...mcps];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const m = queue.shift();
      if (m.url) { m.probe = { ok: false, reason: 'remote' }; continue; }
      m.probe = await probeOne(m);
    }
  });
  await Promise.all(workers);
}

// ---------- security audit ----------
const SECRET_RE = /sk-ant-[a-zA-Z0-9_-]{20,}|sk-proj-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{40,}|ghp_[a-zA-Z0-9]{36}|xox[baprs]-[0-9][a-zA-Z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[a-zA-Z0-9_-]{20,}|sk_live_[a-zA-Z0-9]{16,}/;
const EXEC_FILE = /\.(sh|bash|py|js|ts|mjs|cjs|rb|pl)$/i;
const TEXT_FILE = /\.(md|markdown|txt|sh|bash|py|js|ts|mjs|cjs|rb|pl|yaml|yml|json|toml)$/i;

function auditSkills(skills) {
  const flags = [];
  const seen = new Set();
  const flag = (sev, where, why) => {
    const k = where + '|' + sev + '|' + why;
    if (!seen.has(k)) { seen.add(k); flags.push({ sev, where, why }); }
  };
  for (const s of skills) {
    for (const file of s.files) {
      if (!TEXT_FILE.test(file)) continue;
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const rel = path.basename(path.dirname(file)) + '/' + path.basename(file);
      const injection = /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i.test(text);
      if (/(curl|wget)[^|\n]*\|\s*(ba|z)?sh/i.test(text)) flag('high', rel, 'pipes remote content into a shell');
      if (injection) {
        const quoted = /["'`][^"'`]*ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i.test(text);
        flag(quoted ? 'medium' : 'high', rel, 'prompt-injection phrase' + (quoted ? ' (quoted — verify it is only an example)' : ''));
      }
      if (/(jailbreak|developer\s+mode\s+enabled|DAN\s+mode)/i.test(text)) flag('high', rel, 'prompt-injection phrase');
      if (SECRET_RE.test(text)) flag('high', rel, 'hardcoded secret pattern');
      if (/rm\s+-rf\s+[~/$*]/i.test(text)) flag('high', rel, 'recursive delete on home or root');
      if (/\.(ssh\/id_|aws\/credentials)/i.test(text)) flag('medium', rel, 'reads SSH keys or cloud credentials');
      if (/\bsudo\s+/i.test(text)) flag('medium', rel, 'requests elevated privileges');
      if (EXEC_FILE.test(file)) {
        const touchesCredentials = /\.ssh|\.aws\/|\/etc\/passwd|keychain|cookies?|Login Data|Local State|\.netrc|\.git-credentials|\.npmrc|wallet|mnemonic|seed phrase/i.test(text);
        const callsNet = /fetch\(|axios|requests\.(get|post)|urllib|https?:\/\/(?!localhost|127\.0\.0\.1)|curl\s|wget\s|socket\./i.test(text);
        if (touchesCredentials && callsNet) flag('high', rel, 'exfil pattern: touches credential stores and calls the network');
        if (/base64\s+(-d|--decode)|atob\s*\(|b64decode/i.test(text) && /exec|eval\s*\(|os\.system|\|\s*(ba)?sh/i.test(text)) flag('medium', rel, 'decodes and executes obfuscated content');
      }
    }
    if (s.frontmatter.includes('allowed-tools')) s.compatNote = 'Claude Code only (allowed-tools ignored elsewhere)';
    if (s.frontmatter.includes('hooks')) s.frontmatterNote = 'skill hooks run only in Claude Code';
  }
  return flags;
}

function auditMcps(mcps) {
  const flags = [];
  for (const m of mcps) {
    const joined = [m.command, ...(m.args || [])].join(' ');
    if ((/^npx\s/.test(joined) || joined.includes(' npx ')) && !/@\d/.test(joined) && !/@latest/.test(joined)) {
      flags.push({ sev: 'medium', where: 'mcp:' + m.name, why: 'unpinned npx package (supply-chain risk)' });
    }
    if (/uvx\s+[\w-]+$/.test(joined.trim())) {
      flags.push({ sev: 'medium', where: 'mcp:' + m.name, why: 'unpinned uvx package' });
    }
    if (m.url && /^http:\/\//.test(m.url) && !/localhost|127\./.test(m.url)) {
      flags.push({ sev: 'high', where: 'mcp:' + m.name, why: 'remote server over plain HTTP' });
    }
    for (const [k, v] of Object.entries(m.env || {})) {
      if (typeof v === 'string' && SECRET_RE.test(v) && !/your|\$\{|<[^>]+>|xxx|\*|placeholder|example|changeme/i.test(v)) {
        flags.push({ sev: 'medium', where: 'mcp:' + m.name, why: `plaintext secret in config env (${k})` });
      }
    }
    if (m.probe?.ok && m.probe.tools > 40) {
      flags.push({ sev: 'low', where: 'mcp:' + m.name, why: `${m.probe.tools} tools — some clients degrade past ~40` });
    }
    if (m.probe && !m.probe.ok && m.probe.reason === 'spawn-failed: ENOENT') {
      flags.push({ sev: 'medium', where: 'mcp:' + m.name, why: `command not found (${m.command}) — stale config` });
    }
  }
  // duplicate server detection: identical probed schema or identical command line
  const sigs = new Map();
  for (const m of mcps) {
    const sig = m.probe?.ok ? `p:${m.probe.tools}:${m.probe.schemaBytes}` : `c:${m.command}|${(m.args || []).join(' ')}`;
    if (sig === 'c:|' || sig === 'c:undefined|') continue;
    if (sigs.has(sig)) flags.push({ sev: 'low', where: 'mcp:' + m.name, why: `duplicate of mcp:${sigs.get(sig)} — paying schema cost twice` });
    else sigs.set(sig, m.name);
  }
  return flags;
}

// ---------- grade ----------
function grade(report) {
  let score = 100;
  const t = report.totalAlwaysTokens;
  score -= t < 2000 ? 0 : t < 10000 ? 2 : t < 25000 ? 6 : t < 60000 ? 12 : t < 120000 ? 20 : 30;
  score -= Math.min(12, Math.max(0, report.mcpCount - 10) * 3);
  score -= Math.min(45, report.security.filter(f => f.sev === 'high').length * 15);
  score -= Math.min(20, report.security.filter(f => f.sev === 'medium').length * 5);
  score -= Math.min(5, report.security.filter(f => f.sev === 'low').length);
  score -= (report.broken || []).length * 5;
  score = Math.max(0, Math.min(100, score));
  const letter = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'F';
  return { score, letter };
}

const BADGE_COLOR = { A: 'brightgreen', B: 'green', C: 'yellow', D: 'orange', F: 'red' };
const badgeMd = (g) => `[![CTX Vitals: ${g.letter}](https://img.shields.io/badge/ctxvitals-${g.letter}%20${g.score}%2F100-${BADGE_COLOR[g.letter]})](https://github.com/princejain756/ctxvitals)`;

// ---------- report ----------
const fmt = (n) => n.toLocaleString('en-US');
const pad = (s, n) => String(s).padEnd(n);
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const GC = { A: C.green, B: C.green, C: C.yellow, D: C.red, F: C.red };

function renderTerminal(rep, g) {
  const L = [];
  const bar = '═'.repeat(58);
  L.push(`${C.bold}CTX VITALS${C.reset} ${C.dim}v${VERSION} · ${os.hostname().split('.')[0]} · ${rep.date}${C.reset}`);
  L.push(bar);
  L.push(`GRADE: ${GC[g.letter]}${C.bold}${g.letter}${C.reset} ${C.dim}(${g.score}/100)${C.reset}`);
  L.push('');
  L.push(`${C.bold}CONTEXT BILL${C.reset} ${C.dim}— tokens burned before the first message${C.reset}`);
  const rows = rep.costRows.slice(0, 12);
  for (const r of rows) {
    const tag = r.probed ? `${C.green}probed${C.reset}` : r.probed === false ? `${C.dim}static${C.reset}` : '';
    L.push(`  ${C.cyan}${fmt(r.tokens).padStart(7)}${C.reset} tok  ${pad(r.label, 44)} ${tag}`);
  }
  if (rep.costRows.length > rows.length) L.push(`  ${C.dim}… ${rep.costRows.length - rows.length} more${C.reset}`);
  L.push(`  ${'─'.repeat(50)}`);
  L.push(`  ${C.bold}${fmt(rep.totalAlwaysTokens).padStart(7)}${C.reset} ${C.bold}tokens every turn${C.reset}`);
  L.push('');
  L.push(`${C.bold}INVENTORY${C.reset}`);
  L.push(`  skills ${rep.skillCount} (${fmt(rep.skillAlwaysTokens)} tok always) · commands ${rep.commandCount} · agents ${rep.agentCount}`);
  L.push(`  mcp servers ${rep.mcpCount} (${rep.probedOk} probed${rep.remoteCount ? `, ${rep.remoteCount} remote` : ''}${rep.failedProbes ? `, ${C.yellow}${rep.failedProbes} failed${C.reset}` : ''}) · hooks ${rep.hookCount} · rules ${rep.ruleCount}`);
  if (rep.broken?.length) L.push(`  ${C.yellow}broken configs: ${rep.broken.join(', ')}${C.reset}`);
  L.push('');
  if (rep.security.length) {
    L.push(`${C.bold}SECURITY${C.reset}`);
    for (const f of rep.security.slice(0, 15)) {
      const col = f.sev === 'high' ? C.red : f.sev === 'medium' ? C.yellow : C.dim;
      L.push(`  ${col}${f.sev.toUpperCase().padEnd(7)}${C.reset} ${pad(f.where, 40)} ${C.dim}${f.why}${C.reset}`);
    }
    if (rep.security.length > 15) L.push(`  ${C.dim}… ${rep.security.length - 15} more flags${C.reset}`);
    L.push('');
  }
  L.push(`${C.bold}TOP OFFENDERS${C.reset}`);
  rep.costRows.slice(0, 3).forEach((r, i) => L.push(`  ${i + 1}. ${r.label} — ${fmt(r.tokens)} tok`));
  L.push('');
  L.push(C.dim + badgeMd(g) + C.reset);
  L.push(`${C.dim}shareable report: ctxvitals --html report.html${C.reset}`);
  return L.join('\n');
}

function renderHtml(rep, g) {
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const color = BADGE_COLOR[g.letter] === 'brightgreen' ? '#2ea043' : BADGE_COLOR[g.letter];
  const rows = rep.costRows.map(r => `<tr><td class="n">${fmt(r.tokens)}</td><td>${esc(r.label)}</td><td>${r.probed ? 'probed' : 'static'}</td></tr>`).join('');
  const secs = rep.security.map(f => `<tr><td class="${f.sev}">${f.sev.toUpperCase()}</td><td>${esc(f.where)}</td><td>${esc(f.why)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>CTX Vitals — ${g.letter}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1c1c1e}
h1{font-size:20px}.grade{font-size:64px;font-weight:700;color:${color};margin:8px 0}.grid{display:flex;gap:24px;align-items:center}
table{border-collapse:collapse;width:100%;margin:12px 0}td{padding:4px 8px;border-bottom:1px solid #eee}.n{text-align:right;font-variant-numeric:tabular-nums;color:#0366d6}
.high{color:#d73a49;font-weight:600}.medium{color:#e36209}.low{color:#6a737d}.total{font-size:18px;font-weight:600}
.meta{color:#6a737d;font-size:13px}a{color:#0366d6}</style>
<h1>CTX Vitals</h1><div class="meta">${esc(os.hostname().split('.')[0])} · ${rep.date} · ctxvitals ${VERSION}</div>
<div class="grid"><div class="grade">${g.letter}</div><div><div class="total">${g.score}/100</div>
<div class="total">${fmt(rep.totalAlwaysTokens)} tokens burned every turn</div>
<div class="meta">${rep.skillCount} skills · ${rep.mcpCount} MCP servers · ${rep.commandCount} commands · ${rep.agentCount} agents · ${rep.ruleCount} rules</div></div></div>
<h3>Context bill</h3><table><tr><th></th><th align="left">item</th><th align="left">measured</th></tr>${rows}</table>
${secs ? `<h3>Security flags</h3><table>${secs}</table>` : '<h3>Security flags</h3><p>none</p>'}
<p class="meta">generated by <a href="https://github.com/princejain756/ctxvitals">ctxvitals</a> — run yours: <code>npx ctxvitals</code></p>`;
}

// ---------- main ----------
(async () => {
  const inv = collectInventory();

  if (!opt.noProbe) {
    const probeTargets = inv.mcps.filter(m => m.command && !m.url);
    if (probeTargets.length && !opt.json && !opt.quiet) process.stderr.write(`probing ${probeTargets.length} MCP servers…\n`);
    await probeAll(probeTargets);
  }

  const security = [...auditSkills(inv.skills), ...auditMcps(inv.mcps)];

  const costRows = [];
  for (const m of inv.mcps) {
    if (m.probe?.ok) costRows.push({ label: `MCP ${m.name} (${m.probe.tools} tools)`, tokens: m.probe.tokens, probed: true });
    else if (m.url) costRows.push({ label: `MCP ${m.name} (remote)`, tokens: 0, probed: null });
    else if (m.probe) costRows.push({ label: `MCP ${m.name} (${m.probe.reason})`, tokens: 0, probed: null });
  }
  for (const r of inv.rules) costRows.push({ label: r.name + ' (rule)', tokens: r.alwaysTokens, probed: false });
  if (inv.skills.length) costRows.push({ label: `skill descriptions ×${inv.skills.length}`, tokens: inv.skills.reduce((a, s) => a + s.alwaysTokens, 0), probed: false });
  for (const c of inv.commands) if (c.alwaysTokens > 40) costRows.push({ label: `/${c.name} (cmd desc)`, tokens: c.alwaysTokens, probed: false });
  const shown = costRows.filter(r => r.tokens > 0 || r.probed === true);
  costRows.length = 0; costRows.push(...shown);
  costRows.sort((a, b) => b.tokens - a.tokens);

  const rep = {
    date: new Date().toISOString().slice(0, 10),
    host: os.hostname(),
    costRows,
    totalAlwaysTokens: costRows.reduce((a, r) => a + r.tokens, 0),
    skillCount: inv.skills.length,
    skillAlwaysTokens: inv.skills.reduce((a, s) => a + s.alwaysTokens, 0),
    skillTriggerTokens: inv.skills.reduce((a, s) => a + s.triggerTokens, 0),
    commandCount: inv.commands.length,
    agentCount: inv.agents.length,
    hookCount: inv.hooks.reduce((a, h) => a + h.count, 0),
    ruleCount: inv.rules.length,
    mcpCount: inv.mcps.length,
    probedOk: inv.mcps.filter(m => m.probe?.ok).length,
    remoteCount: inv.mcps.filter(m => m.probe?.reason === 'remote').length,
    failedProbes: inv.mcps.filter(m => m.probe && !m.probe.ok && m.probe.reason !== 'remote').length,
    security,
    broken: inv.broken || [],
    mcps: inv.mcps.map(m => ({ name: m.name, source: m.source, probe: m.probe })),
  };

  const g = grade(rep);
  rep.grade = g;

  if (opt.json) console.log(JSON.stringify(rep, null, 2));
  else if (!opt.quiet) console.log(renderTerminal(rep, g));

  if (opt.html) {
    fs.writeFileSync(opt.html, renderHtml(rep, g));
    if (!opt.quiet) console.log(`\nwrote ${opt.html}`);
  }
  if (opt.badge) console.log('\n' + badgeMd(g));
})();

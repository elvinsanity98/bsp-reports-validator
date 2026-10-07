#!/usr/bin/env node
// Sends a report file to the BSP through its machine-to-machine API (the
// alternative to uploading it on the submission portal), to the sandbox or for real.
//
//   node submit.js setup --pfx <bank certificate .pfx>     one time: remember where the certificate is
//   node submit.js cert                                    check the certificate against the BSP
//   node submit.js sandbox <file.xml> [options]            trial run: the BSP validates, nothing is filed
//   node submit.js submit  <file.xml> [options]            the real submission (asks you to confirm)
//   node submit.js status  <token>                         where a submission stands
//   node submit.js result  <token> [--kind pdf|xml|json|excel|receipt|all]
//   node submit.js history                                 submissions sent from this PC
//   node submit.js ui [--port 8777]                        the validator page with "Send to the BSP" buttons
//
// Options for sandbox and submit:
//   --attach FILE      an additional file to send with the report (repeatable)
//   --report CODE      report code, when not the root element of the XML
//   --code BANKCODE    bank code, when not in the file's Header
//   --period P         reporting period as the BSP writes it: 2026-03, 2026-09-18_09-24
//   --out DIR          where to save the BSP's answers (default: next to the file)
//   --no-wait          do not wait for the BSP's validation
//   --force            submit for real although this tool's own check found errors
// Options for status and result: --production when the token is not in this PC's history.
//
// The certificate password is asked for each run and is never written anywhere.
// (BSP_PFX_PASSWORD in the environment is used instead when set; a script can do
// that, but anything else running under your Windows account can read it.)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const API = require('./src/bspapi.js');
const SPEC = require('./src/spec.js');
const ENGINE = require('./src/engine.js');

const DIR = process.env.BSPV_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'bsp-reports-validator');
const CONFIG = path.join(DIR, 'config.json');
const HISTORY = path.join(DIR, 'submissions.jsonl');
const CHAIN = path.join(DIR, 'server-chain.pem');
const VALUE_FLAGS = ['--pfx', '--ca', '--attach', '--report', '--code', '--period', '--out', '--kind', '--port', '--host'];

const say = (s) => process.stdout.write(s + '\n');

function parseArgs(argv) {
  const o = { _: [], attach: [], ca: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + ' needs a value');
      const k = a.slice(2);
      if (Array.isArray(o[k])) o[k].push(v); else o[k] = v;
    } else if (a.startsWith('--')) {
      o[a.slice(2)] = true;
    } else {
      o._.push(a);
    }
  }
  return o;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; }
}

function history() {
  let text = '';
  try { text = fs.readFileSync(HISTORY, 'utf8'); } catch (e) { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

function remember(entry) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
}

// ---- certificate and password ----------------------------------------------------

// Asks without showing what is typed.
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; if (/\n/.test(buf)) { stdin.pause(); resolve(buf.split(/\r?\n/)[0]); } });
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10 || code === 4) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (code === 3) { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (code === 127 || code === 8) value = value.slice(0, -1);
        else if (code >= 32) value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// PFX files exported by older Windows use RC2 for the certificate bag, which
// Node's OpenSSL 3 only reads with its legacy provider. The cipher's identifier
// is visible in the file without the password; when it is there, start again
// with the provider switched on.
function relaunchForOldPfx(pfx) {
  const rc2 = [Buffer.from('2a864886f70d010c0106', 'hex'), Buffer.from('2a864886f70d010c0105', 'hex')];
  if (!rc2.some((oid) => pfx.includes(oid))) return;
  if (process.execArgv.includes('--openssl-legacy-provider') || process.env.BSPV_RELAUNCHED) return;
  const r = spawnSync(process.execPath, ['--openssl-legacy-provider'].concat(process.argv.slice(1)),
    { stdio: 'inherit', env: Object.assign({}, process.env, { BSPV_RELAUNCHED: '1' }) });
  process.exit(r.status === null ? 1 : r.status);
}

// Loads the certificate, asks for its password and makes sure the BSP's own
// server certificate can be verified. Returns what a client needs.
async function credentials(o) {
  const cfg = readConfig();
  let pfxPath = o.pfx || process.env.BSP_PFX || cfg.pfx;
  if (!pfxPath && process.stdin.isTTY) {
    // first run: ask once where the certificate is and remember the place
    pfxPath = path.resolve((await ask('Where is the bank\'s certificate file (.pfx)? Type or paste its path: ')).replace(/^"|"$/g, ''));
    if (fs.existsSync(pfxPath)) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(CONFIG, JSON.stringify(Object.assign(cfg, { pfx: pfxPath }), null, 2));
    }
  }
  if (!pfxPath) throw new Error('No certificate set. Run: node submit.js setup --pfx "<path to the bank\'s .pfx file>"');
  let pfx;
  try { pfx = fs.readFileSync(pfxPath); } catch (e) { throw new Error('Cannot read the certificate file ' + pfxPath + ' (' + e.code + ').'); }
  relaunchForOldPfx(pfx);
  const passphrase = process.env.BSP_PFX_PASSWORD !== undefined ? process.env.BSP_PFX_PASSWORD
    : await askHidden('Password of ' + path.basename(pfxPath) + ': ');
  try {
    require('tls').createSecureContext({ pfx, passphrase });
  } catch (e) {
    throw new Error(API.explain(e));
  }
  const host = o.host || cfg.host || API.HOST;
  const ca = [];
  (o.ca.length ? o.ca : cfg.ca || []).forEach((file) => {
    const raw = fs.readFileSync(file);
    ca.push(/-----BEGIN/.test(raw.toString('latin1')) ? raw.toString('latin1') : new crypto.X509Certificate(raw).toString());
  });
  try { ca.push(fs.readFileSync(CHAIN, 'utf8')); } catch (e) { /* none saved yet */ }
  const port = Number(process.env.BSPV_API_PORT) || 443;     // another port only for the tests
  const more = await API.missingIntermediates(host, port, ca);
  if (more.length) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(CHAIN, more.join('\n') + '\n');
    more.forEach((pem) => ca.push(pem));
  }
  return { pfx, passphrase, ca, host, port, pfxPath };
}

function certificateLine(client) {
  const c = client.certificate;
  if (!c) return null;
  const days = Math.floor((Date.parse(c.validTo) - Date.now()) / 86400000);
  const who = [c.subject.O, c.subject.OU, c.subject.CN].filter(Boolean).join(', ');
  return 'Certificate ' + who + ', valid to ' + c.validTo + ' (' + days + ' days left)' + (days < 30 ? '  <-- renew it soon' : '');
}

// ---- the file --------------------------------------------------------------------

// Works out report, bank and period, and runs this tool's own check when it knows the report.
async function prepare(file, o) {
  const data = fs.readFileSync(file);
  const known = SPEC.list().map((s) => s.report);
  let info = { reportCode: '', undertakingCode: '', period: '', periodSure: false };
  const isXml = /\.xml$/i.test(file);
  if (isXml) info = API.describe(ENGINE.decode(new Uint8Array(data)).text, known);
  if (o.report) info.reportCode = o.report;
  if (o.code) info.undertakingCode = o.code;
  if (o.period) { info.period = o.period; info.periodSure = true; }
  const missing = ['reportCode', 'undertakingCode', 'period'].filter((k) => !info[k]);
  if (missing.length) {
    throw new Error('Cannot read the ' + missing.join(', ') + ' off ' + path.basename(file) + '. Give ' +
      missing.map((k) => ({ reportCode: '--report', undertakingCode: '--code', period: '--period' }[k])).join(', ') + '.');
  }
  if (!info.periodSure) {
    throw new Error('The period of a ' + info.reportCode + ' report cannot be told from the file: the BSP writes a month as ' + info.period +
      ' but a quarter as ' + info.period.slice(0, 5) + Number(info.period.slice(5)) + '. Give it with --period, as the portal shows it.');
  }
  let check = null;
  if (isXml && known.includes(info.reportCode)) {
    const spec = await SPEC.load(info.reportCode);
    const r = ENGINE.check(spec, ENGINE.readXmlBytes(new Uint8Array(data), spec), { profile: readConfig().profile || { bank: {} } });
    check = { errors: r.counts.error, warnings: r.counts.warning, first: r.findings.filter((f) => f.sev === 'error').slice(0, 5).map((f) => f.code + ': ' + f.msg) };
  }
  const extras = o.attach.map((f) => ({ name: path.basename(f), data: fs.readFileSync(f) }));
  return { info, check, main: { name: path.basename(file), data }, extras, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

function resultName(entry, kind) {
  const d = API.DOWNLOADS[kind];
  const stem = (entry.mode === 'sandbox' ? 'Sandbox' : '') + (kind === 'receipt' ? 'Receipt' : kind === 'excel' ? 'Visualization' : 'ProcessingResult');
  return [stem, entry.undertakingCode, entry.reportCode, entry.period, entry.token.slice(0, 8)].join('-') + '.' + d.ext;
}

async function saveResults(client, entry, dir, kinds) {
  const saved = [];
  for (const kind of kinds) {
    try {
      const d = await client.download(entry.token, kind);
      const file = path.join(dir, resultName(entry, kind));
      fs.writeFileSync(file, d.data);
      saved.push(file);
    } catch (e) {
      if (e.status !== 404) say('  could not get the ' + API.DOWNLOADS[kind].label + ': ' + e.message);
    }
  }
  return saved;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(client, token, minutes) {
  const until = Date.now() + minutes * 60000;
  let last = '';
  for (;;) {
    const st = await client.status(token);
    const line = ['validation: ' + (st.validationStatus || '-'), 'authorization: ' + (st.autohorizationStatus || '-'), 'after authorization: ' + (st.postAuthoriozationStatus || '-')].join(', ');
    if (line !== last) { say('  ' + line); last = line; }
    if (client.settled(st)) return st;
    if (Date.now() > until) return null;
    await sleep(5000);
  }
}

// ---- commands --------------------------------------------------------------------

async function send(mode, o) {
  const file = o._[1];
  if (!file) throw new Error('Name the file to send.');
  const p = await prepare(file, o);
  say((mode === 'sandbox' ? 'SANDBOX (trial run, nothing is filed)' : 'REAL SUBMISSION to the BSP'));
  say('  Report  ' + p.info.reportCode + '\n  Bank    ' + p.info.undertakingCode + '\n  Period  ' + p.info.period + '\n  File    ' + p.main.name + '  (' + p.main.data.length + ' bytes, SHA-256 ' + p.sha256.slice(0, 16) + '...)');
  p.extras.forEach((x) => say('  Also    ' + x.name + '  (' + x.data.length + ' bytes)'));
  if (p.check) {
    say('  Own check: ' + p.check.errors + ' error(s), ' + p.check.warnings + ' warning(s)');
    p.check.first.forEach((m) => say('    ' + m.slice(0, 200)));
    if (p.check.errors && mode === 'production' && !o.force) {
      throw new Error('This tool found errors in the file. Fix them, try the sandbox, or add --force to submit anyway.');
    }
  } else {
    say('  Own check: none (this tool has no rules for ' + p.info.reportCode + ')');
  }
  if (mode === 'production') {
    const typed = await ask('This files the report with the BSP. Type the period (' + p.info.period + ') to go ahead: ');
    if (typed !== p.info.period) throw new Error('Not confirmed. Nothing was sent.');
  }
  const cred = await credentials(o);
  const client = API.createClient(Object.assign({ sandbox: mode === 'sandbox' }, cred));
  const sent = await client.submit(p.info, p.main, p.extras);
  const entry = { time: new Date().toISOString(), mode, token: sent.token, reportCode: p.info.reportCode, undertakingCode: p.info.undertakingCode,
    period: p.info.period, file: path.resolve(file), sha256: p.sha256 };
  remember(entry);
  say('Sent. Submission token: ' + sent.token);
  const line = certificateLine(client);
  if (line) say(line);
  if (o['no-wait']) { say('Check later with: node submit.js status ' + sent.token); return 0; }
  say('Waiting for the BSP to validate...');
  const st = await waitFor(client, sent.token, 10);
  if (!st) { say('Still processing after 10 minutes. Check later with: node submit.js status ' + sent.token); return 0; }
  const dir = o.out || path.dirname(path.resolve(file));
  const saved = await saveResults(client, entry, dir, ['pdf', 'xml'].concat(mode === 'production' ? ['receipt'] : []));
  saved.forEach((f) => say('Saved ' + f));
  remember(Object.assign({}, entry, { time: new Date().toISOString(), validationStatus: st.validationStatus || '' }));
  return /invalid|reject|fail|error/i.test(String(st.validationStatus || '')) ? 1 : 0;
}

function entryFor(token, o) {
  const found = history().filter((h) => h.token === token).pop();
  return found || { token, mode: o.production ? 'production' : 'sandbox', reportCode: 'report', undertakingCode: 'bank', period: 'period' };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'setup') {
    const cfg = readConfig();
    if (o.pfx) cfg.pfx = path.resolve(o.pfx);
    if (o.ca.length) cfg.ca = o.ca.map((f) => path.resolve(f));
    if (!cfg.pfx) throw new Error('Give the certificate: node submit.js setup --pfx "<path to the .pfx>"');
    if (!fs.existsSync(cfg.pfx)) throw new Error('There is no file at ' + cfg.pfx);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    say('Saved in ' + CONFIG + '\n  certificate: ' + cfg.pfx + '\nThe password is not stored. Next: node submit.js cert');
    return 0;
  }
  if (cmd === 'history') {
    const rows = history();
    if (!rows.length) say('Nothing sent from this PC yet.');
    rows.slice(-30).forEach((h) => say([h.time.slice(0, 19).replace('T', ' '), h.mode.padEnd(10), h.reportCode, h.period, h.token, h.validationStatus || ''].join('  ')));
    return 0;
  }
  if (cmd === 'cert') {
    const cred = await credentials(o);
    const client = API.createClient(Object.assign({ sandbox: true }, cred));
    const info = await client.certificateInfo();
    say('The BSP accepted the certificate.');
    say(certificateLine(client) || '');
    say(typeof info === 'string' ? info : JSON.stringify(info, null, 2));
    return 0;
  }
  if (cmd === 'sandbox') return send('sandbox', o);
  if (cmd === 'submit') return send('production', o);
  if (cmd === 'status' || cmd === 'result') {
    const token = o._[1];
    if (!API.UUID.test(String(token))) throw new Error('Give the submission token.');
    const entry = entryFor(token, o);
    const client = API.createClient(Object.assign({ sandbox: entry.mode === 'sandbox' }, await credentials(o)));
    if (cmd === 'status') { say(JSON.stringify(await client.status(token), null, 2)); return 0; }
    const kinds = !o.kind || o.kind === 'all' ? Object.keys(API.DOWNLOADS) : [o.kind];
    const saved = await saveResults(client, entry, o.out || (entry.file ? path.dirname(entry.file) : process.cwd()), kinds);
    saved.forEach((f) => say('Saved ' + f));
    if (!saved.length) say('Nothing is available for this token yet.');
    return 0;
  }
  if (cmd === 'ui') return ui(o);
  say(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  return cmd ? 2 : 0;
}

// ---- the page, served to this PC only ----------------------------------------------

async function ui(o) {
  const cred = await credentials(o);
  const clients = { sandbox: API.createClient(Object.assign({ sandbox: true }, cred)), production: API.createClient(Object.assign({ sandbox: false }, cred)) };
  let certInfo = null;
  try { certInfo = await clients.sandbox.certificateInfo(); } catch (e) { say('Certificate check failed: ' + e.message); }
  const line = certificateLine(clients.sandbox);
  if (line) say(line);
  const key = crypto.randomBytes(24).toString('hex');
  const port = Number(o.port) || 8777;
  const page = () => fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('<script>', '<script>self.BSPV_LOCAL=' + JSON.stringify({ key }) + ';</script>\n<script>');

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > 80e6) { reject(new Error('The files are too large.')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('Bad request.')); } });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      // Only this PC, and only the page this process handed out, may use the certificate.
      const host = String(req.headers.host || '');
      if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) { res.writeHead(403); res.end(); return; }
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page());
        return;
      }
      if (url.pathname.indexOf('/local/') !== 0) { res.writeHead(404); res.end(); return; }
      if ((req.headers['x-bspv-key'] || url.searchParams.get('k')) !== key) { json(res, 403, { error: 'Not allowed.' }); return; }
      const origin = req.headers.origin;
      if (origin && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) { json(res, 403, { error: 'Not allowed.' }); return; }

      if (url.pathname === '/local/info') {
        json(res, 200, { host: cred.host, certificate: clients.sandbox.certificate, bsp: certInfo, known: SPEC.list().map((s) => s.report), history: history().slice(-15).reverse() });
        return;
      }
      if (url.pathname === '/local/send' && req.method === 'POST') {
        const b = await readBody(req);
        const mode = b.mode === 'production' ? 'production' : 'sandbox';
        const info = { reportCode: b.reportCode, undertakingCode: b.undertakingCode, period: b.period };
        if (mode === 'production' && b.confirm !== String(b.period)) throw new Error('Type the period exactly to confirm a real submission.');
        const main = { name: path.basename(String(b.fileName || 'report.xml')), data: Buffer.from(String(b.data || ''), 'base64') };
        if (!main.data.length) throw new Error('The file is empty.');
        const extras = (b.attachments || []).map((x) => ({ name: path.basename(String(x.name)), data: Buffer.from(String(x.data || ''), 'base64') }));
        const sent = await clients[mode].submit(info, main, extras);
        const entry = { time: new Date().toISOString(), mode, token: sent.token, reportCode: sent.reportInfo.reportCode, undertakingCode: sent.reportInfo.undertakingCode,
          period: sent.reportInfo.period, file: main.name, sha256: crypto.createHash('sha256').update(main.data).digest('hex') };
        remember(entry);
        say(entry.time.slice(11, 19) + '  sent to ' + mode + ': ' + entry.reportCode + ' ' + entry.period + '  token ' + entry.token);
        json(res, 200, entry);
        return;
      }
      const token = url.searchParams.get('token');
      const entry = entryFor(token, { production: url.searchParams.get('mode') === 'production' });
      if (url.pathname === '/local/status') {
        const st = await clients[entry.mode].status(token);
        json(res, 200, { status: st, settled: clients[entry.mode].settled(st), entry });
        return;
      }
      if (url.pathname === '/local/file') {
        const kind = url.searchParams.get('kind');
        const d = await clients[entry.mode].download(token, kind);
        const name = resultName(entry, kind);
        const dir = path.join(DIR, 'results');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), d.data);
        res.writeHead(200, { 'Content-Type': d.contentType || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Cache-Control': 'no-store' });
        res.end(d.data);
        return;
      }
      json(res, 404, { error: 'No such call.' });
    } catch (e) {
      json(res, e.status === 404 ? 404 : 400, { error: e.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = 'http://127.0.0.1:' + port + '/';
  say('The page is at ' + address + '  (this PC only). Leave this window open; close it or press Ctrl+C to stop.');
  if (!o['no-open'] && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', address], { detached: true, stdio: 'ignore' }).unref();
  return new Promise(() => {});
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0), (e) => { process.stderr.write('Stopped: ' + e.message + '\n'); process.exit(2); });
}

module.exports = { parseArgs, prepare, resultName };

// Tests for the BSP API client, the command line sender and the local page
// server. Everything runs against test/mock-bsp.js on this machine.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const API = require('../src/bspapi.js');
const mock = require('./mock-bsp.js');

const ROOT = path.join(__dirname, '..');
const sample = (name) => fs.readFileSync(path.join(ROOT, 'samples', name));

// Runs submit.js and returns { code, out }. `input` is typed on its stdin.
function cli(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'submit.js')].concat(args), { env: Object.assign({}, process.env, env) });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

module.exports = function (test) {
  test('api: report, bank and period are read off the file', () => {
    const known = ['FRP_S', 'WRR_RCB'];
    assert.deepStrictEqual(API.describe(sample('clean/FRP_S_RB0001_2026-03.xml').toString(), known),
      { reportCode: 'FRP_S', undertakingCode: 'RB0001', period: '2026-03', periodSure: true });
    assert.deepStrictEqual(API.describe(sample('clean/WRR_RCB_RB0001_2026-09-18.xml').toString(), known),
      { reportCode: 'WRR_RCB', undertakingCode: 'RB0001', period: '2026-09-18_09-24', periodSure: true });
    const other = API.describe('<AFRD xmlns="x"><Header><Undertaking>1</Undertaking><Year>2026</Year><Period>3</Period></Header></AFRD>', known);
    assert.strictEqual(other.period, '2026-03');
    assert.strictEqual(other.periodSure, false, 'a quarter and a month look the same in the file');
    assert.throws(() => API.describe('<a><b></a>', known), /not well-formed/);
  });

  test('api: the form the BSP expects', () => {
    const form = API.multipart({ reportInfo: '{"a":1}' }, [{ field: 'file', name: 'r.xml', data: Buffer.from('<x/>'), type: 'application/xml' }, { field: 'file1', name: 'p.pdf', data: Buffer.from([0, 255, 13, 10]) }]);
    const parts = mock.parseMultipart(form.body, form.contentType);
    assert.deepStrictEqual(parts.map((p) => [p.name, p.filename]), [['reportInfo', undefined], ['file', 'r.xml'], ['file1', 'p.pdf']]);
    assert.strictEqual(parts[0].data.toString(), '{"a":1}');
    assert.deepStrictEqual([...parts[2].data], [0, 255, 13, 10]);
  });

  test('api: submit, status, downloads and refusals', async () => {
    const bsp = await mock.start(null);
    try {
      const client = API.createClient({ host: '127.0.0.1', port: bsp.port, insecureHttp: true, sandbox: true });
      const info = { reportCode: 'WRR_RCB', undertakingCode: 'RB0001', period: '2026-09-18_09-24' };
      const sent = await client.submit(info, { name: 'w.xml', data: sample('clean/WRR_RCB_RB0001_2026-09-18.xml') }, [{ name: 'proof.pdf', data: Buffer.from('pdf') }]);
      assert.ok(API.UUID.test(sent.token));
      const got = bsp.submissions[sent.token];
      assert.strictEqual(got.mode, 'sandbox');
      assert.deepStrictEqual(got.info, { reportCode: 'WRR_RCB', undertakingCode: 'RB0001', period: '2026-09-18_09-24', mainFile: { filename: 'w.xml' }, additionalFiles: [{ filename: 'proof.pdf' }] });
      assert.deepStrictEqual(got.files.map((f) => f.name + ':' + f.filename), ['file:w.xml', 'file1:proof.pdf']);
      assert.strictEqual(bsp.calls[0], 'POST /api/sandbox/submission/submitReport');

      let st = await client.status(sent.token);
      assert.strictEqual(client.settled(st), false);
      await assert.rejects(() => client.download(sent.token, 'pdf'), /answered 404/);
      st = await client.status(sent.token);
      assert.strictEqual(st.validationStatus, 'Valid');
      assert.strictEqual(client.settled(st), true);
      assert.strictEqual((await client.download(sent.token, 'pdf')).data.toString(), 'mock result/pdf for WRR_RCB 2026-09-18_09-24');
      assert.strictEqual((await client.download(sent.token, 'excel')).ext, 'xlsx');
      await assert.rejects(() => client.download(sent.token, 'receipt'), /answered 404/, 'the sandbox files nothing, so there is no receipt');

      await assert.rejects(() => client.submit(Object.assign({}, info, { period: 'Q3' }), { name: 'w.xml', data: Buffer.from('<x/>') }), /answered 400.*No reporting slot for period Q3/);
      await assert.rejects(() => client.submit(Object.assign({}, info, { period: '' }), { name: 'w.xml', data: Buffer.from('<x/>') }), /needs a period/);
      await assert.rejects(() => client.status('not-a-token'), /not a submission token/);
      await assert.rejects(() => client.status('00000000-0000-4000-8000-000000000000'), /answered 404/);

      const real = API.createClient({ host: '127.0.0.1', port: bsp.port, insecureHttp: true, sandbox: false });
      const filed = await real.submit(info, { name: 'w.xml', data: Buffer.from('<x/>') });
      assert.strictEqual(bsp.submissions[filed.token].mode, 'production');
      await assert.rejects(() => client.status(filed.token), /answered 404/, 'a real token is not a sandbox token');
    } finally {
      await bsp.close();
    }
  });

  test('api: certificate, command line and local page, end to end', async () => {
    const certs = mock.makeCertificates();
    if (!certs) { console.log('     (skipped: OpenSSL not found to make test certificates)'); return; }
    const bsp = await mock.start(certs.server);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bspv-home-'));
    const env = { BSPV_HOME: home, BSP_PFX: certs.pfx, BSP_PFX_PASSWORD: certs.password, BSPV_API_PORT: String(bsp.port), APPDATA: home };
    const common = ['--host', 'localhost', '--ca', certs.ca, '--out', home];
    try {
      // the client presents the certificate; without it the server hangs up
      const pfx = fs.readFileSync(certs.pfx), ca = [fs.readFileSync(certs.ca, 'utf8')];
      const client = API.createClient({ host: 'localhost', port: bsp.port, pfx, passphrase: certs.password, ca, sandbox: true });
      assert.strictEqual((await client.certificateInfo()).subject, 'test.bank.example');
      assert.strictEqual(client.certificate.subject.OU, '0000001');
      await assert.rejects(() => API.createClient({ host: 'localhost', port: bsp.port, ca, sandbox: true }).certificateInfo(), /certificate|reach the BSP/i);
      // an unknown server certificate is refused before anything is sent
      await assert.rejects(() => API.createClient({ host: 'localhost', port: bsp.port, sandbox: true }).certificateInfo(), /could not be verified/);
      assert.deepStrictEqual(await API.missingIntermediates('localhost', bsp.port, ca), []);

      let r = await cli(['cert'].concat(common), Object.assign({}, env, { BSP_PFX_PASSWORD: 'wrong' }));
      assert.ok(r.code === 2 && /PFX password is wrong/.test(r.out), r.out);
      r = await cli(['cert'].concat(common), env);
      assert.ok(r.code === 0 && /accepted the certificate/.test(r.out) && /Test Bank, 0000001/.test(r.out), r.out);

      // the folder of the certificate may be given instead of the file
      const viaSettings = Object.assign({}, env, { BSP_PFX: '' });
      r = await cli(['setup', '--pfx', certs.dir], viaSettings);
      assert.ok(r.code === 0 && /client\.pfx/.test(r.out), r.out);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).pfx, certs.pfx);
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ pfx: certs.dir }));     // a folder saved by an older version
      r = await cli(['cert'].concat(common), viaSettings);
      assert.ok(r.code === 0 && /accepted the certificate/.test(r.out), r.out);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).pfx, certs.pfx, 'the setting repairs itself');
      r = await cli(['setup', '--pfx', home], viaSettings);
      assert.ok(r.code === 2 && /no \.pfx file in the folder/.test(r.out), r.out);

      const wrr = path.join(ROOT, 'samples', 'clean', 'WRR_RCB_RB0001_2026-09-18.xml');
      r = await cli(['sandbox', wrr].concat(common), env);
      assert.strictEqual(r.code, 0, r.out);
      assert.ok(/SANDBOX/.test(r.out) && /Period  2026-09-18_09-24/.test(r.out) && /Own check: 0 error/.test(r.out) && /validation: Valid/.test(r.out), r.out);
      const token = /token: ([0-9a-f-]{36})/.exec(r.out)[1];
      const saved = fs.readdirSync(home).filter((n) => /ProcessingResult/.test(n)).sort();
      assert.deepStrictEqual(saved, ['SandboxProcessingResult-RB0001-WRR_RCB-2026-09-18_09-24-' + token.slice(0, 8) + '.pdf', 'SandboxProcessingResult-RB0001-WRR_RCB-2026-09-18_09-24-' + token.slice(0, 8) + '.xml']);

      // a real submission: refused on errors, refused without the typed period, sent with it
      const bad = path.join(ROOT, 'samples', 'with-errors', 'WRR_RCB_RB0001_2026-09-19_errors.xml');
      r = await cli(['submit', bad].concat(common), env, '2026-09-19_09-24\n');
      assert.ok(r.code === 2 && /found errors in the file/.test(r.out), r.out);
      const before = Object.keys(bsp.submissions).length;
      r = await cli(['submit', wrr].concat(common), env, 'yes\n');
      assert.ok(r.code === 2 && /Not confirmed. Nothing was sent/.test(r.out), r.out);
      assert.strictEqual(Object.keys(bsp.submissions).length, before, 'nothing reached the server');
      r = await cli(['submit', wrr, '--no-wait'].concat(common), env, '2026-09-18_09-24\n');
      assert.ok(r.code === 0 && /REAL SUBMISSION/.test(r.out), r.out);
      const realToken = /token: ([0-9a-f-]{36})/.exec(r.out)[1];
      assert.strictEqual(bsp.submissions[realToken].mode, 'production');
      r = await cli(['history'], env);
      assert.ok(r.out.includes(token) && r.out.includes(realToken) && /production/.test(r.out), r.out);
      r = await cli(['status', realToken].concat(common), env);
      assert.ok(r.code === 0 && /validationStatus/.test(r.out), 'the mode of a token comes from the history: ' + r.out);

      // a report this tool has no rules for needs its period spelled out
      const other = path.join(home, 'afrd.xml');
      fs.writeFileSync(other, '<AFRD xmlns="x"><Header><Undertaking>RB0001</Undertaking><Year>2026</Year><Period>3</Period></Header></AFRD>');
      r = await cli(['sandbox', other].concat(common), env);
      assert.ok(r.code === 2 && /Give it with --period/.test(r.out), r.out);
      r = await cli(['sandbox', other, '--period', '2026-3', '--no-wait'].concat(common), env);
      assert.ok(r.code === 0 && /Own check: none/.test(r.out), r.out);

      // the local page
      const free = await new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
      const ui = spawn(process.execPath, [path.join(ROOT, 'submit.js'), 'ui', '--no-open', '--port', String(free)].concat(common), { env: Object.assign({}, process.env, env) });
      try {
        await new Promise((resolve, reject) => {
          let out = '';
          ui.stdout.on('data', (d) => { out += d; if (/The page is at/.test(out)) resolve(); });
          ui.on('close', () => reject(new Error('the page server stopped: ' + out)));
          setTimeout(() => reject(new Error('the page server did not start: ' + out)), 20000);
        });
        const base = 'http://127.0.0.1:' + free;
        const html = await (await fetch(base + '/')).text();
        const key = /BSPV_LOCAL=\{"key":"([0-9a-f]+)"\}/.exec(html)[1];
        assert.strictEqual((await fetch(base + '/local/info')).status, 403, 'no key, no access');
        assert.strictEqual((await fetch(base + '/local/info', { headers: { 'X-BSPV-Key': key, Origin: 'https://example.com' } })).status, 403, 'another site may not use it');
        const get = (p) => fetch(base + p, { headers: { 'X-BSPV-Key': key } }).then((x) => x.json().then((b) => ({ status: x.status, body: b })));
        const post = (body) => fetch(base + '/local/send', { method: 'POST', headers: { 'X-BSPV-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then((x) => x.json().then((b) => ({ status: x.status, body: b })));
        const info = await get('/local/info');
        assert.strictEqual(info.body.certificate.subject.OU, '0000001');
        assert.ok(info.body.history.some((h) => h.token === realToken));
        const body = { fileName: 'w.xml', data: fs.readFileSync(wrr).toString('base64'), reportCode: 'WRR_RCB', undertakingCode: 'RB0001', period: '2026-09-18_09-24' };
        let sent = await post(Object.assign({ mode: 'production' }, body));
        assert.ok(sent.status === 400 && /Type the period/.test(sent.body.error), JSON.stringify(sent));
        sent = await post(Object.assign({ mode: 'sandbox' }, body));
        assert.strictEqual(sent.status, 200, JSON.stringify(sent));
        assert.strictEqual(bsp.submissions[sent.body.token].mode, 'sandbox');
        await get('/local/status?token=' + sent.body.token);
        const st = await get('/local/status?token=' + sent.body.token);
        assert.ok(st.body.settled && st.body.status.validationStatus === 'Valid');
        const file = await fetch(base + '/local/file?token=' + sent.body.token + '&kind=pdf&k=' + key);
        assert.ok(file.status === 200 && /SandboxProcessingResult-RB0001-WRR_RCB/.test(file.headers.get('content-disposition')));
        sent = await post(Object.assign({ mode: 'production', confirm: '2026-09-18_09-24' }, body));
        assert.strictEqual(bsp.submissions[sent.body.token].mode, 'production');
      } finally {
        ui.kill();
      }
    } finally {
      await bsp.close();
      certs.remove();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
};

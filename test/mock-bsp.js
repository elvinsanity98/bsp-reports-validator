// A stand-in for the BSP's Engine API, for the tests. It speaks the same paths
// and form fields as the real one and, when given keys, demands a client
// certificate the same way. Nothing here talks to the BSP.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function parseMultipart(body, contentType) {
  const m = /boundary=(.+)$/.exec(contentType || '');
  if (!m) return null;
  const mark = Buffer.from('--' + m[1]);
  const parts = [];
  let at = body.indexOf(mark);
  while (at >= 0) {
    const next = body.indexOf(mark, at + mark.length);
    if (next < 0) break;
    const chunk = body.subarray(at + mark.length + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, split).toString('utf8');
    parts.push({
      name: (/name="([^"]*)"/.exec(head) || [])[1],
      filename: (/filename="([^"]*)"/.exec(head) || [])[1],
      type: (/Content-Type: (.+)/i.exec(head) || [])[1],
      data: chunk.subarray(split + 4)
    });
    at = next;
  }
  return parts;
}

function start(tlsOptions) {
  const submissions = {};
  const calls = [];
  const problem = (res, status, title, detail) => {
    res.writeHead(status, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ type: 'about:blank', title, status, detail }));
  };
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const m = /^\/api\/(sandbox\/)?submission\/(.+)$/.exec(req.url);
      calls.push(req.method + ' ' + req.url);
      if (req.url === '/api/certificate/info') {
        const peer = req.socket.getPeerCertificate ? req.socket.getPeerCertificate() : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ subject: (peer.subject || {}).CN || null, thumbprint: peer.fingerprint || null }));
        return;
      }
      if (!m) { problem(res, 404, 'Not Found', 'No such path.'); return; }
      const mode = m[1] ? 'sandbox' : 'production';
      if (m[2] === 'submitReport' && req.method === 'POST') {
        const parts = parseMultipart(body, req.headers['content-type']);
        const infoPart = parts && parts.find((p) => p.name === 'reportInfo');
        let info;
        try { info = JSON.parse(infoPart.data.toString('utf8')); } catch (e) { problem(res, 400, 'Bad Request', 'reportInfo is not JSON.'); return; }
        const files = parts.filter((p) => p.filename !== undefined);
        const main = files.find((f) => f.name === 'file');
        if (!main || main.filename !== info.mainFile.filename) { problem(res, 400, 'Bad Request', 'The main file does not match reportInfo.'); return; }
        if (!/^\d{4}-\d/.test(info.period)) { problem(res, 400, 'Bad Request', 'No reporting slot for period ' + info.period + '.'); return; }
        const token = crypto.randomUUID();
        submissions[token] = { mode, info, files, asked: 0, valid: !/INVALID/.test(main.data.toString('utf8')) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token }));
        return;
      }
      const t = /^([0-9a-f-]{36})\/(.+)$/.exec(m[2]);
      const s = t && submissions[t[1]];
      if (!s || s.mode !== mode) { problem(res, 404, 'Not Found', 'No submission for given token.'); return; }
      if (t[2] === 'status') {
        s.asked++;
        const done = s.asked > 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          validationStatus: done ? (s.valid ? 'Valid' : 'Invalid') : 'InProgress',
          autohorizationStatus: done && s.valid && mode === 'production' ? 'Submitted' : null, postAuthoriozationStatus: null,
          fileAvailability: { confirmationPdf: done && mode === 'production', resultPdf: done, resultXml: done, resultExcel: done }
        }));
        return;
      }
      const kinds = { 'result/pdf': 'application/pdf', 'result/xml': 'application/xml', 'result/json': 'application/json', 'result/excel': 'application/octet-stream', 'confirmation/pdf': 'application/pdf' };
      if (kinds[t[2]] && s.asked > 1 && (t[2] !== 'confirmation/pdf' || mode === 'production')) {
        res.writeHead(200, { 'Content-Type': kinds[t[2]] });
        res.end(t[2] === 'result/json' ? JSON.stringify({ valid: s.valid }) : 'mock ' + t[2] + ' for ' + s.info.reportCode + ' ' + s.info.period);
        return;
      }
      problem(res, 404, 'Not Found', 'No validation result available.');
    });
  };
  const server = tlsOptions
    ? https.createServer(Object.assign({ requestCert: true, rejectUnauthorized: true }, tlsOptions), handler)
    : http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, submissions, calls, close: () => new Promise((r) => server.close(r)) }));
  });
}

// Throwaway keys and certificates for one test run: a CA, a server certificate
// for localhost, a client certificate and its PFX. Returns null without OpenSSL.
function makeCertificates() {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
  const openssl = candidates.find((c) => { try { execFileSync(c, ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } });
  if (!openssl) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bspv-test-'));
  const f = (n) => path.join(dir, n);
  fs.writeFileSync(f('o.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign,cRLSign\n[srv]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const run = (...args) => execFileSync(openssl, args, { stdio: 'ignore', cwd: dir });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Test CA for bsp-reports-validator', '-days', '2', '-config', 'o.cnf', '-extensions', 'ca');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost', '-config', 'o.cnf');
  run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'o.cnf', '-extensions', 'srv');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/O=Test Bank/OU=0000001/CN=test.bank.example', '-config', 'o.cnf');
  run('x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2');
  run('pkcs12', '-export', '-inkey', 'client.key', '-in', 'client.pem', '-certfile', 'ca.pem', '-out', 'client.pfx', '-passout', 'pass:test-only-password');
  return {
    dir, password: 'test-only-password', pfx: f('client.pfx'), ca: f('ca.pem'),
    server: { key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.pem')), ca: fs.readFileSync(f('ca.pem')) },
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

module.exports = { start, makeCertificates, parseMultipart };

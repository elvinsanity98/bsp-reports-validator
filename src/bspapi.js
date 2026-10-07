// Client for the BSP "Engine API M2M" (report submission over mutual TLS).
// Node only: a browser page cannot present the bank's certificate to the BSP.
//
//   const api = require('./src/bspapi.js');
//   const client = api.createClient({ pfx: bytes, passphrase: '...', sandbox: true });
//   const { token } = await client.submit(info, { name: 'report.xml', data: bytes });
//   const status = await client.status(token);
//   const pdf = await client.download(token, 'pdf');
//
// Endpoints, from the BSP's OpenAPI file and Postman collections:
//   POST /api/submission/submitReport                     multipart: reportInfo (JSON text), file, file1, file2 ...
//   GET  /api/submission/{token}/status
//   GET  /api/submission/{token}/result/pdf | xml | json | excel
//   GET  /api/submission/{token}/confirmation/pdf
//   GET  /api/certificate/info
// The sandbox has the same calls under /api/sandbox/submission/... on the same host.
'use strict';
const https = require('https');
const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const XML = require('./xml.js');

const HOST = 'rapi.bsp.gov.ph';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOWNLOADS = {
  pdf: { path: 'result/pdf', ext: 'pdf', label: 'validation result (PDF)' },
  xml: { path: 'result/xml', ext: 'xml', label: 'validation result (XML)' },
  json: { path: 'result/json', ext: 'json', label: 'validation result (JSON)' },
  excel: { path: 'result/excel', ext: 'xlsx', label: 'Excel visualization' },
  receipt: { path: 'confirmation/pdf', ext: 'pdf', label: 'submission receipt' }
};

// ---- what a file is ------------------------------------------------------------

// Reads the report code, bank code and period off an XML submission file.
// `periodSure` is false when the period had to be guessed from the header shape:
// the BSP writes a monthly period as 2026-03 and a quarterly one as 2026-1,
// and the file does not say which the report is.
function describe(text, knownReports) {
  let root;
  try {
    root = XML.parse(text).root;
  } catch (e) {
    throw new Error('The file is not well-formed XML: ' + e.message);
  }
  const header = root.children.find((c) => c.name === 'Header');
  const field = (name) => {
    const el = header && header.children.find((c) => c.name === name);
    return el ? el.text.trim() : '';
  };
  const out = { reportCode: root.name, undertakingCode: field('Undertaking'), period: '', periodSure: false };
  const year = field('Year'), month = field('Period'), from = field('FromDate'), to = field('ToDate');
  if (/^\d{4}-\d\d-\d\d$/.test(from) && /^\d{4}-\d\d-\d\d$/.test(to)) {
    out.period = from + '_' + to.slice(5);
    out.periodSure = true;
  } else if (/^\d{4}$/.test(year) && /^\d{1,2}$/.test(month)) {
    out.period = year + '-' + ('0' + month).slice(-2);
    out.periodSure = (knownReports || []).indexOf(root.name) >= 0;
  }
  return out;
}

// ---- transport -----------------------------------------------------------------

function multipart(fields, files) {
  const boundary = '----bspv' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  const quote = (s) => String(s).replace(/[\r\n"]/g, '_');
  Object.keys(fields).forEach((name) => {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + quote(name) + '"\r\n\r\n' + fields[name] + '\r\n', 'utf8'));
  });
  files.forEach((f) => {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + quote(f.field) + '"; filename="' + quote(f.name) +
      '"\r\nContent-Type: ' + (f.type || 'application/octet-stream') + '\r\n\r\n', 'utf8'));
    parts.push(Buffer.from(f.data));
    parts.push(Buffer.from('\r\n'));
  });
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

function typeOf(name) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1];
  return { xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip' }[String(ext).toLowerCase()] || 'application/octet-stream';
}

// Says what a network or TLS failure means for someone holding a certificate file.
function explain(e) {
  const text = (e.code || '') + ' ' + (e.message || '');
  if (/mac verify failure|bad decrypt|PKCS12.*mac/i.test(text)) return 'The PFX password is wrong.';
  if (/unsupported|Unsupported PKCS12/i.test(text)) return 'This PFX uses an old cipher that this Node refuses. Run Node with --openssl-legacy-provider.';
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED|DEPTH_ZERO/i.test(text)) return 'The BSP server certificate could not be verified (' + (e.code || e.message) + ').';
  if (/CERT_HAS_EXPIRED/.test(text)) return 'A certificate in the chain has expired.';
  if (/certificate required|bad certificate|unknown ca|certificate unknown|handshake failure|certificate expired|certificate revoked/i.test(text)) {
    return 'The BSP did not accept the client certificate (' + e.message + '). Check that the PFX is the current one and has not expired.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'The BSP host name could not be found. Check the internet connection.';
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|timed out/i.test(text)) return 'Could not reach the BSP (' + (e.code || e.message) + '). Check the connection, a proxy or firewall, and that the certificate is accepted.';
  return e.message || String(e);
}

function createClient(options) {
  const o = Object.assign({ host: HOST, port: 443, sandbox: true, timeout: 120000 }, options);
  const lib = o.insecureHttp ? http : https;     // plain HTTP exists for the tests only
  const agentOptions = o.insecureHttp ? {} : { pfx: o.pfx, passphrase: o.passphrase };
  if (!o.insecureHttp) agentOptions.ca = tls.rootCertificates.concat(o.ca || []);
  const agent = new lib.Agent(Object.assign({ keepAlive: false }, agentOptions));
  const client = { sandbox: !!o.sandbox, host: o.host, certificate: null };
  const base = () => (client.sandbox ? '/api/sandbox/submission' : '/api/submission');

  function call(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const req = lib.request({ host: o.host, port: o.port, method, path, headers: Object.assign({ Accept: '*/*' }, headers), agent, timeout: o.timeout }, (res) => {
        if (!client.certificate && res.socket && res.socket.getCertificate) {
          const c = res.socket.getCertificate();
          if (c && c.subject) client.certificate = { subject: c.subject, issuer: c.issuer, validTo: c.valid_to, validFrom: c.valid_from, fingerprint: c.fingerprint };
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('The request timed out.')));
      req.on('error', (e) => { const err = new Error(explain(e)); err.code = e.code; err.cause = e; reject(err); });
      if (body) req.write(body);
      req.end();
    });
  }

  // The BSP answers failures with a "problem details" JSON body.
  function check(res, what) {
    if (res.status >= 200 && res.status < 300) return res;
    let detail = '';
    try {
      const p = JSON.parse(res.body.toString('utf8'));
      detail = [p.title, p.detail].filter(Boolean).join(': ');
      if (p.errors) detail += ' ' + JSON.stringify(p.errors);
    } catch (e) {
      detail = res.body.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    const hint = res.status === 401 || res.status === 403 ? ' The certificate was not accepted for this call, or the reporting slot is not assigned to it.'
      : res.status === 404 ? ' Nothing was found for it, or it is not available yet.' : '';
    const err = new Error('The BSP answered ' + res.status + ' to ' + what + (detail ? ': ' + detail : '.') + hint);
    err.status = res.status;
    throw err;
  }

  function tokenPath(token, tail) {
    if (!UUID.test(String(token))) throw new Error('"' + token + '" is not a submission token.');
    return base() + '/' + token + '/' + tail;
  }

  // info: { reportCode, undertakingCode, period }. main and each extra: { name, data }.
  client.submit = async function (info, main, extras) {
    extras = extras || [];
    ['reportCode', 'undertakingCode', 'period'].forEach((k) => {
      if (!info[k] || !String(info[k]).trim()) throw new Error('The submission needs a ' + k + '.');
    });
    const names = [main.name].concat(extras.map((x) => x.name));
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new Error('Two of the files have the same name.');
    const reportInfo = { reportCode: String(info.reportCode).trim(), undertakingCode: String(info.undertakingCode).trim(), period: String(info.period).trim(), mainFile: { filename: main.name } };
    if (extras.length) reportInfo.additionalFiles = extras.map((x) => ({ filename: x.name }));
    const files = [{ field: 'file', name: main.name, data: main.data, type: typeOf(main.name) }]
      .concat(extras.map((x, i) => ({ field: 'file' + (i + 1), name: x.name, data: x.data, type: typeOf(x.name) })));
    const form = multipart({ reportInfo: JSON.stringify(reportInfo, null, 1) }, files);
    const res = check(await call('POST', base() + '/submitReport', { 'Content-Type': form.contentType, 'Content-Length': form.body.length }, form.body), 'the submission');
    let token = null;
    try { token = JSON.parse(res.body.toString('utf8')).token; } catch (e) { token = null; }
    if (!UUID.test(String(token))) throw new Error('The BSP accepted the call but sent no submission token: ' + res.body.toString('utf8').slice(0, 200));
    return { token, reportInfo };
  };

  client.status = async function (token) {
    const res = check(await call('GET', tokenPath(token, 'status')), 'the status request');
    return JSON.parse(res.body.toString('utf8'));
  };

  client.download = async function (token, kind) {
    const d = DOWNLOADS[kind];
    if (!d) throw new Error('Unknown download "' + kind + '". Use one of: ' + Object.keys(DOWNLOADS).join(', ') + '.');
    const res = check(await call('GET', tokenPath(token, d.path)), 'the request for the ' + d.label);
    return { data: res.body, ext: d.ext, contentType: res.headers['content-type'] || '' };
  };

  client.certificateInfo = async function () {
    const res = check(await call('GET', '/api/certificate/info'), 'the certificate check');
    const text = res.body.toString('utf8');
    try { return JSON.parse(text); } catch (e) { return text; }
  };

  // True once the BSP has finished looking at the file: a result file exists,
  // or the validation status is one of the two final words its results use.
  // Any other status text means "still working", so an unknown one only makes
  // the caller wait longer; it never ends the wait early.
  client.settled = function (status) {
    const f = status.fileAvailability || {};
    if (f.resultPdf || f.resultXml || f.resultExcel || f.confirmationPdf) return true;
    return /^(valid|invalid)$/i.test(String(status.validationStatus || '').trim());
  };

  return client;
}

// ---- the server's certificate chain ----------------------------------------------

// Some servers send their own certificate without the intermediate that signed
// it. Browsers fetch the missing one from the address named in the certificate;
// Node does not. This does the same: it downloads the issuer certificates and
// returns them as PEM. They are only used to complete a chain that must still
// end at a root Node already trusts, so a forged one gains nothing.
async function missingIntermediates(host, port, extraCa) {
  const found = [];
  // A bare handshake: no client certificate is offered and nothing is sent.
  const handshake = (verify) => new Promise((resolve, reject) => {
    const s = tls.connect({
      host, port: port || 443, servername: host, timeout: 20000,
      rejectUnauthorized: verify, ca: tls.rootCertificates.concat(extraCa || [])
    }, () => { const c = s.getPeerCertificate(true); s.end(); resolve(c); });
    s.on('timeout', () => s.destroy(new Error('timed out')));
    s.on('error', reject);
  });
  try {
    await handshake(true);
    return found;                      // the chain already verifies
  } catch (e) {
    if (!/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/.test(e.code || '')) throw new Error(explain(e));
  }
  const peer = await handshake(false);
  let url = ((peer.infoAccess || {})['CA Issuers - URI'] || [])[0];
  for (let depth = 0; url && depth < 4; depth++) {
    const der = await new Promise((resolve, reject) => {
      const lib = /^https:/i.test(url) ? https : http;
      lib.get(url, { timeout: 20000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('Could not download ' + url + ' (' + res.statusCode + ').')); return; }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    const cert = new crypto.X509Certificate(der);
    found.push(cert.toString());
    if (cert.subject === cert.issuer) break;
    url = (/CA Issuers - URI:(\S+)/.exec(cert.infoAccess || '') || [])[1];
  }
  return found;
}

module.exports = { createClient, describe, multipart, explain, missingIntermediates, DOWNLOADS, HOST, UUID };

// Tries the "Send to the BSP" page without a bank certificate and without the BSP.
// It starts a stand-in server on this PC (test/mock-bsp.js), makes throwaway test
// certificates, and opens the page pointed at that stand-in. Nothing leaves the PC.
//
// Run: node tools/demo-send.js [--port 8778] [--no-open]      (needs OpenSSL, which Git for Windows includes)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mock = require('../test/mock-bsp.js');

(async () => {
  const args = process.argv.slice(2);
  const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '8778';
  const certs = mock.makeCertificates();
  if (!certs) { console.error('OpenSSL was not found, so the test certificates cannot be made.'); process.exit(2); }
  const bsp = await mock.start(certs.server);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bspv-demo-'));
  console.log('DEMO: a stand-in BSP is listening on port ' + bsp.port + '. Submissions go there, not to the BSP.');
  const ui = spawn(process.execPath, [path.join(__dirname, '..', 'submit.js'), 'ui', '--port', port, '--host', 'localhost', '--ca', certs.ca]
    .concat(args.includes('--no-open') ? ['--no-open'] : []), {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { BSPV_HOME: home, BSP_PFX: certs.pfx, BSP_PFX_PASSWORD: certs.password, BSPV_API_PORT: String(bsp.port) })
  });
  const stop = () => { ui.kill(); certs.remove(); fs.rmSync(home, { recursive: true, force: true }); process.exit(0); };
  ui.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();

// "Send to the BSP" panel. It only works when the page was opened through
// `node submit.js ui`: that local program holds the bank's certificate and
// makes the calls. Opened any other way, the page cannot reach the BSP's API.
(function () {
  'use strict';
  var B = self.BSPV, local = self.BSPV_LOCAL || null;
  var cache = { info: null, watch: null, timer: null };

  function h() { return B.app.h.apply(null, arguments); }

  function call(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'X-BSPV-Key': local.key }, options.headers || {});
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || 'The request failed (' + res.status + ').');
        return body;
      });
    });
  }

  function base64(bytes) {
    var out = '', step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(out);
  }

  // The period the way the BSP writes it: 2026-03 for a month, 2026-09-18_09-24 for a week.
  function periodOf(doc) {
    var hd = doc.header, v = function (k) { return hd[k] && !hd[k].bad ? hd[k].v : null; };
    if (v('FromDate') && v('ToDate')) return v('FromDate') + '_' + String(v('ToDate')).slice(5);
    if (v('Year') && v('Period')) return v('Year') + '-' + ('0' + v('Period')).slice(-2);
    return '';
  }

  function certLine(info) {
    var c = info.certificate;
    if (!c) return 'Certificate: not checked yet.';
    var days = Math.floor((Date.parse(c.validTo) - Date.now()) / 86400000);
    return 'Certificate: ' + [c.subject.O, c.subject.OU].filter(Boolean).join(', ') + ', valid to ' + c.validTo + ' (' + days + ' days left)' +
      (days < 30 ? '. Renew it soon.' : '.');
  }

  function stopWatching() {
    if (cache.timer) clearTimeout(cache.timer);
    cache.timer = null;
  }

  // Shows where one submission stands and offers the BSP's files once they exist.
  function watch(entry, logBox) {
    stopWatching();
    cache.watch = entry;
    var started = Date.now();
    function line(text, cls) { B.app.clear(logBox).appendChild(h('p', { class: cls || '' }, text)); }
    function poll() {
      call('/local/status?token=' + entry.token + '&mode=' + entry.mode).then(function (r) {
        var st = r.status, f = st.fileAvailability || {};
        B.app.clear(logBox);
        logBox.appendChild(h('p', null, h('strong', null, (entry.mode === 'sandbox' ? 'Sandbox' : 'Submission') + ' ' + entry.reportCode + ' ' + entry.period),
          '  token ', h('code', null, entry.token)));
        logBox.appendChild(h('p', null, 'Validation: ', h('strong', null, st.validationStatus || 'waiting'),
          ' | Authorization: ' + (st.autohorizationStatus || '-') + ' | After authorization: ' + (st.postAuthoriozationStatus || '-')));
        var files = h('div', { class: 'row' });
        [['pdf', 'Result (PDF)', f.resultPdf], ['xml', 'Result (XML)', f.resultXml], ['excel', 'Excel view', f.resultExcel], ['receipt', 'Receipt', f.confirmationPdf]].forEach(function (k) {
          if (!k[2]) return;
          files.appendChild(h('a', { class: 'btn small linkbtn', href: '/local/file?token=' + entry.token + '&mode=' + entry.mode + '&kind=' + k[0] + '&k=' + local.key }, k[1]));
        });
        if (files.children.length) logBox.appendChild(files);
        logBox.appendChild(h('p', { class: 'muted rawstatus' }, 'BSP answer: ' + JSON.stringify(st)));
        if (r.settled) return;
        if (Date.now() - started > 15 * 60000) { logBox.appendChild(h('p', { class: 'muted' }, 'Still processing. Use "Check" in the list below later.')); return; }
        logBox.appendChild(h('p', { class: 'muted' }, 'The BSP is still processing. Checking again every 5 seconds.'));
        cache.timer = setTimeout(poll, 5000);
      }, function (e) { line(e.message, 'fail'); });
    }
    line('Asking the BSP...', 'muted');
    poll();
  }

  function historyTable(info, logBox) {
    if (!info.history.length) return h('p', { class: 'muted' }, 'Nothing sent from this PC yet.');
    var body = h('tbody');
    info.history.forEach(function (e) {
      body.appendChild(h('tr', null,
        h('td', { class: 'line' }, e.time.slice(0, 16).replace('T', ' ')),
        h('td', null, e.mode === 'sandbox' ? 'Sandbox' : 'Real'),
        h('td', null, e.reportCode + ' ' + e.period),
        h('td', null, e.validationStatus || ''),
        h('td', null, h('button', { class: 'btn small', type: 'button', onclick: function () { watch(e, logBox); logBox.scrollIntoView({ block: 'nearest' }); } }, 'Check'))));
    });
    return h('div', { class: 'table-scroll' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Sent'), h('th', null, 'To'), h('th', null, 'Report'), h('th', null, 'Validation'), h('th', null, ''))), body));
  }

  function render(box, ctx) {
    if (!local) return;
    stopWatching();
    var doc = ctx.result.doc, input = ctx.input;
    var card = h('div', { class: 'card sendcard' }, h('h3', null, 'Send to the BSP'));
    box.appendChild(card);
    var certP = h('p', { class: 'muted' }, 'Checking the certificate...');
    card.appendChild(certP);

    var isXml = doc.source === 'xml' && !input.inner && !doc.fatal;
    var u = doc.header.Undertaking;
    var fReport = h('input', { type: 'text', value: ctx.spec.report, spellcheck: 'false' });
    var fBank = h('input', { type: 'text', value: u && !u.bad ? u.v : '', spellcheck: 'false' });
    var fPeriod = h('input', { type: 'text', value: periodOf(doc), spellcheck: 'false', placeholder: '2026-03 or 2026-09-18_09-24' });
    var fAttach = h('input', { type: 'file', multiple: true });
    var logBox = h('div', { class: 'send-log' });
    var errors = ctx.result.counts.error;

    if (!isXml) {
      card.appendChild(h('p', { class: 'notice' }, doc.fatal ? 'This file cannot be read, so it cannot be sent.'
        : 'The BSP API takes the XML file. Open the .xml itself here (not the workbook or a zip) to send it.'));
    } else {
      card.appendChild(h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Report code', fReport),
        h('label', { class: 'field' }, 'Bank code', fBank),
        h('label', { class: 'field' }, 'Period', fPeriod),
        h('label', { class: 'field grow' }, 'Additional files (optional)', fAttach)));

      var busy = false;
      var send = function (mode, confirm) {
        if (busy) return;
        busy = true;
        B.app.clear(logBox).appendChild(h('p', { class: 'muted' }, 'Sending ' + input.name + (mode === 'sandbox' ? ' to the sandbox...' : ' to the BSP...')));
        Promise.all(Array.prototype.map.call(fAttach.files, function (f) {
          return f.arrayBuffer().then(function (buf) { return { name: f.name, data: base64(new Uint8Array(buf)) }; });
        })).then(function (attachments) {
          return call('/local/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: mode, confirm: confirm, fileName: input.name, data: base64(input.bytes), reportCode: fReport.value.trim(),
              undertakingCode: fBank.value.trim(), period: fPeriod.value.trim(), attachments: attachments })
          });
        }).then(function (entry) {
          busy = false;
          watch(entry, logBox);
          loadInfo();
        }, function (e) {
          busy = false;
          B.app.clear(logBox).appendChild(h('p', { class: 'fail' }, e.message));
        });
      };

      var realRow = h('div', { class: 'row realrow', hidden: true });
      var fConfirm = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
      var fForce = h('input', { type: 'checkbox' });
      realRow.appendChild(h('label', { class: 'field' }, 'Type the period to confirm the real submission', fConfirm));
      if (errors) realRow.appendChild(h('label', { class: 'check inline' }, fForce, h('span', null, 'Submit although ' + errors + ' error(s) were found here')));
      realRow.appendChild(h('button', {
        class: 'btn danger', type: 'button',
        onclick: function () {
          if (errors && !fForce.checked) { B.app.clear(logBox).appendChild(h('p', { class: 'fail' }, 'Errors were found in this file. Fix them, or tick the box to submit anyway.')); return; }
          if (fConfirm.value.trim() !== fPeriod.value.trim() || !fPeriod.value.trim()) { B.app.clear(logBox).appendChild(h('p', { class: 'fail' }, 'Type the period exactly as shown above to confirm.')); return; }
          send('production', fConfirm.value.trim());
        }
      }, 'Submit for real'));

      card.appendChild(h('div', { class: 'row sendbuttons' },
        h('button', { class: 'btn primary', type: 'button', onclick: function () { send('sandbox'); } }, 'Send to sandbox'),
        h('button', { class: 'btn', type: 'button', onclick: function () { realRow.hidden = !realRow.hidden; } }, 'Submit to the BSP...'),
        h('span', { class: 'muted' }, 'The sandbox validates the file at the BSP without filing it.')));
      card.appendChild(realRow);
    }
    card.appendChild(logBox);
    var histBox = h('div', { class: 'send-history' });
    card.appendChild(h('h4', null, 'Sent from this PC'));
    card.appendChild(histBox);

    function loadInfo() {
      call('/local/info').then(function (info) {
        cache.info = info;
        certP.textContent = certLine(info) + ' API host: ' + info.host + '.';
        B.app.clear(histBox).appendChild(historyTable(info, logBox));
      }, function (e) { certP.textContent = 'The local sender does not answer: ' + e.message; });
    }
    loadInfo();
  }

  B.send = { render: render, periodOf: periodOf, local: !!local };
})();

// Page behaviour: reads the chosen file, runs the engine, shows the result.
(function () {
  'use strict';
  var B = self.BSPV, ENGINE = B.engine, TEMPLATE = B.template, SPEC = B.spec;
  var fmt = ENGINE.fmt;

  function $(id) { return document.getElementById(id); }

  // h('div', { class: 'x', onclick: fn }, child, 'text', [more])
  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var PAGE = 60;

  var state = {
    spec: null,
    input: null,        // { name, bytes }
    result: null,
    history: {},        // 'YYYY-MM' -> { doc, name }
    sev: { error: true, warning: true, info: true },
    groupBy: 'form',
    query: '',
    open: {},
    shown: {},
    form: null
  };

  // ---- setup fields ----------------------------------------------------------

  var PROFILE_KEY = 'bspv.profile.v1';

  function saveSetup() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({
        undertaking: $('h-undertaking').value, group: $('p-group').value, parent: $('p-parent').value,
        branches: $('p-branches').value, domestic: $('p-domestic').checked, trust: $('p-trust').checked,
        emi: $('p-emi').checked, list: $('p-branch-list').value
      }));
    } catch (e) { /* private window: nothing to keep */ }
  }

  function loadSetup() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (e) { s = null; }
    if (!s) return;
    $('h-undertaking').value = s.undertaking || '';
    $('p-group').value = s.group || '';
    $('p-parent').value = s.parent || 'NONE';
    $('p-branches').value = s.branches || '';
    $('p-domestic').checked = s.domestic !== false;
    $('p-trust').checked = !!s.trust;
    $('p-emi').checked = !!s.emi;
    $('p-branch-list').value = s.list || '';
  }

  // The facts the BSP holds about the bank, as the rules ask for them.
  function profile() {
    var group = $('p-group').value;
    var count = $('p-branches').value.trim() === '' ? undefined : Number($('p-branches').value);
    var bank = {
      BNKGRP: group || undefined,
      PARENTBNKGRP: group ? $('p-parent').value : undefined,
      A_TRUST: $('p-trust').checked ? 1 : 0,
      A_EMI: $('p-emi').checked ? 1 : 0,
      ISDOMESTIC: $('p-domestic').checked ? 1 : 0,
      BRANCHCOUNT: count,
      DOMESTICBRANCHCOUNT: count
    };
    var branches = null, bad = 0;
    $('p-branch-list').value.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var parts = line.split(/[,;\t]/).map(function (p) { return p.trim(); });
      if (!parts[0] || !parts[1]) { bad++; return; }
      branches = branches || {};
      branches[parts[0]] = { REGION: parts[1], BRISLOC: parts[2] || undefined };
    });
    return { bank: bank, branches: branches, badLines: bad };
  }

  function profileSummary() {
    var p = profile(), b = p.bank, bits = [];
    bits.push(b.BNKGRP ? $('p-group').selectedOptions[0].textContent : 'bank type not set');
    if (b.A_TRUST) bits.push('trust');
    if (b.A_EMI) bits.push('e-money');
    if (!b.ISDOMESTIC) bits.push('foreign bank branch');
    if (b.BRANCHCOUNT !== undefined) bits.push(b.BRANCHCOUNT + ' offices');
    if (p.branches) bits.push(Object.keys(p.branches).length + ' in branch list');
    return bits.join(', ');
  }

  // ---- reading the chosen file -----------------------------------------------

  function fail(message) {
    $('fail').textContent = message;
    $('fail').hidden = !message;
  }
  function busy(text) {
    $('progress').hidden = !text;
    $('progress-text').textContent = text || '';
    $('bar').style.width = text ? '60%' : '0';
  }
  function tick() { return new Promise(function (r) { setTimeout(r, 20); }); }

  function kindOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name);
    var ext = m ? m[1].toLowerCase() : '';
    return ext === 'xlsx' || ext === 'xlsm' ? 'xlsx' : ext === 'zip' ? 'zip' : 'xml';
  }

  async function toDoc(input) {
    var kind = kindOf(input.name);
    if (kind === 'xlsx') {
      return TEMPLATE.read(input.bytes, state.spec, {
        Undertaking: $('h-undertaking').value, Year: $('h-year').value, Period: $('h-period').value
      });
    }
    if (kind === 'zip') {
      var zip = TEMPLATE.unzip(input.bytes);
      var xmls = zip.names.filter(function (n) { return /\.xml$/i.test(n) && !/^__MACOSX\//.test(n); });
      if (xmls.length !== 1) throw new Error(xmls.length ? 'The zip holds ' + xmls.length + ' XML files; it should hold exactly one.' : 'The zip holds no .xml file.');
      input.inner = xmls[0];
      return ENGINE.readXml(await zip.read(xmls[0]), state.spec);
    }
    return ENGINE.readXmlBytes(input.bytes, state.spec);
  }

  async function run() {
    if (!state.input || !state.spec) return;
    fail('');
    busy('Checking ' + state.input.name + '...');
    await tick();
    try {
      var doc = await toDoc(state.input);
      var hist = {};
      Object.keys(state.history).forEach(function (k) { hist[k] = state.history[k].doc; });
      var p = profile();
      state.result = ENGINE.check(state.spec, doc, { profile: p, history: hist });
      state.result.profile = p;
      state.open = {};
      state.shown = {};
      render();
    } catch (e) {
      state.result = null;
      $('results').hidden = true;
      $('empty').hidden = false;
      fail(e && e.message ? e.message : String(e));
    }
    busy('');
  }

  async function chooseFile(file) {
    if (!file) return;
    state.input = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    run();
  }

  async function addHistory(files) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var doc = ENGINE.readXmlBytes(new Uint8Array(await f.arrayBuffer()), state.spec);
      var y = doc.header.Year && doc.header.Year.v, p = doc.header.Period && doc.header.Period.v;
      if (doc.fatal || typeof y !== 'number' || typeof p !== 'number') {
        state.history['?' + f.name] = { name: f.name, bad: true };
        continue;
      }
      state.history[y + '-' + ('0' + p).slice(-2)] = { doc: doc, name: f.name };
    }
    renderHistory();
    run();
  }

  function renderHistory() {
    var keys = Object.keys(state.history).sort();
    var good = keys.filter(function (k) { return !state.history[k].bad; });
    $('history-summary').textContent = good.length ? good.join(', ') : 'none loaded';
    $('history-clear').hidden = !keys.length;
    var list = clear($('history-list'));
    keys.forEach(function (k) {
      var e = state.history[k];
      list.appendChild(e.bad
        ? h('li', { class: 'bad' }, e.name + ': could not be read as a ' + state.spec.report + ' XML file with a period in its header.')
        : h('li', null, h('strong', null, MONTHS[Number(k.slice(5)) - 1] + ' ' + k.slice(0, 4)), ' from ' + e.name));
    });
  }

  // ---- results ---------------------------------------------------------------

  function where(f) {
    if (f.loc) return f.loc;
    if (f.line !== undefined) return 'line ' + f.line;
    return '';
  }

  function periodText(doc) {
    var y = doc.header.Year, p = doc.header.Period;
    if (!y || !p || y.bad || p.bad) return 'not readable';
    return MONTHS[p.v - 1] + ' ' + y.v;
  }

  function familyOf(f) {
    if (f.kind !== 'rule') return f.code.split('-')[0] === 'SPEC' ? 'Cells not used in this report' : 'File and schema';
    var fam = f.code.split('-')[0];
    return { REQ: 'Required schedules (REQ)', XREQ: 'Branch coverage (XREQ)', STG1: 'Cell checks (STG1)', RIN: 'Reconciliations (RIN)' }[fam] || fam;
  }

  function groupKey(f) {
    if (state.groupBy === 'family') return familyOf(f);
    if (f.form) return f.form;
    return 'File';
  }

  function matches(f) {
    if (!state.sev[f.sev]) return false;
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return [f.code, f.msg, f.form, f.table, f.cell, where(f), f.lhsText, f.rhsText].some(function (s) {
      return s && String(s).toLowerCase().indexOf(q) >= 0;
    });
  }

  function kv(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (p) {
      if (p === null) { dl.appendChild(h('div', { class: 'rule' })); return; }
      dl.appendChild(h('dt', null, p[0]));
      dl.appendChild(h('dd', { class: p[2] || (p[1] === 0 ? 'zero' : '') }, typeof p[1] === 'number' ? p[1].toLocaleString('en-US') : p[1]));
    });
    return dl;
  }

  var SKIP_WORDS = {
    profile: 'need a bank profile fact that is not set',
    branches: 'need the branch list',
    history: 'need an earlier period file',
    format: 'depend on a value that is not in the right format',
    other: 'could not be worked out (for example a ratio with a zero base)'
  };

  function render() {
    var r = state.result, doc = r.doc, st = r.stats, c = r.counts;
    $('empty').hidden = true;
    var box = clear($('results'));
    box.hidden = false;

    var title, sub;
    if (doc.fatal) {
      title = 'The file could not be read';
      sub = 'Fix the problem below first; the rest of the checks need a readable file.';
    } else if (c.error) {
      title = c.error.toLocaleString('en-US') + (c.error === 1 ? ' error' : ' errors') + ' to fix before submitting';
      sub = c.warning ? 'Plus ' + c.warning.toLocaleString('en-US') + (c.warning === 1 ? ' warning' : ' warnings') + ' to review.' : 'No warnings.';
    } else if (c.warning) {
      title = 'No errors. ' + c.warning.toLocaleString('en-US') + (c.warning === 1 ? ' warning' : ' warnings') + ' to review';
      sub = 'Warnings do not block a submission by themselves, but each one deserves a look.';
    } else {
      title = 'No problems found';
      sub = 'The file follows the schema and passes every rule that could be checked here.';
    }
    box.appendChild(h('div', { class: 'verdict ' + r.verdict },
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, r.verdict === 'ok' ? 'OK' : '!'),
      h('div', null, h('h2', null, title), h('p', null, state.input.name + (state.input.inner ? ' > ' + state.input.inner : '') + '. ' + sub))));

    if (st.skippedTotal) {
      var parts = Object.keys(st.skipped).map(function (k) { return st.skipped[k].toLocaleString('en-US') + ' ' + SKIP_WORDS[k]; });
      box.appendChild(h('p', { class: 'notice' }, h('strong', null, st.skippedTotal.toLocaleString('en-US') + ' rules were not checked: '),
        parts.join('; ') + '. See Bank profile and Earlier periods above.'));
    }
    if (r.profile.badLines) {
      box.appendChild(h('p', { class: 'notice' }, r.profile.badLines + ' line(s) of the branch list could not be read. Each line needs a branch code and a region code, separated by a comma.'));
    }

    var submitted = Object.keys(doc.forms).length;
    var fileCount = 0, naCount = 0, ruleCount = 0;
    r.findings.forEach(function (f) { if (f.kind === 'rule') ruleCount++; else if (f.kind === 'cell') naCount++; else fileCount++; });
    var u = doc.header.Undertaking;
    box.appendChild(h('div', { class: 'cards' },
      h('div', { class: 'card' }, h('h3', null, 'Submission'), kv([
        ['Read as', doc.source === 'xlsx' ? 'Excel input template' : 'XML file'],
        ['Report', state.spec.report + ' version ' + state.spec.version],
        ['Bank code', u && !u.bad ? u.v : 'not given'],
        ['Period', periodText(doc)],
        ['Schedules with data', submitted]
      ])),
      h('div', { class: 'card' }, h('h3', null, 'Findings'), kv([
        ['Errors', c.error, c.error ? 'bad' : 'zero'],
        ['Warnings', c.warning],
        null,
        ['File and schema', fileCount],
        ['Cells not used in this report', naCount],
        ['BSP rules', ruleCount]
      ])),
      h('div', { class: 'card' }, h('h3', null, 'BSP rules (' + st.rules.toLocaleString('en-US') + ')'), kv([
        ['Passed', st.passed],
        ['Failed', st.failed, st.failed ? 'bad' : 'zero'],
        ['Not applicable to this file', st.notApplicable],
        ['Not checked', st.skippedTotal]
      ]), h('p', { class: 'card-foot' }, 'Checked as: ' + profileSummary() + '.'))));

    if (!r.findings.length) {
      renderSchedules();
      return;
    }

    box.appendChild(h('div', { class: 'section-head' }, h('h2', null, 'Findings'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: exportCsv }, 'Save as CSV'),
        h('button', { class: 'btn small', type: 'button', onclick: function () { window.print(); } }, 'Print'))));

    var tools = h('div', { class: 'toolbar' });
    var chips = h('div', { class: 'chips' });
    ['error', 'warning'].forEach(function (sev) {
      if (!c[sev]) return;
      chips.appendChild(h('button', {
        class: 'chip ' + sev, type: 'button', 'aria-pressed': String(state.sev[sev]),
        onclick: function () { state.sev[sev] = !state.sev[sev]; state.shown = {}; renderGroups(); this.setAttribute('aria-pressed', String(state.sev[sev])); }
      }, (sev === 'error' ? 'Errors ' : 'Warnings ') + c[sev].toLocaleString('en-US')));
    });
    tools.appendChild(chips);
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Group findings by' });
    [['form', 'By schedule'], ['family', 'By kind of check']].forEach(function (o) {
      seg.appendChild(h('button', {
        type: 'button', 'aria-pressed': String(state.groupBy === o[0]),
        onclick: function () {
          state.groupBy = o[0]; state.open = {}; state.shown = {};
          Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', String(b === this)); }, this);
          renderGroups();
        }
      }, o[1]));
    });
    tools.appendChild(seg);
    tools.appendChild(h('label', { class: 'field grow' }, 'Search',
      h('input', {
        type: 'search', value: state.query, placeholder: 'Rule code, schedule, cell or words',
        oninput: function () { state.query = this.value.trim(); state.shown = {}; renderGroups(); }
      })));
    box.appendChild(tools);
    box.appendChild(h('div', { class: 'groups', id: 'groups' }));
    renderGroups();
    renderSchedules();
  }

  function renderGroups() {
    var r = state.result, holder = clear($('groups'));
    var groups = {}, order = [];
    r.findings.forEach(function (f, i) {
      if (!matches(f)) return;
      var k = groupKey(f);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(i);
    });
    if (state.groupBy === 'form') {
      var rank = {};
      state.spec.forms.forEach(function (f, i) { rank[f.n] = i + 2; });
      rank.File = 0; rank.Header = 1;
      order.sort(function (a, b) { return (rank[a] === undefined ? 999 : rank[a]) - (rank[b] === undefined ? 999 : rank[b]); });
    }
    if (!order.length) {
      holder.appendChild(h('p', { class: 'none' }, 'No findings match the filters.'));
      return;
    }
    if (order.length === 1) state.open[order[0]] = true;
    order.forEach(function (k) {
      var ids = groups[k];
      var errors = ids.filter(function (i) { return r.findings[i].sev === 'error'; }).length;
      var form = state.spec.formByName[k];
      var open = !!state.open[k];
      var group = h('div', { class: 'group' + (open ? ' open' : '') });
      group.appendChild(h('button', {
        class: 'group-head', type: 'button', 'aria-expanded': String(open),
        onclick: function () { state.open[k] = !state.open[k]; renderGroups(); }
      },
        h('span', { class: 'sev ' + (errors ? 'error' : 'warning') }, errors ? 'Error' : 'Warning'),
        h('span', { class: 'group-main' },
          h('span', { class: 'group-title' }, k),
          h('span', { class: 'group-meta' }, form ? form.t : k === 'File' ? 'Problems with the file as a whole' : k === 'Header' ? 'Bank code and reporting period' : '')),
        h('span', { class: 'group-count' }, ids.length.toLocaleString('en-US'))));
      if (open) {
        var body = h('div', { class: 'group-body' });
        var limit = state.shown[k] || PAGE;
        ids.slice(0, limit).forEach(function (i) { body.appendChild(findingRow(r.findings[i], i)); });
        if (ids.length > limit) {
          body.appendChild(h('div', { class: 'group-more' }, 'Showing ' + limit + ' of ' + ids.length.toLocaleString('en-US') + '.',
            h('button', { class: 'btn small', type: 'button', onclick: function () { state.shown[k] = limit + PAGE * 4; renderGroups(); } }, 'Show more')));
        }
        group.appendChild(body);
      }
      holder.appendChild(group);
    });
  }

  var OP_WORDS = { '=': 'equal', '<>': 'differ from', '>=': 'be at least', '<=': 'be at most', '>': 'be more than', '<': 'be less than' };

  function findingRow(f, index) {
    var key = 'f' + index;
    var open = !!state.open[key];
    var hasDetail = f.kind === 'rule';
    var meta = h('div', { class: 'finding-meta' }, h('span', { class: 'tag' }, f.code));
    if (where(f)) meta.appendChild(h('span', { class: 'tag pos' }, where(f)));
    if (state.groupBy === 'family' && f.form) meta.appendChild(h('span', { class: 'tag' }, f.form));
    if (f.item !== undefined) meta.appendChild(h('span', { class: 'tag' }, (f.table || 'entry') + ' entry ' + (f.item + 1)));
    if (f.kind !== 'rule' && f.label) meta.appendChild(h('span', null, f.label));
    var vals = null;
    if (f.kind === 'rule' && typeof f.left !== 'boolean' && typeof f.right !== 'boolean') {
      vals = h('div', { class: 'finding-vals' }, h('b', null, fmt(f.left)), ' vs ', h('b', null, fmt(f.right)));
    }
    var row = h('div', { class: 'finding' });
    row.appendChild(h(hasDetail ? 'button' : 'div', {
      class: 'finding-head', type: hasDetail ? 'button' : undefined, 'aria-expanded': hasDetail ? String(open) : undefined,
      onclick: hasDetail ? function () { state.open[key] = !state.open[key]; renderGroups(); } : undefined
    },
      h('span', { class: 'sev ' + f.sev }, f.sev === 'error' ? 'Error' : 'Warning'),
      h('div', null, h('div', { class: 'finding-msg' }, f.msg), meta),
      vals));
    if (open && hasDetail) row.appendChild(detail(f));
    return row;
  }

  function operandTable(list) {
    if (!list.length) return null;
    var t = h('table', { class: 'ops' });
    list.forEach(function (o) {
      var place = o.form ? o.form + (o.table ? ' / ' + o.table : '') + ' / ' + o.cell + (o.item !== undefined ? ' (entry ' + (o.item + 1) + ')' : '') : o.text;
      t.appendChild(h('tr', null,
        h('td', null, h('div', { class: 'ref' }, place),
          o.label ? h('div', { class: 'lab' }, o.label) : null,
          o.calc ? h('div', { class: 'calc' }, 'BSP total = ' + o.formula) : null,
          o.loc || o.line !== undefined ? h('div', { class: 'calc' }, o.loc || 'line ' + o.line) : null),
        h('td', { class: 'val' }, o.unknown ? 'not known' : fmt(o.value))));
    });
    return t;
  }

  function detail(f) {
    var body = h('div', { class: 'finding-body' });
    var sentence = 'The left side must ' + OP_WORDS[f.op] + ' the right side';
    if (f.tol) sentence += ', within a tolerance of ' + fmt(f.tol);
    sentence += '.';
    if (f.diff !== undefined) sentence += ' The difference is ' + fmt(f.diff) + '.';
    body.appendChild(h('p', { class: 'plainnote' }, sentence));
    if (f.note) body.appendChild(h('p', { class: 'plainnote' }, f.note));
    body.appendChild(h('div', { class: 'side' },
      h('div', null, h('h4', null, 'Left side = ', h('span', { class: 'total' }, fmt(f.left))),
        h('div', { class: 'formula' }, f.lhsText), h('h4', null, 'Cells it reads'), operandTable(f.lhs)),
      h('div', null, h('h4', null, 'Right side = ', h('span', { class: 'total' }, fmt(f.right))),
        h('div', { class: 'formula' }, f.rhsText), f.rhs.length ? h('h4', null, 'Cells it reads') : null, operandTable(f.rhs))));
    if (f.pre) {
      body.appendChild(h('h4', null, 'Applies when'));
      body.appendChild(h('div', { class: 'formula' }, f.pre));
    }
    return body;
  }

  function exportCsv() {
    var rows = [['Severity', 'Code', 'Schedule', 'Table', 'Cell', 'Entry', 'Where', 'Message', 'Left', 'Operator', 'Right', 'Difference', 'Tolerance', 'Left formula', 'Right formula']];
    state.result.findings.forEach(function (f) {
      rows.push([f.sev, f.code, f.form || '', f.table || '', f.cell || '', f.item !== undefined ? f.item + 1 : '', where(f), f.msg,
        f.kind === 'rule' ? fmt(f.left) : '', f.op || '', f.kind === 'rule' ? fmt(f.right) : '',
        f.diff !== undefined ? f.diff : '', f.kind === 'rule' ? f.tol : '', f.lhsText || '', f.rhsText || '']);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) {
        var s = String(v);
        if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s;   // keep spreadsheets from running it as a formula
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    var blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8' });
    var a = h('a', { href: URL.createObjectURL(blob), download: state.input.name.replace(/\.[^.]+$/, '') + '-findings.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---- schedules -------------------------------------------------------------

  function renderSchedules() {
    var r = state.result;
    var ok = r && r.evaluator;
    $('schedules-empty').hidden = !!ok;
    $('schedules').hidden = !ok;
    if (!ok) return;
    var counts = {};
    r.findings.forEach(function (f) { if (f.form) counts[f.form] = (counts[f.form] || 0) + 1; });
    var pick = clear($('schedule-pick'));
    var first = null;
    state.spec.forms.forEach(function (f) {
      var present = r.evaluator.present(f.n);
      if (present && !first) first = f.n;
      var note = (f.x ? (present ? 'submitted' : 'not submitted') : (present ? 'derived by the BSP' : 'derived by the BSP, no source data')) +
        (counts[f.n] ? ', ' + counts[f.n] + ' findings' : '');
      pick.appendChild(h('option', { value: f.n }, f.n + '  -  ' + f.t.slice(0, 70) + '  (' + note + ')'));
    });
    if (!state.form || !state.spec.formByName[state.form]) state.form = first || state.spec.forms[0].n;
    pick.value = state.form;
    renderSchedule();
  }

  function cellHits(formName) {
    var hits = {};
    function mark(table, cell, item, sev) {
      var k = table + '|' + cell + '|' + (item === undefined ? '' : item);
      if (hits[k] !== 'error') hits[k] = sev;
    }
    state.result.findings.forEach(function (f) {
      if (f.kind === 'rule') {
        f.lhs.concat(f.rhs).forEach(function (o) { if (o.form === formName && !o.calc) mark(o.table, o.cell, o.item, f.sev); });
      } else if (f.form === formName && f.cell) {
        mark(f.table || '', f.cell, f.item, f.sev);
      }
    });
    return hits;
  }

  function valueCell(ev, form, table, code, item, hits) {
    var def = table.c[code];
    if (!def) return h('td', { class: 'none', title: 'Not a cell of this table' });
    var v = ev.valueOf(form.n, table.n, code, item);
    var cls = def[0] === 0 ? '' : 'calc';
    var title = def[0] === 1 ? 'BSP total = ' + def[1] : def[0] === 2 ? 'Fixed by the BSP' : code;
    var hit = hits[table.n + '|' + code + '|' + (item === undefined ? '' : item)];
    if (hit) cls += ' hit-' + hit;
    if (ENGINE.isUnknown(v)) return h('td', { class: cls + ' unknown', title: 'Not known: ' + v.why }, '?');
    if (typeof v === 'string') return h('td', { class: cls + ' txt', title: title }, v);
    if (v === null) return h('td', { class: cls, title: title }, '');
    return h('td', { class: cls + (v === 0 ? ' zero' : ''), title: title }, fmt(v));
  }

  function hasAmount(ev, form, table, codes, item) {
    return codes.some(function (code) {
      if (!table.c[code]) return false;
      var v = ev.valueOf(form.n, table.n, code, item);
      return v !== null && v !== 0 && v !== '' && !ENGINE.isUnknown(v);
    });
  }

  function renderSchedule() {
    var r = state.result, ev = r.evaluator, form = state.spec.formByName[state.form];
    var view = clear($('schedule-view'));
    var hideEmpty = $('schedule-filled').checked;
    var hits = cellHits(form.n);
    var present = ev.present(form.n);
    view.appendChild(h('div', { class: 'sched-head' }, h('h2', null, form.n + ': ' + form.t),
      h('p', null, form.x
        ? (present ? 'Submitted in this file.' : 'Not in this file. The grid below is empty.')
        : 'The BSP builds this schedule from other schedules. Nothing is typed into it.')));
    view.appendChild(h('div', { class: 'legend' },
      h('span', { class: 'l-in' }, 'reported by the bank'), h('span', { class: 'l-calc' }, 'worked out by the BSP'),
      h('span', { class: 'l-hit' }, 'part of a finding')));
    if (form.z && ev.instances(form.n).length > 1) {
      view.appendChild(h('p', { class: 'notice' }, 'This schedule has several book codes; only the first is shown.'));
    }
    (form.f || []).forEach(function (fd) {
      var d = ev.instances(form.n)[0];
      var rec = d && d.data && d.data.fields[fd[0]];
      view.appendChild(h('p', null, h('strong', null, fd[2] || fd[0]), ': ', rec ? String(rec.raw) : '(blank)'));
    });

    form.tb.forEach(function (table) {
      var wrap = h('div', { class: 'sched-table' });
      wrap.appendChild(h('h3', null, table.n, h('small', null, table.t + (table.x ? '' : ' (worked out by the BSP)'))));
      var tbl = h('table', { class: 'sheet' }), head = h('tr'), body = h('tbody'), shown = 0, total = 0;
      if (table.k === 'S') {
        var cols = table.cols.map(function (c) { return c[0]; });
        head.appendChild(h('th', { class: 'rowhead' }, 'Row'));
        table.cols.forEach(function (c) { head.appendChild(h('th', null, h('span', { class: 'code' }, c[0]), c[1])); });
        table.rows.forEach(function (row) {
          total++;
          var codes = cols.map(function (c) { return row[0] + c; });
          if (hideEmpty && !hasAmount(ev, form, table, codes) && !codes.some(function (c) { return hits[table.n + '|' + c + '|']; })) return;
          shown++;
          var tr = h('tr', null, h('th', null, h('span', { class: 'code' }, row[0]), row[1]));
          codes.forEach(function (code) { tr.appendChild(valueCell(ev, form, table, code, undefined, hits)); });
          body.appendChild(tr);
        });
      } else if (table.k === 'Y') {
        var n = ev.itemCount(form.n, table.n);
        head.appendChild(h('th', { class: 'rowhead' }, 'Entry'));
        table.cols.forEach(function (c) { head.appendChild(h('th', null, h('span', { class: 'code' }, c[0]), c[1])); });
        for (var i = 0; i < n; i++) {
          total++; shown++;
          var tr2 = h('tr', null, h('th', null, String(i + 1)));
          for (var j = 0; j < table.cols.length; j++) tr2.appendChild(valueCell(ev, form, table, table.cols[j][0], i, hits));
          body.appendChild(tr2);
        }
      } else {
        var m = ev.itemCount(form.n, table.n);
        head.appendChild(h('th', { class: 'rowhead' }, 'Row'));
        for (var e = 0; e < m; e++) head.appendChild(h('th', null, 'Entry ' + (e + 1)));
        Object.keys(table.c).forEach(function (code) {
          total++;
          var label = table.rowLabel[code] || table.rowLabel[code.slice(0, 5)];
          var any = false;
          for (var x = 0; x < m; x++) any = any || hasAmount(ev, form, table, [code], x);
          if (hideEmpty && !any) return;
          shown++;
          var tr3 = h('tr', null, h('th', null, h('span', { class: 'code' }, code), label ? label[1] : ''));
          for (var y = 0; y < m; y++) tr3.appendChild(valueCell(ev, form, table, code, y, hits));
          body.appendChild(tr3);
        });
      }
      if (!shown) {
        wrap.appendChild(h('p', { class: 'muted' }, total ? 'No amounts in this table.' : 'No entries.'));
      } else {
        tbl.appendChild(h('thead', null, head));
        tbl.appendChild(body);
        wrap.appendChild(h('div', { class: 'table-scroll' }, tbl));
        if (shown < total) wrap.appendChild(h('p', { class: 'muted' }, 'Showing ' + shown + ' of ' + total + ' rows.'));
      }
      view.appendChild(wrap);
    });
  }

  // ---- "what is checked" -----------------------------------------------------

  var FAMILIES = [
    ['XML-, XSD-', 'File and schema: the file is well-formed XML, uses the right namespace, has a Header, holds only schedules, tables and cells the schema knows, has no totals the BSP calculates itself, and every value fits its format (amounts with 2 decimals, whole numbers, codes, dates, text lengths).'],
    ['TPL-', 'Excel template: values typed into calculated cells, Excel error values, entries with no name, sheets that are not schedules.'],
    ['SPEC-NOT-APPLICABLE', 'A cell holds a value although the specification says the cell is not used in this report. Reported as a warning.'],
    ['REQ-', 'Schedules that must be submitted for the period and bank type, and schedules that must not be.'],
    ['STG1-', 'Checks on single cells and pairs of cells: amounts that cannot be negative, US$ and peso-equivalent columns filled together, deposit size brackets, interest rate limits.'],
    ['RIN-', 'Reconciliations inside a schedule and between schedules (for example a schedule total against the balance sheet), each with its own tolerance.'],
    ['XREQ-', 'Branch schedules: every banking office reported, and reported once.']
  ];

  function renderRules() {
    var spec = state.spec, counts = {};
    spec.rules.forEach(function (r) { var k = r[0].split('-')[0] + '-'; counts[k] = (counts[k] || 0) + 1; });
    var body = $('rule-grid').tBodies[0];
    FAMILIES.forEach(function (f) {
      body.appendChild(h('tr', null, h('td', { class: 'value' }, f[0]), h('td', { class: 'line' }, counts[f[0]] ? counts[f[0]].toLocaleString('en-US') : 'built in'), h('td', null, f[1])));
    });
    searchRules();
  }

  function searchRules() {
    var q = $('rule-search').value.trim().toLowerCase();
    var body = clear($('rule-search-grid').tBodies[0]);
    if (q.length < 2) {
      body.appendChild(h('tr', null, h('td', { colspan: '3', class: 'none' }, 'Type at least two characters to look up one of the ' + state.spec.rules.length.toLocaleString('en-US') + ' rules.')));
      return;
    }
    var found = 0;
    for (var i = 0; i < state.spec.rules.length && found < 60; i++) {
      var r = state.spec.rules[i];
      if ((r[0] + ' ' + r[1] + ' ' + r[2] + ' ' + r[4]).toLowerCase().indexOf(q) < 0) continue;
      found++;
      body.appendChild(h('tr', null, h('td', { class: 'value' }, r[0]),
        h('td', null, h('span', { class: 'sev ' + (r[8] ? 'warning' : 'error') }, r[8] ? 'Warning' : 'Error')),
        h('td', null, h('div', null, r[1]),
          h('div', { class: 'formula', style: 'margin-top:4px' }, r[2] + '  ' + r[3] + '  ' + r[4] + (r[5] ? '   (tolerance ' + fmt(r[5]) + ')' : '')),
          r[7] ? h('div', { class: 'muted' }, 'Applies when: ' + r[7]) : null)));
    }
    if (!found) body.appendChild(h('tr', null, h('td', { colspan: '3', class: 'none' }, 'No rule matches.')));
    else if (found === 60) body.appendChild(h('tr', null, h('td', { colspan: '3', class: 'none' }, 'Showing the first 60 matches.')));
  }

  // ---- wiring ----------------------------------------------------------------

  function tabs() {
    var buttons = document.querySelectorAll('.tabs [role=tab]');
    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(buttons, function (o) {
          var on = o === b;
          o.setAttribute('aria-selected', String(on));
          $(o.getAttribute('aria-controls')).hidden = !on;
        });
      });
    });
  }

  function init(spec) {
    state.spec = spec;
    $('report-name').textContent = spec.report + ' version ' + spec.version;
    $('spec-source').textContent = spec.report + ' version ' + spec.version + ' schema and specification, ' + spec.rules.length.toLocaleString('en-US') + ' rules';
    MONTHS.forEach(function (m, i) { $('h-period').appendChild(h('option', { value: String(i + 1) }, (i + 1) + ' - ' + m)); });
    var now = new Date(), last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    $('h-year').value = last.getFullYear();
    $('h-period').value = String(last.getMonth() + 1);
    loadSetup();
    $('profile-summary').textContent = profileSummary();

    // region codes, read off the BSP's own regional rules
    var regions = {};
    spec.rules.forEach(function (r) {
      var m = /^RIN-B1560[- ](.+)$/.exec(r[0]), c = /="(\d+)"/.exec(r[4]);
      if (m && c) regions[c[1]] = m[1];
    });
    var regionText = Object.keys(regions).sort(function (a, b) { return a - b; }).map(function (k) { return k + ' = ' + regions[k]; }).join(', ');
    $('branch-help').textContent = 'Region codes used by the rules: ' + regionText + '. Location codes: 1 = NCR, 2 = Luzon outside NCR, 3 = Visayas, 4 = Mindanao, 5 = foreign office.';

    var rerun = function () { $('profile-summary').textContent = profileSummary(); saveSetup(); run(); };
    ['h-undertaking', 'h-year', 'h-period', 'p-group', 'p-parent', 'p-branches', 'p-domestic', 'p-trust', 'p-emi', 'p-branch-list'].forEach(function (id) {
      $(id).addEventListener('change', rerun);
    });

    var drop = $('drop');
    $('file').addEventListener('change', function () { chooseFile(this.files[0]); this.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { chooseFile(e.dataTransfer.files[0]); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('history-file').addEventListener('change', function () { addHistory(this.files); this.value = ''; });
    $('history-clear').addEventListener('click', function () { state.history = {}; renderHistory(); run(); });
    $('schedule-pick').addEventListener('change', function () { state.form = this.value; renderSchedule(); });
    $('schedule-filled').addEventListener('change', renderSchedule);
    $('rule-search').addEventListener('input', searchRules);
    tabs();
    renderRules();
  }

  SPEC.load().then(init, function (e) { fail(e.message); });

  // For the test page and for debugging in the console.
  B.app = { state: state, run: run, chooseFile: chooseFile };
})();

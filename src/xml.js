// Small XML reader that keeps line numbers, so a finding can point at the
// place in the file. It checks well-formedness (the first thing a schema
// validator rejects) and resolves namespaces. DTDs are skipped, not applied.
//
//   var doc = BSPV.xml.parse(text);   // throws BSPV.xml.XmlError { message, line, col }
//   doc.root = { name, prefix, ns, attrs, children, text, line, col }
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.BSPV = root.BSPV || {}).xml = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function XmlError(message, line, col) {
    this.name = 'XmlError';
    this.message = message;
    this.line = line;
    this.col = col;
  }
  XmlError.prototype = Object.create(Error.prototype);

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  // Letters beyond ASCII are allowed in names; the range is built from char codes
  // so that this source file stays plain ASCII.
  var HI = String.fromCharCode(0xC0) + '-' + String.fromCharCode(0xFFFF);
  var NAME = new RegExp('[A-Za-z_:' + HI + '][-A-Za-z0-9_:.' + String.fromCharCode(0xB7) + HI + ']*', 'y');

  function parse(text) {
    var pos = 0, len = text.length;
    if (text.charCodeAt(0) === 0xFEFF) pos = 1;

    // Line starts, for turning an offset into line and column on demand.
    var lineStarts = [0];
    for (var i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    function where(offset) {
      var lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
    }
    function fail(message, offset) {
      var w = where(offset === undefined ? pos : offset);
      throw new XmlError(message, w.line, w.col);
    }

    function decode(s, offset) {
      if (s.indexOf('&') < 0) return s;
      return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][A-Za-z0-9_.-]*)?;?/g, function (m, body, at) {
        if (!body || m.charAt(m.length - 1) !== ';') fail('"&" must be written as &amp; (found "' + m + '")', offset + at);
        if (body.charAt(0) === '#') {
          var code = body.charAt(1) === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10FFFF))) fail('Character reference ' + m + ' is not allowed in XML', offset + at);
          return String.fromCodePoint(code);
        }
        if (!Object.prototype.hasOwnProperty.call(ENTITIES, body)) fail('Unknown entity ' + m + ' (XML only knows &amp; &lt; &gt; &quot; &apos;)', offset + at);
        return ENTITIES[body];
      });
    }

    function readName() {
      NAME.lastIndex = pos;
      var m = NAME.exec(text);
      if (!m) fail('Expected a tag or attribute name');
      pos += m[0].length;
      return m[0];
    }
    function skipSpace() {
      while (pos < len) {
        var c = text.charCodeAt(pos);
        if (c === 32 || c === 9 || c === 10 || c === 13) pos++; else break;
      }
    }

    var decl = null, rootNode = null;
    var stack = [];
    var nsStack = [{ xml: 'http://www.w3.org/XML/1998/namespace' }];

    function split(qname) {
      var k = qname.indexOf(':');
      return k < 0 ? ['', qname] : [qname.slice(0, k), qname.slice(k + 1)];
    }

    while (pos < len) {
      var lt = text.indexOf('<', pos);
      var chunk = lt < 0 ? text.slice(pos) : text.slice(pos, lt);
      if (chunk) {
        if (stack.length) {
          stack[stack.length - 1].text += decode(chunk, pos);
        } else if (/\S/.test(chunk)) {
          fail(rootNode ? 'Text after the closing root tag' : 'Text before the root element', pos + chunk.search(/\S/));
        }
      }
      if (lt < 0) { pos = len; break; }
      pos = lt;

      if (text.startsWith('<!--', pos)) {
        var endC = text.indexOf('-->', pos + 4);
        if (endC < 0) fail('Comment is never closed (missing -->)');
        pos = endC + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', pos)) {
        if (!stack.length) fail('CDATA section outside the root element');
        var endD = text.indexOf(']]>', pos + 9);
        if (endD < 0) fail('CDATA section is never closed (missing ]]>)');
        stack[stack.length - 1].text += text.slice(pos + 9, endD);
        pos = endD + 3;
        continue;
      }
      if (text.startsWith('<?', pos)) {
        var endP = text.indexOf('?>', pos + 2);
        if (endP < 0) fail('Processing instruction is never closed (missing ?>)');
        var pi = text.slice(pos + 2, endP);
        if (/^xml\s/i.test(pi)) {
          if (pos > 1 || rootNode || stack.length) fail('The <?xml ...?> declaration must be the very first thing in the file');
          var enc = /encoding\s*=\s*["']([^"']+)["']/.exec(pi);
          var ver = /version\s*=\s*["']([^"']+)["']/.exec(pi);
          decl = { version: ver ? ver[1] : null, encoding: enc ? enc[1] : null };
        }
        pos = endP + 2;
        continue;
      }
      if (text.startsWith('<!', pos)) {
        // DOCTYPE: skip to the matching '>' (internal subsets use [ ... ]).
        var depth = 0, p = pos + 2;
        for (; p < len; p++) {
          var ch = text.charAt(p);
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (ch === '>' && depth <= 0) break;
        }
        if (p >= len) fail('<!DOCTYPE ...> is never closed');
        pos = p + 1;
        continue;
      }

      if (text.charAt(pos + 1) === '/') {
        var closeAt = pos;
        pos += 2;
        var closeName = readName();
        skipSpace();
        if (text.charAt(pos) !== '>') fail('Closing tag </' + closeName + ' is missing its ">"');
        pos++;
        var open = stack.pop();
        if (!open) fail('Closing tag </' + closeName + '> has no matching opening tag', closeAt);
        if (open.qname !== closeName) {
          fail('Closing tag </' + closeName + '> does not match <' + open.qname + '> opened on line ' + open.line, closeAt);
        }
        nsStack.pop();
        continue;
      }

      // start tag
      var startAt = pos;
      pos++;
      var qname = readName();
      var attrs = {}, rawAttrs = [];
      var selfClose = false;
      for (;;) {
        var before = pos;
        skipSpace();
        var c = text.charAt(pos);
        if (c === '>') { pos++; break; }
        if (c === '/' && text.charAt(pos + 1) === '>') { pos += 2; selfClose = true; break; }
        if (pos >= len) fail('Tag <' + qname + ' is never closed', startAt);
        if (before === pos) fail('Expected a space before the attribute in <' + qname + '>');
        var attrAt = pos;
        var an = readName();
        skipSpace();
        if (text.charAt(pos) !== '=') fail('Attribute ' + an + ' in <' + qname + '> has no value');
        pos++;
        skipSpace();
        var q = text.charAt(pos);
        if (q !== '"' && q !== "'") fail('The value of attribute ' + an + ' must be in quotes');
        var endQ = text.indexOf(q, pos + 1);
        if (endQ < 0) fail('The value of attribute ' + an + ' is missing its closing quote');
        var rawVal = text.slice(pos + 1, endQ);
        if (rawVal.indexOf('<') >= 0) fail('"<" is not allowed inside an attribute value (attribute ' + an + ')');
        var val = decode(rawVal, pos + 1);
        pos = endQ + 1;
        if (rawAttrs.some(function (a) { return a[0] === an; })) fail('Attribute ' + an + ' appears twice in <' + qname + '>', attrAt);
        rawAttrs.push([an, val]);
      }

      var scope = Object.create(nsStack[nsStack.length - 1]);
      rawAttrs.forEach(function (a) {
        if (a[0] === 'xmlns') scope[''] = a[1];
        else if (a[0].slice(0, 6) === 'xmlns:') scope[a[0].slice(6)] = a[1];
        attrs[a[0]] = a[1];
      });
      var parts = split(qname);
      var ns = scope[parts[0]];
      if (parts[0] && ns === undefined) fail('Namespace prefix "' + parts[0] + '" in <' + qname + '> is not declared', startAt);
      var w = where(startAt);
      var node = { name: parts[1], prefix: parts[0], qname: qname, ns: ns || '', attrs: attrs, children: [], text: '', line: w.line, col: w.col };

      if (stack.length) {
        stack[stack.length - 1].children.push(node);
      } else {
        if (rootNode) fail('A second root element <' + qname + '> starts here; an XML file has exactly one', startAt);
        rootNode = node;
      }
      if (!selfClose) {
        stack.push(node);
        nsStack.push(scope);
      }
    }

    if (stack.length) {
      var unclosed = stack[stack.length - 1];
      throw new XmlError('<' + unclosed.qname + '> is never closed (the file ends before </' + unclosed.qname + '>)', unclosed.line, unclosed.col);
    }
    if (!rootNode) throw new XmlError('The file has no XML element in it', 1, 1);
    return { root: rootNode, decl: decl, bom: text.charCodeAt(0) === 0xFEFF, lines: lineStarts.length };
  }

  // Escapes text for writing XML.
  function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { parse: parse, escape: escape, XmlError: XmlError };
});

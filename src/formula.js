// Parser for the formula language used in BSP report specifications
// (the "Assertions" sheet and the formulas of calculated cells).
//
//   [FRP_1][MAIN][R0020C0010]      a cell, by schedule / table / cell
//   [FRP_1]                        a schedule (ISNULL, COUNT, loops)
//   $[R0020C0010]  $[C0030]        a cell of the table or list row being evaluated
//   $0[MAIN_Y1]                    something in the schedule being evaluated
//   SUMIF([A][LIST]:$1; $1[C0020]="1"; $1[C0060])   $1 is each row of the list
//   + - * /   = <> != < > <= >=   AND OR   TRUE FALSE   "text"   12.5
//   functions take arguments separated by ";"
//
// parse(text) returns a tree of plain objects:
//   { t: 'num' | 'str' | 'bool', v }
//   { t: 'ref', scope: null | '$' | '$0' | '$1' ..., path: [names] }
//   { t: 'iter', list: ref, v: '$1' }
//   { t: 'call', fn, args }
//   { t: 'bin', op, a, b }      { t: 'neg', a }
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  (root.BSPV = root.BSPV || {}).formula = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TOKEN = /\s*(?:(\d+(?:\.\d+)?)|"([^"]*)"|(\$\d*)|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_]*)|(<>|!=|<=|>=|[-+*\/=<>();:]))/y;

  function tokenize(text) {
    var out = [], pos = 0;
    while (pos < text.length) {
      TOKEN.lastIndex = pos;
      var m = TOKEN.exec(text);
      if (!m) {
        if (/^\s*$/.test(text.slice(pos))) break;
        throw new Error('Cannot read formula at position ' + (pos + 1) + ': ' + text.slice(pos, pos + 20));
      }
      pos = TOKEN.lastIndex;
      if (m[1] !== undefined) out.push({ k: 'num', v: parseFloat(m[1]) });
      else if (m[2] !== undefined) out.push({ k: 'str', v: m[2] });
      else if (m[3] !== undefined) out.push({ k: 'scope', v: m[3] });
      else if (m[4] !== undefined) out.push({ k: 'seg', v: m[4].trim() });
      else if (m[5] !== undefined) out.push({ k: 'id', v: m[5] });
      else out.push({ k: 'op', v: m[6] });
    }
    return out;
  }

  var COMPARE = { '=': 1, '<>': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1 };

  function parse(text) {
    var toks = tokenize(text), i = 0;
    function peek() { return toks[i]; }
    function isOp(v) { var t = toks[i]; return t && t.k === 'op' && t.v === v; }
    function isWord(v) { var t = toks[i]; return t && t.k === 'id' && t.v.toUpperCase() === v; }
    function expect(v) {
      if (!isOp(v)) throw new Error('Expected "' + v + '" in formula: ' + text);
      i++;
    }

    function parseOr() {
      var a = parseAnd();
      while (isWord('OR')) { i++; a = { t: 'bin', op: 'OR', a: a, b: parseAnd() }; }
      return a;
    }
    function parseAnd() {
      var a = parseCompare();
      while (isWord('AND')) { i++; a = { t: 'bin', op: 'AND', a: a, b: parseCompare() }; }
      return a;
    }
    function parseCompare() {
      var a = parseAdd();
      while (peek() && peek().k === 'op' && COMPARE[peek().v]) {
        var op = toks[i++].v;
        a = { t: 'bin', op: op === '!=' ? '<>' : op, a: a, b: parseAdd() };
      }
      return a;
    }
    function parseAdd() {
      var a = parseMul();
      while (isOp('+') || isOp('-')) { var op = toks[i++].v; a = { t: 'bin', op: op, a: a, b: parseMul() }; }
      return a;
    }
    function parseMul() {
      var a = parseUnary();
      while (isOp('*') || isOp('/')) { var op = toks[i++].v; a = { t: 'bin', op: op, a: a, b: parseUnary() }; }
      return a;
    }
    function parseUnary() {
      if (isOp('-')) { i++; return { t: 'neg', a: parseUnary() }; }
      if (isOp('+')) { i++; return parseUnary(); }
      return parsePrimary();
    }
    function parseRef(scope) {
      var path = [];
      while (peek() && peek().k === 'seg') path.push(toks[i++].v);
      var ref = { t: 'ref', scope: scope, path: path };
      if (isOp(':')) {
        i++;
        var v = toks[i++];
        if (!v || v.k !== 'scope') throw new Error('Expected a row variable after ":" in formula: ' + text);
        return { t: 'iter', list: ref, v: v.v };
      }
      return ref;
    }
    function parsePrimary() {
      var t = toks[i];
      if (!t) throw new Error('Formula ends too early: ' + text);
      if (t.k === 'num') { i++; return { t: 'num', v: t.v }; }
      if (t.k === 'str') { i++; return { t: 'str', v: t.v }; }
      if (t.k === 'scope') { i++; return parseRef(t.v); }
      if (t.k === 'seg') return parseRef(null);
      if (t.k === 'id') {
        i++;
        var name = t.v.toUpperCase();
        if (isOp('(') && name !== 'TRUE' && name !== 'FALSE') {
          i++;
          var args = [];
          if (!isOp(')')) {
            args.push(parseOr());
            while (isOp(';')) { i++; args.push(parseOr()); }
          }
          expect(')');
          return { t: 'call', fn: name, args: args };
        }
        if (name === 'TRUE') return { t: 'bool', v: true };
        if (name === 'FALSE') return { t: 'bool', v: false };
        throw new Error('Unknown word "' + t.v + '" in formula: ' + text);
      }
      if (t.k === 'op' && t.v === '(') {
        i++;
        var inner = parseOr();
        expect(')');
        return inner;
      }
      throw new Error('Unexpected "' + t.v + '" in formula: ' + text);
    }

    var tree = parseOr();
    if (i < toks.length) throw new Error('Unexpected "' + toks[i].v + '" in formula: ' + text);
    return tree;
  }

  // Calls fn(node) for every node of the tree.
  function walk(node, fn) {
    fn(node);
    if (node.t === 'bin') { walk(node.a, fn); walk(node.b, fn); }
    else if (node.t === 'neg') walk(node.a, fn);
    else if (node.t === 'call') node.args.forEach(function (a) { walk(a, fn); });
    else if (node.t === 'iter') walk(node.list, fn);
  }

  return { parse: parse, tokenize: tokenize, walk: walk };
});

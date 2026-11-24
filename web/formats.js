// Read and write DataTables in the two text formats Unreal exports:
//  - JSON: [ { "Name": "Row_1", "Col": value, ... }, ... ]
//  - CSV : first header cell is the row-name column ("---" or "Name").
// parse() remembers the file's style (line endings, quoting) so write() can keep it.
// Anything that cannot be read without losing data throws instead of being guessed.
(function (root) {
  'use strict';
  var Num = root.AssetGuardMerge.Num;

  function detect(path, text) {
    var lower = (path || '').toLowerCase();
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.uasset')) return 'json'; // the server sends Unreal's JSON export of the DataTable
    if (lower.endsWith('.csv')) return 'csv';
    var t = (text || '').trim();
    return t.charAt(0) === '[' ? 'json' : 'csv';
  }

  // Line ending = the majority style outside quoted values is hard to know cheaply, so use the
  // first line break: a CRLF inside one quoted CSV value no longer flips a whole LF file.
  function lineEnding(text) {
    var i = text.indexOf('\n');
    return i > 0 && text.charAt(i - 1) === '\r' ? '\r\n' : '\n';
  }

  function checkName(seen, name, where) {
    if (name === '' || name === undefined || name === null) throw new Error(where + ': 행 이름이 비어 있어요.');
    var k = String(name).toLowerCase();
    if (seen.has(k)) throw new Error('행 이름 "' + name + '"이(가) 중복돼요 (언리얼은 대소문자를 구분하지 않아요). 중복을 정리한 뒤 다시 시도하세요.');
    seen.add(k);
  }

  // ---------- JSON (numbers kept as source text) ----------
  var NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  var STR_RE = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

  function parseJsonValue(text) {
    var i = 0;
    function fail(msg) { throw new Error('JSON 형식 오류(' + i + '번째 글자): ' + msg); }
    function ws() { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; }
    function expect(ch) { ws(); if (text[i] !== ch) fail('"' + ch + '"가 필요해요'); i++; }
    function str() {
      STR_RE.lastIndex = i; var m = STR_RE.exec(text);
      if (!m) fail('문자열이 올바르지 않아요');
      i += m[0].length; return JSON.parse(m[0]);
    }
    function val() {
      ws();
      var ch = text[i];
      if (ch === '{') {
        i++; var o = Object.create(null); ws();
        if (text[i] === '}') { i++; return o; }
        for (;;) {
          ws(); if (text[i] !== '"') fail('키는 문자열이어야 해요');
          var k = str();
          if (Object.prototype.hasOwnProperty.call(o, k)) fail('키 "' + k + '"가 중복돼요');
          expect(':'); o[k] = val(); ws();
          if (text[i] === ',') { i++; continue; }
          expect('}'); return o;
        }
      }
      if (ch === '[') {
        i++; var a = []; ws();
        if (text[i] === ']') { i++; return a; }
        for (;;) {
          a.push(val()); ws();
          if (text[i] === ',') { i++; continue; }
          expect(']'); return a;
        }
      }
      if (ch === '"') return str();
      if (text.startsWith('true', i)) { i += 4; return true; }
      if (text.startsWith('false', i)) { i += 5; return false; }
      if (text.startsWith('null', i)) { i += 4; return null; }
      NUM_RE.lastIndex = i; var m = NUM_RE.exec(text);
      if (m) { i += m[0].length; return new Num(m[0]); }
      fail('알 수 없는 값');
    }
    var v = val(); ws();
    if (i < text.length) fail('값 뒤에 남은 내용이 있어요');
    return v;
  }

  function jsonText(v, indent, level) {
    if (v instanceof Num) return v.raw;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    var compact = indent === null;
    var nl = compact ? '' : '\n', pad = compact ? '' : repeat(indent, level + 1), close = compact ? '' : repeat(indent, level);
    var sep = compact ? ',' : ',\n';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[' + nl + v.map(function (x) { return pad + jsonText(x, indent, level + 1); }).join(sep) + nl + close + ']';
    }
    var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; });
    if (!keys.length) return '{}';
    return '{' + nl + keys.map(function (k) {
      return pad + JSON.stringify(k) + (compact ? ':' : ': ') + jsonText(v[k], indent, level + 1);
    }).join(sep) + nl + close + '}';
  }
  function repeat(s, n) { var o = ''; while (n-- > 0) o += s; return o; }

  function parseJson(text) {
    var data = parseJsonValue(text.replace(/^﻿/, ''));
    if (!Array.isArray(data)) throw new Error('DataTable JSON은 행 배열이어야 해요.');
    var columns = [], seen = new Set();
    var rows = data.map(function (obj, i) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error((i + 1) + '번째 행이 객체가 아니에요.');
      if (!Object.prototype.hasOwnProperty.call(obj, 'Name')) throw new Error((i + 1) + '번째 행에 "Name"이 없어요.');
      var name = obj.Name instanceof Num ? obj.Name.raw : obj.Name;
      if (typeof name !== 'string') name = name === null ? '' : String(name);
      checkName(seen, name, (i + 1) + '번째 행');
      var cells = Object.create(null);
      Object.keys(obj).forEach(function (k) {
        if (k === 'Name') return;
        if (columns.indexOf(k) < 0) columns.push(k);
        cells[k] = obj[k];
      });
      return { name: name, cells: cells };
    });
    return { columns: columns, rows: rows, style: { format: 'json', eol: lineEnding(text), trailingNewline: /\n$/.test(text) } };
  }

  function writeJson(table, style) {
    var arr = table.rows.map(function (r) {
      var o = Object.create(null);
      o.Name = r.name;
      table.columns.forEach(function (c) { if (r.cells[c] !== undefined) o[c] = r.cells[c]; });
      return o;
    });
    var eol = (style && style.eol) || '\n';
    var out = jsonText(arr, '\t', 0).replace(/\n/g, eol);
    if (!style || style.trailingNewline) out += eol;
    return out;
  }

  // ---------- CSV ----------
  function parseCsvRecords(text) {
    // Only data value cells (not the header row, not the row-name column) decide quoteAll,
    // because Unreal quotes values but leaves names bare.
    var records = [], field = '', rec = [], i = 0, inQ = false, quotedFields = 0, totalFields = 0, wasQuoted = false;
    function endField() {
      if (records.length > 0 && rec.length > 0) { totalFields++; if (wasQuoted) quotedFields++; }
      rec.push(field); field = ''; wasQuoted = false;
    }
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; wasQuoted = true; i++; continue; }
      if (ch === ',') { endField(); i++; continue; }
      if (ch === '\r' || ch === '\n') {
        endField(); records.push(rec); rec = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if (inQ) throw new Error('CSV에 닫히지 않은 따옴표가 있어요.');
    if (field !== '' || rec.length) { endField(); records.push(rec); }
    return { records: records, quoteAll: totalFields > 0 && quotedFields / totalFields > 0.5 };
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    var parsed = parseCsvRecords(text);
    var recs = parsed.records.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
    var style = { format: 'csv', eol: lineEnding(text), header0: '---', quoteAll: parsed.quoteAll, trailingNewline: /\n$/.test(text) };
    if (!recs.length) return { columns: [], rows: [], style: style };
    var header = recs[0];
    style.header0 = header[0] || '---';
    var body = recs.slice(1);

    // Columns: names must be unique (case-insensitive, like Unreal properties). A blank header
    // is only allowed when the whole column is blank too (Excel's trailing commas).
    var keep = [], seenCols = new Set();
    header.slice(1).forEach(function (h, idx) {
      var col = idx + 1;
      if (h.trim() === '') {
        var used = body.some(function (r) { return (r[col] || '') !== ''; });
        if (used) throw new Error((col + 1) + '번째 열에 이름이 없는데 값이 들어 있어요.');
        return;
      }
      var k = h.toLowerCase();
      if (seenCols.has(k)) throw new Error('열 이름 "' + h + '"이(가) 중복돼요.');
      seenCols.add(k);
      keep.push({ name: h, idx: col });
    });

    var seen = new Set();
    var rows = body.map(function (r, n) {
      for (var j = header.length; j < r.length; j++) {
        if (r[j] !== '') throw new Error((n + 2) + '번째 줄에 헤더보다 많은 값이 있어요.');
      }
      checkName(seen, r[0], (n + 2) + '번째 줄');
      var cells = Object.create(null);
      keep.forEach(function (c) { cells[c.name] = r[c.idx] !== undefined ? r[c.idx] : ''; });
      return { name: r[0], cells: cells };
    });
    return { columns: keep.map(function (c) { return c.name; }), rows: rows, style: style };
  }

  function csvField(v, quoteAll) {
    var s = v === undefined || v === null ? '' : (typeof v === 'string' ? v : jsonText(v, null, 0));
    if (quoteAll || /[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function writeCsv(table, style) {
    style = style || {};
    var q = !!style.quoteAll, eol = style.eol || '\n';
    var lines = [[style.header0 || '---'].concat(table.columns).map(function (h) { return csvField(h, false); }).join(',')];
    table.rows.forEach(function (r) {
      lines.push([csvField(r.name, false)].concat(table.columns.map(function (c) { return csvField(r.cells[c], q); })).join(','));
    });
    var out = lines.join(eol);
    if (style.trailingNewline !== false) out += eol;
    return out;
  }

  function parse(path, text) {
    if (text === null || text === undefined) return null; // file missing on that side
    if (text.indexOf('\u0000') >= 0) throw new Error('UTF-16 같은 다른 인코딩으로 보여요. UTF-8로 저장한 뒤 다시 시도하세요.');
    return detect(path, text) === 'json' ? parseJson(text) : parseCsv(text);
  }

  function write(table, style) {
    return style && style.format === 'csv' ? writeCsv(table, style) : writeJson(table, style);
  }

  var api = {
    detect: detect, parse: parse, write: write, parseCsv: parseCsv, parseJson: parseJson,
    parseJsonValue: parseJsonValue, toJsonText: function (v) { return jsonText(v, null, 0); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AssetGuardFormats = api;
})(typeof window !== 'undefined' ? window : this);

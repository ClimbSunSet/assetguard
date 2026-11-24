// Read and write DataTables in the two text formats Unreal exports:
//  - JSON: [ { "Name": "Row_1", "Col": value, ... }, ... ]
//  - CSV : first header cell is the row-name column ("---" or "Name").
// parse() remembers the file's style (line endings, quoting) so write() can keep it.
(function (root) {
  'use strict';

  function detect(path, text) {
    var lower = (path || '').toLowerCase();
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.csv')) return 'csv';
    var t = (text || '').trim();
    return t.charAt(0) === '[' ? 'json' : 'csv';
  }

  function lineEnding(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }

  // ---------- JSON ----------
  function parseJson(text) {
    var data = JSON.parse(text.replace(/^﻿/, ''));
    if (!Array.isArray(data)) throw new Error('DataTable JSON은 행 배열이어야 해요.');
    var columns = [];
    var rows = data.map(function (obj, i) {
      if (!obj || typeof obj !== 'object') throw new Error(i + '번째 행이 객체가 아니에요.');
      var name = obj.Name !== undefined ? obj.Name : obj.name;
      if (name === undefined) throw new Error(i + '번째 행에 Name이 없어요.');
      var cells = {};
      Object.keys(obj).forEach(function (k) {
        if (k === 'Name' || k === 'name') return;
        if (columns.indexOf(k) < 0) columns.push(k);
        cells[k] = obj[k];
      });
      return { name: String(name), cells: cells };
    });
    return { columns: columns, rows: rows, style: { format: 'json', eol: lineEnding(text), trailingNewline: /\n$/.test(text) } };
  }

  function writeJson(table, style) {
    var arr = table.rows.map(function (r) {
      var o = { Name: r.name };
      table.columns.forEach(function (c) { if (r.cells[c] !== undefined) o[c] = r.cells[c]; });
      return o;
    });
    var eol = (style && style.eol) || '\n';
    var out = JSON.stringify(arr, null, '\t').replace(/\n/g, eol);
    if (!style || style.trailingNewline) out += eol;
    return out;
  }

  // ---------- CSV ----------
  function parseCsvRecords(text) {
    // Only data value cells (not the header row, not the row-name column) decide quoteAll,
    // because Unreal quotes values but leaves names bare.
    var records = [], field = '', rec = [], i = 0, inQ = false, quotedFields = 0, totalFields = 0, wasQuoted = false;
    text = text.replace(/^﻿/, '');
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
    if (field !== '' || rec.length) { endField(); records.push(rec); }
    return { records: records, quoteAll: totalFields > 0 && quotedFields / totalFields > 0.5 };
  }

  function parseCsv(text) {
    var parsed = parseCsvRecords(text);
    var recs = parsed.records.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
    if (!recs.length) return { columns: [], rows: [], style: { format: 'csv', eol: lineEnding(text), header0: '---', quoteAll: false, trailingNewline: true } };
    var header = recs[0];
    var columns = header.slice(1);
    var rows = recs.slice(1).map(function (r) {
      var cells = {};
      columns.forEach(function (c, idx) { cells[c] = r[idx + 1] !== undefined ? r[idx + 1] : ''; });
      return { name: r[0], cells: cells };
    });
    return { columns: columns, rows: rows, style: { format: 'csv', eol: lineEnding(text), header0: header[0] || '---', quoteAll: parsed.quoteAll, trailingNewline: /\n$/.test(text) } };
  }

  function csvField(v, quoteAll) {
    var s = v === undefined || v === null ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
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
    return detect(path, text) === 'json' ? parseJson(text) : parseCsv(text);
  }

  function write(table, style) {
    return style && style.format === 'csv' ? writeCsv(table, style) : writeJson(table, style);
  }

  var api = { detect: detect, parse: parse, write: write, parseCsv: parseCsv, parseJson: parseJson };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AssetGuardFormats = api;
})(typeof window !== 'undefined' ? window : this);

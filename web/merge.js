// AssetGuard 3-way merge engine for DataTable-shaped data.
// A table is { columns: string[], rows: [{ name: string, cells: { [col]: any } }] }.
// Rules are deterministic: the same three inputs always give the same result.
// When a case cannot be merged safely, merge3 throws instead of guessing.
(function (root) {
  'use strict';

  // A number kept as its original source text, so 9007199254740993 or 2.000000
  // survive a round trip unchanged. formats.js creates these when reading JSON.
  function Num(raw) { this.raw = String(raw); }
  Num.prototype.toString = function () { return this.raw; };
  Num.prototype.toJSON = function () { return this.raw; };

  // Numeric text normalised for comparison only: "2.000000" == "2", "-0012.50" == "-12.5".
  function normNum(raw) {
    var s = String(raw).trim().toLowerCase().replace(/^\+/, '');
    var m = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(s);
    if (!m) return s;
    var intPart = m[2].replace(/^0+(?=\d)/, '') || '0';
    var frac = (m[3] || '').replace(/0+$/, '');
    var exp = m[4] ? parseInt(m[4], 10) : 0;
    return m[1] + intPart + (frac ? '.' + frac : '') + (exp ? 'e' + exp : '');
  }

  function has(obj, k) { return obj != null && Object.prototype.hasOwnProperty.call(obj, k); }
  function get(cells, k) { return has(cells, k) ? cells[k] : undefined; }

  // Stable comparison key for any value (object keys sorted, numbers by value text).
  function canon(v) {
    if (v === undefined) return '\u0000undefined';
    if (v instanceof Num) return 'n:' + normNum(v.raw);
    if (typeof v === 'number') return 'n:' + normNum(String(v));
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canon(v[k]);
    }).join(',') + '}';
  }
  function same(a, b) { return canon(a) === canon(b); }

  // Unreal row names (FName) are case-insensitive, so rows are matched case-insensitively.
  function keyOf(name) { return String(name).toLowerCase(); }

  function indexRows(table, label) {
    var map = new Map();
    if (!table) return map;
    table.rows.forEach(function (r) {
      var k = keyOf(r.name);
      if (map.has(k)) throw new Error(label + ' 버전에 행 이름 "' + r.name + '"이(가) 중복돼요. 중복을 정리한 뒤 다시 시도하세요.');
      map.set(k, r);
    });
    return map;
  }

  function unionColumns(lists) {
    var out = [];
    lists.forEach(function (cols) {
      (cols || []).forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    });
    return out;
  }

  // "No value" for a cell: missing (JSON key absent) or empty CSV text.
  function isEmpty(v) { return v === undefined || v === ''; }

  // Merge one cell. Returns { value, source } or { conflict: true }.
  // source: 'base' (nobody changed), 'ours', 'theirs', 'both' (same change on both sides).
  function mergeCell(b, o, t) {
    var oChanged = !same(o, b);
    var tChanged = !same(t, b);
    if (!oChanged && !tChanged) return { value: b, source: 'base' };
    if (oChanged && !tChanged) return { value: o, source: 'ours' };
    if (!oChanged && tChanged) return { value: t, source: 'theirs' };
    if (same(o, t)) return { value: o, source: 'both' };
    return { conflict: true };
  }

  // Did `side` change column `c` compared to base (edited a value, or gave a new row a value)?
  function columnTouched(B, side, c) {
    return side.rows.some(function (r) {
      var br = B.get(keyOf(r.name));
      if (!br) return !isEmpty(get(r.cells, c));
      return !same(get(br.cells, c), get(r.cells, c));
    });
  }

  // Row order: ours order first. A row that exists only in theirs goes right after its
  // nearest preceding neighbour from theirs, but after any rows only we added there,
  // so "my additions, then their additions" reads naturally.
  function orderRows(B, O, T, ours, theirs) {
    var order = (ours ? ours.rows : []).map(function (r) { return keyOf(r.name); });
    var oursOnly = function (k) { return !B.has(k) && !T.has(k); };
    var anchor = null; // last theirs row that is already placed in `order`
    (theirs ? theirs.rows : []).forEach(function (r) {
      var k = keyOf(r.name);
      if (!O.has(k)) {
        var at = anchor === null ? 0 : order.indexOf(anchor) + 1;
        while (at < order.length && oursOnly(order[at])) at++;
        order.splice(at, 0, k);
        anchor = k;
      } else {
        anchor = k;
      }
    });
    return order;
  }

  /**
   * merge3(base, ours, theirs) -> {
   *   columns, rows: [{ name, status, cells: {col: {value, source, conflictId?}} }],
   *   conflicts: [{ id, kind: 'cell'|'row', row, column?, base, ours, theirs }],
   *   stats: { autoCells, conflictCells, conflictRows, addedOurs, addedTheirs, deleted },
   *   warnings: string[]
   * }
   * base may be null (file added on both sides). ours and theirs must exist.
   * Row status: 'unchanged' | 'modified' | 'added-ours' | 'added-theirs' | 'added-both'
   *           | 'deleted' (kept in the list so the UI can show it) | 'conflict'.
   * Throws when the file cannot be merged safely (duplicate names, a column one side
   * deleted while the other side changed it).
   */
  function merge3(base, ours, theirs) {
    if (!ours || !theirs) throw new Error('한쪽 버전이 없어요. 파일을 남길지 지울지 먼저 정하세요.');
    var B = indexRows(base, '공통 원본'), O = indexRows(ours, '내'), T = indexRows(theirs, '상대');
    var colsB = base ? base.columns : [], colsO = ours.columns, colsT = theirs.columns;
    var warnings = [];

    // ---- columns ----
    var columns = unionColumns([colsO, colsT, colsB]).filter(function (c) {
      var inB = colsB.indexOf(c) >= 0, inO = colsO.indexOf(c) >= 0, inT = colsT.indexOf(c) >= 0;
      if (!inB || (inO && inT)) return true;
      if (!inO && !inT) return false; // both deleted it
      var keeper = inO ? ours : theirs, deleter = inO ? '상대' : '내가';
      if (columnTouched(B, keeper, c)) {
        throw new Error('"' + c + '" 열을 ' + (inO ? '상대가' : '내가') + ' 지웠는데 ' + (inO ? '내 쪽' : '상대 쪽') +
          '에서 그 열 값을 바꿨어요. 열을 지울지 남길지 정해서 한쪽을 맞춘 뒤 다시 시도하세요.');
      }
      warnings.push('"' + c + '" 열은 ' + deleter + ' 지워서 결과에서 뺐어요.');
      return false;
    });
    if (base) {
      columns.forEach(function (c) {
        var inB = colsB.indexOf(c) >= 0, inO = colsO.indexOf(c) >= 0, inT = colsT.indexOf(c) >= 0;
        if (inB || (inO && inT)) return;
        var adderIsOurs = inO;
        var n = (adderIsOurs ? theirs : ours).rows.filter(function (r) { return !B.has(keyOf(r.name)); }).length;
        if (n) warnings.push((adderIsOurs ? '상대' : '내') + '가 추가한 행 ' + n + '개에는 ' + (adderIsOurs ? '내가' : '상대가') +
          ' 새로 만든 "' + c + '" 열 값이 없어서 기본값(빈 값)으로 들어가요.');
      });
    }

    var conflicts = [];
    var stats = { autoCells: 0, conflictCells: 0, conflictRows: 0, addedOurs: 0, addedTheirs: 0, deleted: 0 };
    var allKeys = new Set([].concat(Array.from(B.keys()), Array.from(O.keys()), Array.from(T.keys())));
    var merged = new Map();

    function fill(src, source) {
      var cells = Object.create(null);
      columns.forEach(function (c) { cells[c] = { value: get(src.cells, c), source: source }; });
      return cells;
    }

    function rowConflict(name, b, o, t) {
      var id = 'c' + conflicts.length;
      var pick = function (r) {
        if (!r) return null;
        var out = Object.create(null);
        columns.forEach(function (c) { out[c] = get(r.cells, c); });
        return out;
      };
      conflicts.push({ id: id, kind: 'row', row: name, base: pick(b), ours: pick(o), theirs: pick(t) });
      stats.conflictRows++;
      var shown = o || t;
      var cells = Object.create(null);
      columns.forEach(function (c) { cells[c] = { value: get(shown.cells, c), source: 'conflict', conflictId: id }; });
      return { name: name, status: 'conflict', rowConflict: true, conflictId: id, deletedBy: o ? 'theirs' : 'ours', cells: cells };
    }

    function rowName(b, o, t) {
      // Same row, different capitalisation: Unreal treats them as one row. Keep ours' spelling
      // unless only theirs changed it, and say so.
      if (!o || !t) return (o || t || b).name;
      var r = mergeCell(b && b.name, o.name, t.name);
      if (!r.conflict) return r.value;
      warnings.push('행 이름 대소문자가 양쪽에서 달라요: "' + o.name + '" / "' + t.name + '". 언리얼에서는 같은 행이라 "' + o.name + '"(내 쪽)로 맞췄어요.');
      return o.name;
    }

    allKeys.forEach(function (key) {
      var b = B.get(key), o = O.get(key), t = T.get(key);
      var name = rowName(b, o, t);
      var row = { name: name, status: 'unchanged', cells: Object.create(null) };

      if (!o && !t) { // deleted on both sides
        row.status = 'deleted'; row.deletedBy = 'both'; row.cells = fill(b, 'base'); stats.deleted++;
        merged.set(key, row); return;
      }
      if (b && !o && t) { // ours deleted
        if (mergeableDelete(b, t)) { row.status = 'deleted'; row.deletedBy = 'ours'; row.cells = fill(b, 'base'); stats.deleted++; }
        else row = rowConflict(name, b, o, t);
        merged.set(key, row); return;
      }
      if (b && o && !t) { // theirs deleted
        if (mergeableDelete(b, o)) { row.status = 'deleted'; row.deletedBy = 'theirs'; row.cells = fill(b, 'base'); stats.deleted++; }
        else row = rowConflict(name, b, o, t);
        merged.set(key, row); return;
      }
      if (!b && o && !t) { row.status = 'added-ours'; row.cells = fill(o, 'ours'); stats.addedOurs++; stats.autoCells += columns.length; merged.set(key, row); return; }
      if (!b && !o && t) { row.status = 'added-theirs'; row.cells = fill(t, 'theirs'); stats.addedTheirs++; stats.autoCells += columns.length; merged.set(key, row); return; }

      // Present on both sides (base may be missing when both added the same name).
      var bCells = b ? b.cells : Object.create(null);
      var anyConflict = false, anyChange = false;
      columns.forEach(function (c) {
        var r = mergeCell(get(bCells, c), get(o.cells, c), get(t.cells, c));
        if (r.conflict) {
          var id = 'c' + conflicts.length;
          conflicts.push({ id: id, kind: 'cell', row: name, column: c, base: get(bCells, c), ours: get(o.cells, c), theirs: get(t.cells, c) });
          row.cells[c] = { value: undefined, source: 'conflict', conflictId: id };
          anyConflict = true;
          stats.conflictCells++;
        } else {
          row.cells[c] = { value: r.value, source: r.source };
          if (r.source !== 'base') { anyChange = true; stats.autoCells++; }
        }
      });
      row.status = anyConflict ? 'conflict' : (!b ? 'added-both' : (anyChange ? 'modified' : 'unchanged'));
      merged.set(key, row);
    });

    // A delete is safe only if the other side left every surviving column of the row untouched.
    function mergeableDelete(b, kept) {
      return columns.every(function (c) { return same(get(b.cells, c), get(kept.cells, c)); });
    }

    var order = orderRows(B, O, T, ours, theirs);
    var seen = new Set(order);
    // Rows deleted on both sides are not in ours/theirs; keep them visible at the end.
    merged.forEach(function (_, k) { if (!seen.has(k)) order.push(k); });
    var rows = order.map(function (k) { return merged.get(k); });

    return { columns: columns, rows: rows, conflicts: conflicts, stats: stats, warnings: warnings };
  }

  /**
   * Turn a merge result plus user choices into a plain table.
   * choices: { [conflictId]: 'ours' | 'theirs' | 'base' | { custom: value } }
   * Throws if a conflict has no choice. Keeps every merged column, even with zero rows.
   */
  function applyResolutions(result, choices) {
    var byId = {};
    result.conflicts.forEach(function (c) { byId[c.id] = c; });
    var rows = [];
    result.rows.forEach(function (r) {
      if (r.status === 'deleted') return;
      if (r.rowConflict) {
        var cf = byId[r.conflictId];
        var pick = choices[cf.id];
        if (!pick || typeof pick === 'object') throw new Error('미해결 충돌: ' + r.name);
        var src = pick === 'ours' ? cf.ours : pick === 'theirs' ? cf.theirs : cf.base;
        if (src) rows.push({ name: r.name, cells: copyCells(src, result.columns) });
        return;
      }
      var cells = Object.create(null);
      result.columns.forEach(function (c) {
        var cell = r.cells[c];
        if (cell.source === 'conflict') {
          var cf2 = byId[cell.conflictId];
          var p = choices[cf2.id];
          if (!p) throw new Error('미해결 충돌: ' + r.name + '.' + c);
          cells[c] = (typeof p === 'object' && has(p, 'custom')) ? p.custom : cf2[p];
        } else {
          cells[c] = cell.value;
        }
      });
      rows.push({ name: r.name, cells: cells });
    });
    return { columns: result.columns.slice(), rows: rows };
  }

  function copyCells(src, columns) {
    var out = Object.create(null);
    columns.forEach(function (c) { out[c] = get(src, c); });
    return out;
  }

  var api = { merge3: merge3, applyResolutions: applyResolutions, canon: canon, same: same, Num: Num, normNum: normNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AssetGuardMerge = api;
})(typeof window !== 'undefined' ? window : this);

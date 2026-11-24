// AssetGuard 3-way merge engine for DataTable-shaped data.
// A table is { columns: string[], rows: [{ name: string, cells: { [col]: any } }] }.
// Rules are deterministic: the same three inputs always give the same result.
(function (root) {
  'use strict';

  // Stable comparison key for any JSON value (object keys sorted).
  function canon(v) {
    if (v === undefined) return '\u0000undefined';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canon(v[k]);
    }).join(',') + '}';
  }
  function same(a, b) { return canon(a) === canon(b); }

  function indexRows(table) {
    var map = new Map();
    if (!table) return map;
    table.rows.forEach(function (r) { map.set(r.name, r); });
    return map;
  }

  function unionColumns(lists) {
    var out = [];
    lists.forEach(function (cols) {
      (cols || []).forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    });
    return out;
  }

  function rowsEqual(a, b, columns) {
    return columns.every(function (c) { return same(a.cells[c], b.cells[c]); });
  }

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

  // Row order: ours order first. A row that exists only in theirs goes right after its
  // nearest preceding neighbour from theirs, but after any rows only we added there,
  // so "my additions, then their additions" reads naturally.
  function orderRows(base, ours, theirs) {
    var inBase = indexRows(base), inTheirs = indexRows(theirs);
    var order = (ours ? ours.rows : []).map(function (r) { return r.name; });
    var oursOnly = function (n) { return !inBase.has(n) && !inTheirs.has(n); };
    var prev = null;
    (theirs ? theirs.rows : []).forEach(function (r) {
      if (order.indexOf(r.name) < 0) {
        var at = prev === null ? 0 : order.indexOf(prev) + 1;
        while (at < order.length && oursOnly(order[at])) at++;
        order.splice(at, 0, r.name);
      }
      prev = r.name;
    });
    return order;
  }

  /**
   * merge3(base, ours, theirs) -> {
   *   columns, rows: [{ name, status, cells: {col: {value, source, conflictId?}} }],
   *   conflicts: [{ id, kind: 'cell'|'row', row, column?, base, ours, theirs }],
   *   stats: { autoCells, conflictCells, conflictRows, addedOurs, addedTheirs, deleted }
   * }
   * Row status: 'unchanged' | 'modified' | 'added-ours' | 'added-theirs' | 'added-both'
   *           | 'deleted' (kept in the list so the UI can show it) | 'conflict'.
   */
  function merge3(base, ours, theirs) {
    var B = indexRows(base), O = indexRows(ours), T = indexRows(theirs);
    var columns = unionColumns([ours && ours.columns, theirs && theirs.columns, base && base.columns]);
    var conflicts = [];
    var stats = { autoCells: 0, conflictCells: 0, conflictRows: 0, addedOurs: 0, addedTheirs: 0, deleted: 0 };
    var allNames = new Set([].concat(Array.from(B.keys()), Array.from(O.keys()), Array.from(T.keys())));
    var merged = new Map();

    allNames.forEach(function (name) {
      var b = B.get(name), o = O.get(name), t = T.get(name);
      var emptyCells = {};
      var row = { name: name, status: 'unchanged', cells: {} };

      // Row-level cases first.
      if (!o && !t) { // deleted on both sides (or never existed)
        if (b) { row.status = 'deleted'; row.deletedBy = 'both'; row.cells = fill(b, 'base'); stats.deleted++; merged.set(name, row); }
        return;
      }
      if (b && !o && t) { // ours deleted
        if (rowsEqual(b, t, columns)) { row.status = 'deleted'; row.deletedBy = 'ours'; row.cells = fill(b, 'base'); stats.deleted++; }
        else row = rowConflict(name, b, o, t);
        merged.set(name, row);
        return;
      }
      if (b && o && !t) { // theirs deleted
        if (rowsEqual(b, o, columns)) { row.status = 'deleted'; row.deletedBy = 'theirs'; row.cells = fill(b, 'base'); stats.deleted++; }
        else row = rowConflict(name, b, o, t);
        merged.set(name, row);
        return;
      }
      if (!b && o && !t) { row.status = 'added-ours'; row.cells = fill(o, 'ours'); stats.addedOurs++; stats.autoCells += columns.length; merged.set(name, row); return; }
      if (!b && !o && t) { row.status = 'added-theirs'; row.cells = fill(t, 'theirs'); stats.addedTheirs++; stats.autoCells += columns.length; merged.set(name, row); return; }

      // Present on both sides (base may be missing when both added the same name).
      var bb = b || { cells: emptyCells };
      var anyConflict = false, anyChange = false;
      columns.forEach(function (c) {
        var r = mergeCell(bb.cells[c], o.cells[c], t.cells[c]);
        if (r.conflict) {
          var id = 'c' + conflicts.length;
          conflicts.push({ id: id, kind: 'cell', row: name, column: c, base: bb.cells[c], ours: o.cells[c], theirs: t.cells[c] });
          row.cells[c] = { value: undefined, source: 'conflict', conflictId: id };
          anyConflict = true;
          stats.conflictCells++;
        } else {
          row.cells[c] = { value: r.value, source: r.source };
          if (r.source !== 'base') { anyChange = true; stats.autoCells++; }
        }
      });
      row.status = anyConflict ? 'conflict' : (!b ? 'added-both' : (anyChange ? 'modified' : 'unchanged'));
      merged.set(name, row);
    });

    function fill(src, source) {
      var cells = {};
      columns.forEach(function (c) { cells[c] = { value: src.cells[c], source: source }; });
      return cells;
    }

    function rowConflict(name, b, o, t) {
      var id = 'c' + conflicts.length;
      conflicts.push({
        id: id, kind: 'row', row: name,
        base: b ? b.cells : null, ours: o ? o.cells : null, theirs: t ? t.cells : null
      });
      stats.conflictRows++;
      var shown = o || t;
      var cells = {};
      columns.forEach(function (c) { cells[c] = { value: shown.cells[c], source: 'conflict', conflictId: id }; });
      return { name: name, status: 'conflict', rowConflict: true, conflictId: id, deletedBy: o ? 'theirs' : 'ours', cells: cells };
    }

    var order = orderRows(base, ours, theirs);
    // Rows deleted on both sides are not in ours/theirs; keep them visible at the end.
    merged.forEach(function (_, n) { if (order.indexOf(n) < 0) order.push(n); });
    var rows = order.filter(function (n) { return merged.has(n); }).map(function (n) { return merged.get(n); });

    return { columns: columns, rows: rows, conflicts: conflicts, stats: stats };
  }

  /**
   * Turn a merge result plus user choices into a plain table.
   * choices: { [conflictId]: 'ours' | 'theirs' | 'base' | { custom: value } }
   * Throws if a conflict has no choice.
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
        if (!pick) throw new Error('미해결 충돌: ' + r.name);
        var src = pick === 'ours' ? cf.ours : pick === 'theirs' ? cf.theirs : cf.base;
        if (src) rows.push({ name: r.name, cells: copyCells(src, result.columns) });
        return;
      }
      var cells = {};
      result.columns.forEach(function (c) {
        var cell = r.cells[c];
        if (cell.source === 'conflict') {
          var cf2 = byId[cell.conflictId];
          var p = choices[cf2.id];
          if (!p) throw new Error('미해결 충돌: ' + r.name + '.' + c);
          cells[c] = (p && typeof p === 'object' && 'custom' in p) ? p.custom : cf2[p];
        } else {
          cells[c] = cell.value;
        }
      });
      rows.push({ name: r.name, cells: cells });
    });
    // Drop columns that no remaining row uses (e.g. a column removed on one side).
    var columns = result.columns.filter(function (c) {
      return rows.some(function (r) { return r.cells[c] !== undefined; });
    });
    return { columns: columns, rows: rows };
  }

  function copyCells(src, columns) {
    var out = {};
    columns.forEach(function (c) { out[c] = src[c]; });
    return out;
  }

  var api = { merge3: merge3, applyResolutions: applyResolutions, canon: canon, same: same };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AssetGuardMerge = api;
})(typeof window !== 'undefined' ? window : this);

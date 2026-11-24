(function () {
  'use strict';
  var M = window.AssetGuardMerge, F = window.AssetGuardFormats;
  var $ = function (id) { return document.getElementById(id); };

  var state = { session: null, files: [], current: 0, demo: false, openedAt: Date.now() };

  // Sample used when the page is opened without a live Git conflict (assetguard.ps1 -ServeOnly).
  var DEMO = {
    mode: 'demo',
    repo: '데모 데이터 (실제 저장소 아님)',
    labels: { base: '공통 원본', ours: 'feature/vehicle-tuning', theirs: 'feature/new-monsters' },
    files: [{
      path: 'Content/Data/DT_Monsters.json',
      commits: {
        base: { hash: 'a1b2c3d', author: '팀장', when: '3일 전', subject: '몬스터 테이블 초안' },
        ours: { hash: 'e4f5a6b', author: '나 (개발)', when: '2시간 전', subject: '고블린 체력 밸런스, 오크 이동속도 조정' },
        theirs: { hash: 'c7d8e9f', author: '기획자', when: '40분 전', subject: '슬라임 추가, 오크 체력·보상 조정' }
      },
      base: JSON.stringify([
        { Name: 'Goblin', HP: 100, Speed: 3.5, Reward: 10, Mesh: '/Game/Monsters/SK_Goblin' },
        { Name: 'Orc', HP: 250, Speed: 2.0, Reward: 30, Mesh: '/Game/Monsters/SK_Orc' },
        { Name: 'Wolf', HP: 80, Speed: 6.0, Reward: 12, Mesh: '/Game/Monsters/SK_Wolf' },
        { Name: 'Bat', HP: 30, Speed: 7.0, Reward: 3, Mesh: '/Game/Monsters/SK_Bat' }
      ], null, '\t'),
      ours: JSON.stringify([
        { Name: 'Goblin', HP: 120, Speed: 3.5, Reward: 10, Mesh: '/Game/Monsters/SK_Goblin' },
        { Name: 'Orc', HP: 280, Speed: 2.4, Reward: 30, Mesh: '/Game/Monsters/SK_Orc' },
        { Name: 'Wolf', HP: 80, Speed: 6.0, Reward: 12, Mesh: '/Game/Monsters/SK_Wolf' },
        { Name: 'Bat', HP: 30, Speed: 7.0, Reward: 3, Mesh: '/Game/Monsters/SK_Bat' },
        { Name: 'Troll', HP: 600, Speed: 1.5, Reward: 80, Mesh: '/Game/Monsters/SK_Troll' }
      ], null, '\t'),
      theirs: JSON.stringify([
        { Name: 'Goblin', HP: 100, Speed: 3.5, Reward: 15, Mesh: '/Game/Monsters/SK_Goblin' },
        { Name: 'Orc', HP: 300, Speed: 2.0, Reward: 40, Mesh: '/Game/Monsters/SK_Orc' },
        { Name: 'Wolf', HP: 80, Speed: 6.0, Reward: 12, Mesh: '/Game/Monsters/SK_Wolf' },
        { Name: 'Slime', HP: 40, Speed: 1.0, Reward: 5, Mesh: '/Game/Monsters/SK_Slime' }
      ], null, '\t')
    }],
    skipped: [{ path: 'Content/Maps/L_Main.umap', reason: '.uasset 직접 병합은 다음 단계(언리얼 에디터 연동)에서 지원 예정' }]
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function show(v) {
    if (v === undefined) return '<span class="muted">(없음)</span>';
    if (v === null) return 'null';
    if (typeof v === 'object') return esc(JSON.stringify(v));
    if (v === '') return '<span class="muted">""</span>';
    return esc(v);
  }
  function commitText(c) {
    if (!c) return '';
    return c.author + ' · ' + c.when + ' · "' + c.subject + '"';
  }
  function labels() { return state.session.labels; }

  // ---------- load ----------
  function load() {
    fetch('/api/session').then(function (r) { return r.json(); }).catch(function () { return { mode: 'none' }; })
      .then(function (s) {
        if (!s || s.mode !== 'git' || !s.files || !s.files.length) { s = DEMO; state.demo = true; }
        state.session = s;
        state.files = s.files.map(prepare);
        renderChrome();
        select(0);
      });
  }

  function prepare(f) {
    var entry = { raw: f, error: null, result: null, choices: {}, saved: false, style: null };
    try {
      var base = F.parse(f.path, f.base), ours = F.parse(f.path, f.ours), theirs = F.parse(f.path, f.theirs);
      entry.style = (ours || theirs || base).style;
      entry.result = M.merge3(base, ours, theirs);
    } catch (e) {
      entry.error = e.message;
    }
    return entry;
  }

  function unresolved(entry) {
    if (!entry.result) return 0;
    return entry.result.conflicts.filter(function (c) { return !entry.choices[c.id]; }).length;
  }

  // ---------- chrome ----------
  function renderChrome() {
    var s = state.session, L = labels();
    $('repo').textContent = s.repo || '';
    $('sides').innerHTML =
      '<span class="side src-ours">나 <b>' + esc(L.ours) + '</b></span>' +
      '<span class="side src-theirs">상대 <b>' + esc(L.theirs) + '</b></span>';
    if (state.demo) {
      banner('지금은 <b>데모 데이터</b>예요. 실제 충돌은 머지 충돌 난 저장소에서 <code>assetguard.ps1</code>을 실행하면 열려요.', 'info');
    }
    $('skipped').innerHTML = (s.skipped && s.skipped.length)
      ? '<h2>건너뛴 파일</h2>' + s.skipped.map(function (k) {
          return '<div class="skip"><div class="mono">' + esc(k.path) + '</div>' + esc(k.reason) + '</div>';
        }).join('')
      : '';
    renderFileList();
  }

  function banner(html, kind) {
    var b = $('banner');
    b.innerHTML = html; b.className = 'banner' + (kind ? ' ' + kind : ''); b.hidden = !html;
  }

  function renderFileList() {
    $('fileList').innerHTML = state.files.map(function (e, i) {
      var left = unresolved(e);
      var st = e.error ? '<span class="state todo">읽기 실패</span>'
        : e.saved ? '<span class="state done">저장됨 ✓</span>'
        : left ? '<span class="state todo">확인 ' + left + '곳 남음</span>'
        : '<span class="state done">저장 준비됨</span>';
      return '<li class="' + (i === state.current ? 'active' : '') + '"><button data-file="' + i + '">' +
        '<span class="path">' + esc(e.raw.path) + '</span>' + st + '</button></li>';
    }).join('');
  }

  function select(i) {
    state.current = i;
    renderFileList();
    renderFile();
  }

  // ---------- main ----------
  function cur() { return state.files[state.current]; }

  function renderFile() {
    var e = cur();
    if (e.error) {
      $('summary').innerHTML = '';
      $('grid').innerHTML = '';
      $('conflictList').innerHTML = '<div class="empty">이 파일을 DataTable로 읽지 못했어요: ' + esc(e.error) + '</div>';
      updateSave();
      return;
    }
    renderSummary();
    renderGrid();
    renderConflicts();
    updateSave();
  }

  function renderSummary() {
    var e = cur(), st = e.result.stats, total = e.result.conflicts.length, left = unresolved(e);
    var c = e.raw.commits || {}, L = labels();
    $('summary').innerHTML =
      stat(st.autoCells, '자동으로 합친 칸', 'good') +
      stat(st.addedOurs + st.addedTheirs, '추가된 행 (나 ' + st.addedOurs + ' · 상대 ' + st.addedTheirs + ')') +
      stat(st.deleted, '삭제된 행') +
      stat(total, '직접 확인할 곳' + (total ? ' (남은 ' + left + ')' : ''), total ? 'warn' : 'good') +
      '<div class="stat" style="grid-column: 1 / -1"><span class="l">' +
        '<span class="chip src-ours">나</span> ' + esc(commitText(c.ours) || L.ours) + '<br>' +
        '<span class="chip src-theirs">상대</span> ' + esc(commitText(c.theirs) || L.theirs) +
        (c.base ? '<br><span class="chip src-base">원본</span> ' + esc(commitText(c.base)) : '') +
      '</span></div>';
  }
  function stat(n, label, kind) {
    return '<div class="stat ' + (kind || '') + '"><span class="n">' + n + '</span><span class="l">' + esc(label) + '</span></div>';
  }

  var STATUS_TEXT = {
    'unchanged': '', 'modified': '수정됨', 'added-ours': '내가 추가', 'added-theirs': '상대가 추가',
    'added-both': '양쪽이 추가', 'conflict': '확인 필요'
  };
  var SRC_TEXT = { ours: '나', theirs: '상대', both: '양쪽 동일', base: '' };

  function renderGrid() {
    var e = cur(), r = e.result, only = $('onlyChanged').checked;
    var byId = {}; r.conflicts.forEach(function (c) { byId[c.id] = c; });
    var html = '<thead><tr><th>행 이름</th>' + r.columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    var shown = 0;
    r.rows.forEach(function (row) {
      if (only && row.status === 'unchanged') return;
      shown++;
      var tag = row.status === 'deleted' ? (row.deletedBy === 'both' ? '양쪽이 삭제' : (row.deletedBy === 'ours' ? '내가 삭제' : '상대가 삭제'))
        : row.rowConflict ? (row.deletedBy === 'ours' ? '내가 삭제 · 상대가 수정' : '상대가 삭제 · 내가 수정')
        : row.status === 'conflict' && r.columns.every(function (col) { var cl = row.cells[col]; return cl.source !== 'conflict' || e.choices[cl.conflictId]; }) ? '확인 완료'
        : STATUS_TEXT[row.status];
      html += '<tr class="' + (row.status === 'deleted' ? 'deleted' : '') + '"><td class="rowname">' + esc(row.name) +
        (tag ? '<span class="tag">' + esc(tag) + '</span>' : '') + '</td>';
      r.columns.forEach(function (col) {
        var cell = row.cells[col];
        if (cell.source === 'conflict') {
          var cf = byId[cell.conflictId], pick = e.choices[cf.id];
          var val, who;
          if (!pick) { val = '?'; who = '선택 필요'; }
          else if (cf.kind === 'row') { val = pick === 'theirs' ? show(cf.theirs && cf.theirs[col]) : pick === 'ours' ? show(cf.ours && cf.ours[col]) : show(cf.base && cf.base[col]); who = '선택: ' + sideName(pick); }
          else if (typeof pick === 'object') { val = show(pick.custom); who = '직접 입력'; }
          else { val = show(cf[pick]); who = '선택: ' + sideName(pick); }
          html += '<td class="cell src-conflict' + (pick ? ' picked' : '') + '" data-conflict="' + cf.id + '">' + val + '<span class="who">' + esc(who) + '</span></td>';
        } else {
          var t = SRC_TEXT[cell.source];
          html += '<td class="cell src-' + cell.source + '">' + show(cell.value) + (t ? '<span class="who">' + t + '</span>' : '') + '</td>';
        }
      });
      html += '</tr>';
    });
    if (!shown) html += '<tr><td colspan="' + (r.columns.length + 1) + '" class="muted">바뀐 행이 없어요.</td></tr>';
    $('grid').innerHTML = html + '</tbody>';
  }

  function sideName(p) { return p === 'ours' ? '내 값' : p === 'theirs' ? '상대 값' : p === 'base' ? '원본' : '직접 입력'; }

  function renderConflicts() {
    var e = cur(), r = e.result, c = e.raw.commits || {};
    var left = unresolved(e);
    $('leftCount').textContent = r.conflicts.length ? left + ' / ' + r.conflicts.length : '';
    if (!r.conflicts.length) {
      $('conflictList').innerHTML = '<div class="empty">겹치는 변경이 없어서 전부 자동으로 합쳤어요. 저장만 누르면 돼요.</div>';
      return;
    }
    $('conflictList').innerHTML = r.conflicts.map(function (cf) {
      var pick = e.choices[cf.id];
      var isCustom = pick && typeof pick === 'object';
      if (cf.kind === 'row') {
        var oursDeleted = !cf.ours;
        return '<div class="card' + (pick ? ' done' : '') + '" id="card-' + cf.id + '">' +
          '<div class="where" data-goto="' + cf.id + '">' + esc(cf.row) + ' <span class="muted">(행 전체)</span></div>' +
          '<div class="why">' + (oursDeleted ? '내가 이 행을 지웠는데 상대가 고쳤어요.' : '상대가 이 행을 지웠는데 내가 고쳤어요.') + '</div>' +
          '<div class="opts">' +
            opt(cf.id, 'ours', '내 쪽', oursDeleted ? '행 삭제' : rowPreview(cf.ours), commitText(c.ours), pick === 'ours') +
            opt(cf.id, 'theirs', '상대 쪽', oursDeleted ? rowPreview(cf.theirs) : '행 삭제', commitText(c.theirs), pick === 'theirs') +
          '</div></div>';
      }
      return '<div class="card' + (pick ? ' done' : '') + '" id="card-' + cf.id + '">' +
        '<div class="where" data-goto="' + cf.id + '">' + esc(cf.row) + ' · ' + esc(cf.column) + '</div>' +
        '<div class="why">양쪽이 같은 칸을 서로 다르게 바꿨어요.</div>' +
        '<div class="opts">' +
          opt(cf.id, 'ours', '내 값', show(cf.ours), commitText(c.ours), pick === 'ours', true) +
          opt(cf.id, 'theirs', '상대 값', show(cf.theirs), commitText(c.theirs), pick === 'theirs', true) +
          opt(cf.id, 'base', '원본', show(cf.base), '', pick === 'base', true) +
        '</div>' +
        '<div class="custom"><input data-custom-input="' + cf.id + '" placeholder="직접 입력" value="' + (isCustom ? esc(typeof pick.custom === 'string' ? pick.custom : JSON.stringify(pick.custom)) : '') + '">' +
        '<button class="btn small" data-custom="' + cf.id + '">적용</button></div>' +
        '</div>';
    }).join('');
  }

  function rowPreview(cells) {
    if (!cells) return '행 삭제';
    return esc(Object.keys(cells).filter(function (k) { return cells[k] !== undefined; }).map(function (k) {
      var v = cells[k]; return k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v);
    }).join(', '));
  }

  function opt(id, side, label, valHtml, meta, selected, isHtml) {
    return '<button class="opt ' + side + (selected ? ' selected' : '') + '" data-pick="' + id + '" data-side="' + side + '">' +
      '<span class="lab">' + esc(label) + '</span><span class="val">' + valHtml + '</span>' +
      (meta ? '<span class="meta">' + esc(meta) + '</span>' : '') + '</button>';
  }

  // Custom input: keep the type of the existing values (number stays number).
  function parseCustom(text, cf) {
    var sample = cf.ours !== undefined ? cf.ours : cf.theirs;
    if (typeof sample === 'number' && text.trim() !== '' && !isNaN(Number(text))) return Number(text);
    if (typeof sample === 'boolean' && /^(true|false)$/i.test(text.trim())) return text.trim().toLowerCase() === 'true';
    if (sample && typeof sample === 'object') { try { return JSON.parse(text); } catch (e) { /* keep string */ } }
    return text;
  }

  function choose(id, value) {
    var e = cur();
    e.choices[id] = value;
    e.saved = false;
    renderSummary(); renderGrid(); renderConflicts(); renderFileList(); updateSave();
    // Move focus to the next open conflict so a reviewer can go top to bottom.
    var next = e.result.conflicts.filter(function (c) { return !e.choices[c.id]; })[0];
    if (next) focusCard(next.id, false);
  }

  function focusCard(id, flashCell) {
    document.querySelectorAll('.card.focus').forEach(function (n) { n.classList.remove('focus'); });
    var card = $('card-' + id);
    if (card) { card.classList.add('focus'); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    if (flashCell) {
      var td = document.querySelector('td[data-conflict="' + id + '"]');
      if (td) { td.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); td.classList.remove('flash'); void td.offsetWidth; td.classList.add('flash'); }
    }
  }

  function updateSave() {
    var e = cur(), btn = $('save'), hint = $('saveHint');
    if (e.error) { btn.disabled = true; hint.textContent = ''; return; }
    var left = unresolved(e);
    btn.disabled = left > 0 || e.saved;
    btn.textContent = state.demo ? '병합 결과 미리보기' : (e.saved ? '저장됨 ✓' : '저장하고 git add');
    hint.textContent = left ? '확인할 곳 ' + left + '곳을 모두 고르면 저장할 수 있어요.'
      : e.saved ? '저장하고 git add까지 끝냈어요.'
      : state.demo ? '데모라서 파일은 안 쓰고 결과만 보여줘요.'
      : '결과를 ' + e.raw.path + '에 쓰고 git add 해요.';
  }

  function save() {
    var e = cur();
    var table = M.applyResolutions(e.result, e.choices);
    var content = F.write(table, e.style);
    if (state.demo) {
      var w = window.open('', '_blank');
      if (w) { w.document.write('<pre style="font:13px Consolas,monospace;white-space:pre-wrap">' + esc(content) + '</pre>'); }
      else { banner('<pre>' + esc(content) + '</pre>', 'info'); }
      return;
    }
    $('save').disabled = true;
    // Pilot metrics (사업계획서 1분기 지표): how long it took and how much was automatic.
    var st = e.result.stats, choices = Object.keys(e.choices).map(function (k) { return e.choices[k]; });
    var metrics = {
      seconds: Math.round((Date.now() - state.openedAt) / 1000),
      autoCells: st.autoCells, addedRows: st.addedOurs + st.addedTheirs, deletedRows: st.deleted,
      conflicts: e.result.conflicts.length,
      picked: {
        ours: choices.filter(function (c) { return c === 'ours'; }).length,
        theirs: choices.filter(function (c) { return c === 'theirs'; }).length,
        base: choices.filter(function (c) { return c === 'base'; }).length,
        custom: choices.filter(function (c) { return typeof c === 'object'; }).length
      }
    };
    fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: e.raw.path, content: content, metrics: metrics }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || '저장 실패');
        e.saved = true;
        renderFileList(); updateSave();
        var remaining = state.files.filter(function (f) { return !f.saved; }).length;
        banner(remaining ? esc(e.raw.path) + ' 저장 완료. 남은 파일 ' + remaining + '개.'
          : '모든 파일 저장 완료. <b>완료</b>를 누르고 터미널에서 <code>git commit</code> 하면 머지가 끝나요.');
        var nextIdx = state.files.findIndex(function (f) { return !f.saved && !f.error; });
        if (nextIdx >= 0 && nextIdx !== state.current) select(nextIdx);
      })
      .catch(function (err) { banner('저장 실패: ' + esc(err.message), 'info'); updateSave(); });
  }

  // ---------- events ----------
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-file],[data-pick],[data-custom],[data-goto],[data-conflict],[data-bulk]');
    if (!t) return;
    if (t.dataset.file !== undefined) return select(Number(t.dataset.file));
    if (t.dataset.pick) return choose(t.dataset.pick, t.dataset.side);
    if (t.dataset.custom) {
      var id = t.dataset.custom, input = document.querySelector('[data-custom-input="' + id + '"]');
      var cf = cur().result.conflicts.filter(function (c) { return c.id === id; })[0];
      return choose(id, { custom: parseCustom(input.value, cf) });
    }
    if (t.dataset.goto) return focusCard(t.dataset.goto, true);
    if (t.dataset.conflict) return focusCard(t.dataset.conflict, false);
    if (t.dataset.bulk) {
      var e = cur();
      e.result.conflicts.forEach(function (c) { if (!e.choices[c.id]) e.choices[c.id] = t.dataset.bulk; });
      e.saved = false;
      renderSummary(); renderGrid(); renderConflicts(); renderFileList(); updateSave();
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.matches('[data-custom-input]')) {
      document.querySelector('[data-custom="' + ev.target.dataset.customInput + '"]').click();
    }
  });
  $('onlyChanged').addEventListener('change', renderGrid);
  $('save').addEventListener('click', save);
  $('quit').addEventListener('click', function () {
    if (state.demo) { banner('데모 모드에서는 닫을 서버가 없어요.', 'info'); return; }
    fetch('/api/quit', { method: 'POST' }).finally(function () {
      document.body.innerHTML = '<div style="padding:40px;font-size:15px">병합 화면을 닫았어요. 터미널로 돌아가서 <code>git status</code>로 확인하고 <code>git commit</code> 하세요.</div>';
    });
  });

  load();
})();

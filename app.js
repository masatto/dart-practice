'use strict';

/* ============================================================
   STORAGE
   ============================================================ */
const Storage = (() => {
  const KEY = 'darts_records_v1';

  function getAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveAll(records) {
    localStorage.setItem(KEY, JSON.stringify(records));
  }

  function add(record) {
    const records = getAll();
    records.unshift(record);
    saveAll(records);
  }

  function update(id, data) {
    const records = getAll();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return false;
    records[idx] = { ...records[idx], ...data, updatedAt: new Date().toISOString() };
    saveAll(records);
    return true;
  }

  function remove(id) {
    saveAll(getAll().filter(r => r.id !== id));
  }

  function getById(id) {
    return getAll().find(r => r.id === id) || null;
  }

  // 同一日付の重複レコードを1件にマージして保存する。マージが発生した場合 true を返す
  function deduplicate() {
    const records = getAll();
    const byDate = {};
    records.forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });

    let changed = false;
    const result = [];

    Object.keys(byDate).sort().reverse().forEach(date => {
      const recs = byDate[date];
      if (recs.length === 1) { result.push(recs[0]); return; }

      changed = true;

      // COUNT-UP: 全ゲームを結合
      const allCuGames = recs.flatMap(r => r.countUp?.games || []);

      // 01: 全ゲームを結合
      const allZo = recs.flatMap(r => r.zeroOne || []);

      // クリケット: 各ナンバーの最後に記録された値を採用
      const cpList = recs.map(r => r.cricketPractice).filter(Boolean);
      let mergedCp = null;
      if (cpList.length) {
        mergedCp = {};
        CRICKET_NUMS.forEach(n => {
          const vals = cpList.map(cp => cp[n]).filter(v => v != null);
          if (vals.length) mergedCp[n] = vals[vals.length - 1];
        });
        if (!Object.keys(mergedCp).length) mergedCp = null;
      }

      // 練習時間: 合算
      const totalMin = recs.reduce((s, r) => s + (Number(r.practiceMinutes) || 0), 0);

      // メモ: 空でないものを結合
      const memos = recs.map(r => r.memo).filter(Boolean);

      const merged = {
        ...recs[0],
        countUp:         allCuGames.length ? { games: allCuGames } : null,
        zeroOne:         allZo.length ? allZo : null,
        cricketPractice: mergedCp,
        practiceMinutes: totalMin,
        memo:            memos.join(' / '),
        updatedAt:       new Date().toISOString(),
      };
      result.push(merged);
    });

    if (changed) saveAll(result);
    return changed;
  }

  return { getAll, add, update, remove, getById, deduplicate };
})();

/* ============================================================
   UTILS
   ============================================================ */
const Utils = {
  genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  formatDate(s) {
    if (!s) return '-';
    const d = new Date(s + 'T00:00:00');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  },

  formatDateShort(s) {
    if (!s) return '-';
    const d = new Date(s + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },

  formatMonthLabel(ym) {
    const [y, m] = ym.split('-');
    return `${y}年${parseInt(m)}月`;
  },

  formatMinutes(min) {
    if (!min) return '-';
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return `${m}分`;
    return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  },

  yearMonth(date) {
    return date ? date.slice(0, 7) : '';
  },

  currentYM() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  },

  prevYM(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  },

  nextYM(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  },

  avg(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  },

  fixed1(n) {
    return n === null || n === undefined ? null : Math.round(n * 10) / 10;
  },

  esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};

function pad(n) { return String(n).padStart(2, '0'); }

/* ============================================================
   CALCULATIONS
   ============================================================ */
const CRICKET_NUMS = ['20', '19', '18', '17', '16', '15', 'Bull'];

const Calc = {
  cuDarts(games) {
    return (games || []).length * 24;
  },

  cuBest(games) {
    if (!games || !games.length) return null;
    return Math.max(...games.map(g => Number(g.score) || 0));
  },

  cuAvg(games) {
    if (!games || !games.length) return null;
    return Utils.avg(games.map(g => Number(g.score) || 0));
  },

  zoDarts(games) {
    return (games || []).reduce((s, g) => s + (Number(g.darts) || 0), 0);
  },

  cricketDarts(cp) {
    if (!cp) return 0;
    return Object.values(cp).reduce((s, v) => s + (Number(v) || 0), 0);
  },

  totalDarts(r) {
    return this.cuDarts(r.countUp?.games) + this.zoDarts(r.zeroOne) + this.cricketDarts(r.cricketPractice);
  },

  // Average throws per number across a set of records
  cricketAverages(records) {
    const sums = {}, counts = {};
    CRICKET_NUMS.forEach(n => { sums[n] = 0; counts[n] = 0; });
    records.forEach(r => {
      if (!r.cricketPractice) return;
      CRICKET_NUMS.forEach(n => {
        const v = Number(r.cricketPractice[n]);
        if (v > 0) { sums[n] += v; counts[n]++; }
      });
    });
    const out = {};
    CRICKET_NUMS.forEach(n => {
      out[n] = counts[n] > 0 ? sums[n] / counts[n] : null;
    });
    return out;
  },

  // Best (minimum) throws per number across records
  cricketBests(records) {
    const bests = {};
    CRICKET_NUMS.forEach(n => { bests[n] = null; });
    records.forEach(r => {
      if (!r.cricketPractice) return;
      CRICKET_NUMS.forEach(n => {
        const v = Number(r.cricketPractice[n]);
        if (v > 0 && (bests[n] === null || v < bests[n])) bests[n] = v;
      });
    });
    return bests;
  },

  // Filter by last N days (null = all)
  filterDays(records, days) {
    if (days === null) return records;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    return records.filter(r => r.date >= cutoffStr);
  },

  // Monthly stats object
  monthlyStats(records, ym) {
    const filtered = records.filter(r => Utils.yearMonth(r.date) === ym);
    if (!filtered.length) return null;

    const days = new Set(filtered.map(r => r.date)).size;
    const totalMinutes = filtered.reduce((s, r) => s + (Number(r.practiceMinutes) || 0), 0);
    const totalDarts = filtered.reduce((s, r) => s + this.totalDarts(r), 0);

    const allCuScores = filtered.flatMap(r => (r.countUp?.games || []).map(g => Number(g.score) || 0));
    const cuBest = allCuScores.length ? Math.max(...allCuScores) : null;
    const cuAvg  = allCuScores.length ? Utils.avg(allCuScores) : null;

    const zoStats = {};
    ['301', '501', '701'].forEach(type => {
      const games = filtered.flatMap(r => (r.zeroOne || []).filter(g => g.type === type));
      zoStats[type] = {
        minDarts: games.length ? Math.min(...games.map(g => Number(g.darts))) : null,
        avgAvg:   games.length ? Utils.avg(games.map(g => Number(g.average))) : null,
      };
    });

    return {
      ym, days, totalMinutes, totalDarts,
      cuBest, cuAvg,
      zoStats,
      cricketAvg: this.cricketAverages(filtered),
      memos: filtered.filter(r => r.memo).map(r => ({ date: r.date, memo: r.memo })),
    };
  },

  // All-time personal bests
  allBests(records) {
    const cuScores = records.flatMap(r => (r.countUp?.games || []).map(g => Number(g.score) || 0));
    const cuSessionAvgs = records.map(r => this.cuAvg(r.countUp?.games)).filter(v => v !== null);

    const zoBests = {}, zoAvgBests = {};
    ['301', '501', '701'].forEach(type => {
      const games = records.flatMap(r => (r.zeroOne || []).filter(g => g.type === type));
      zoBests[type]    = games.length ? Math.min(...games.map(g => Number(g.darts)))   : null;
      zoAvgBests[type] = games.length ? Math.max(...games.map(g => Number(g.average))) : null;
    });

    // Monthly aggregates for monthly bests
    const months = [...new Set(records.map(r => Utils.yearMonth(r.date)).filter(Boolean))];
    const mDays    = months.map(m => new Set(records.filter(r => Utils.yearMonth(r.date) === m).map(r => r.date)).size);
    const mDarts   = months.map(m => records.filter(r => Utils.yearMonth(r.date) === m).reduce((s, r) => s + this.totalDarts(r), 0));
    const mMinutes = months.map(m => records.filter(r => Utils.yearMonth(r.date) === m).reduce((s, r) => s + (Number(r.practiceMinutes) || 0), 0));

    return {
      cuBest:       cuScores.length    ? Math.max(...cuScores) : null,
      cuAvgBest:    cuSessionAvgs.length ? Math.max(...cuSessionAvgs) : null,
      zoBests,
      zoAvgBests,
      cricketBests: this.cricketBests(records),
      mBestDays:    mDays.length    ? Math.max(...mDays)    : null,
      mBestDarts:   mDarts.length   ? Math.max(...mDarts)   : null,
      mBestMinutes: mMinutes.length ? Math.max(...mMinutes) : null,
    };
  },
};

/* ============================================================
   APP STATE
   ============================================================ */
const State = {
  screen:       'home',
  editId:       null,
  rankPeriod:   '30',
  monthlyYM:    Utils.currentYM(),
  prevBests:    null,
  submitting:   false,
};

/* ============================================================
   NAVIGATION
   ============================================================ */

// 記録画面へ遷移する。当日の記録が既にある場合は編集モードへ誘導する
function goToRecord() {
  const existing = Storage.getAll().find(r => r.date === Utils.today());
  if (existing) {
    showToast('本日の記録があります。編集モードで開きます');
    navigate('record', { editId: existing.id });
  } else {
    navigate('record');
  }
}

function navigate(screen, opts = {}) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

  const screenEl = document.getElementById(`screen-${screen}`);
  if (!screenEl) return;
  screenEl.classList.add('active');

  const navBtn = document.querySelector(`.nav-btn[data-screen="${screen}"]`);
  if (navBtn) navBtn.classList.add('active');

  State.screen = screen;

  switch (screen) {
    case 'home':     renderHome();                    break;
    case 'record':   initRecordForm(opts.editId || null); break;
    case 'history':  renderHistory();                 break;
    case 'best':     renderBest();                    break;
    case 'ranking':  renderRanking();                 break;
    case 'monthly':  renderMonthly();                 break;
  }
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer = null;
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type === 'error' ? ' error' : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

/* ============================================================
   CELEBRATION
   ============================================================ */
function showCelebration(details) {
  const el = document.getElementById('celebration');
  document.getElementById('cel-detail').textContent = details.join('　/　');
  el.classList.remove('hidden');
}

/* ============================================================
   HOME SCREEN
   ============================================================ */
function renderHome() {
  const records = Storage.getAll();
  const ym = Utils.currentYM();
  const thisMonth = records.filter(r => Utils.yearMonth(r.date) === ym);

  const days    = new Set(thisMonth.map(r => r.date)).size;
  const minutes = thisMonth.reduce((s, r) => s + (Number(r.practiceMinutes) || 0), 0);
  const darts   = thisMonth.reduce((s, r) => s + Calc.totalDarts(r), 0);
  const lastRec = records[0];

  const allCuBest = (() => {
    const s = records.flatMap(r => (r.countUp?.games || []).map(g => Number(g.score) || 0));
    return s.length ? Math.max(...s) : null;
  })();

  const best501 = (() => {
    const g = records.flatMap(r => (r.zeroOne || []).filter(z => z.type === '501').map(z => Number(z.darts)));
    return g.length ? Math.min(...g) : null;
  })();

  const cricketAvg = Calc.cricketAverages(thisMonth);
  const weakTop3 = CRICKET_NUMS
    .filter(n => cricketAvg[n] !== null)
    .sort((a, b) => cricketAvg[b] - cricketAvg[a])
    .slice(0, 3);

  const now = new Date();
  const dateLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${['日','月','火','水','木','金','土'][now.getDay()]}）`;

  const el = document.getElementById('home-content');
  el.innerHTML = `
    <div class="home-hero">
      <div class="hero-date">${dateLabel}</div>
      <div class="hero-greeting">今日も練習しましょう！</div>
      <button class="btn-record-today" id="btn-today">今日の練習を記録する</button>
    </div>

    <div class="section-heading">今月の記録</div>
    <div class="card-grid">
      <div class="stat-card">
        <div class="stat-label">練習日数</div>
        <div class="stat-value">${days}<span class="stat-unit">日</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">練習時間</div>
        <div class="stat-value">${minutes}<span class="stat-unit">分</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">総投擲数</div>
        <div class="stat-value">${darts.toLocaleString()}<span class="stat-unit">投</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">直近の練習</div>
        <div class="stat-value" style="font-size:20px">${lastRec ? Utils.formatDateShort(lastRec.date) : '-'}</div>
      </div>
    </div>

    <div class="section-heading">自己ベスト</div>
    <div class="card-grid">
      <div class="stat-card">
        <div class="stat-label">COUNT-UP 最高</div>
        <div class="stat-value">${allCuBest !== null ? allCuBest : '-'}<span class="stat-unit">${allCuBest !== null ? 'pts' : ''}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">501 最少投数</div>
        <div class="stat-value">${best501 !== null ? best501 : '-'}<span class="stat-unit">${best501 !== null ? '投' : ''}</span></div>
      </div>
    </div>

    <div class="section-heading">今月の苦手ナンバー TOP3</div>
    <div class="card">
      ${weakTop3.length === 0
        ? '<div class="empty-state" style="padding:24px"><div class="empty-icon">🎯</div><p>データがまだありません</p></div>'
        : weakTop3.map((n, i) => `
            <div class="rank-row">
              <div class="rank-num r${i+1}">${i+1}位</div>
              <div class="rank-name">${n}</div>
              <div class="rank-score">平均 ${cricketAvg[n].toFixed(1)}投</div>
            </div>`).join('')}
    </div>

    <div class="section-heading">今月の簡易レポート</div>
    <div class="card">${renderHomeReport(records, ym)}</div>
  `;

  document.getElementById('btn-today').addEventListener('click', () => goToRecord());
}

function renderHomeReport(records, ym) {
  const stats = Calc.monthlyStats(records, ym);
  if (!stats) return '<p style="color:var(--text-muted);font-size:14px">今月の記録はまだありません</p>';

  const prevYM = Utils.prevYM(ym);
  const prev   = Calc.monthlyStats(records, prevYM);

  const row = (label, cur, prevVal, unit = '', fixed = 0, lowerBetter = false) => {
    if (cur === null || cur === undefined) return '';
    const fmt = v => v === null ? '-' : (fixed ? Number(v).toFixed(fixed) : v) + unit;
    let cmpHtml = '';
    if (prevVal !== null && prevVal !== undefined) {
      const diff = cur - prevVal;
      const better = lowerBetter ? diff < 0 : diff > 0;
      const sign = diff >= 0 ? '+' : '';
      const cls = diff === 0 ? 'cmp-neu' : (better ? 'cmp-pos' : 'cmp-neg');
      const diffFmt = fixed ? Math.abs(diff).toFixed(fixed) : Math.abs(diff);
      cmpHtml = ` <span class="${cls}">(前月 ${diff >= 0 ? '+' : '-'}${diffFmt}${unit})</span>`;
    }
    return `<div class="detail-row"><span class="d-label">${label}</span><span class="d-value">${fmt(cur)}${cmpHtml}</span></div>`;
  };

  return `
    ${row('練習日数',   stats.days,         prev?.days,         '日')}
    ${row('総投擲数',   stats.totalDarts,   prev?.totalDarts,   '投')}
    ${row('COUNT-UP最高', stats.cuBest,    prev?.cuBest,        'pts')}
    ${row('501最少投数', stats.zoStats['501'].minDarts, prev?.zoStats['501']?.minDarts, '投', 0, true)}
  `;
}

/* ============================================================
   RECORD FORM
   ============================================================ */
function initRecordForm(editId) {
  State.editId = editId;

  document.getElementById('record-title').textContent = editId ? '練習記録を編集' : '練習を記録する';
  document.getElementById('f-date').value = Utils.today();
  document.getElementById('f-minutes').value = '';
  document.getElementById('f-memo').value = '';

  // Clear game rows
  document.getElementById('countup-games').innerHTML = '';
  document.getElementById('zeroone-games').innerHTML = '';

  // Render cricket inputs
  buildCricketInputs();

  // Reset calcs
  updateCuCalc();
  updateZoCalc();
  updateCricketCalc();
  updateTotalCalc();

  if (editId) {
    const r = Storage.getById(editId);
    if (r) {
      document.getElementById('f-date').value    = r.date;
      document.getElementById('f-minutes').value = r.practiceMinutes || '';
      document.getElementById('f-memo').value    = r.memo || '';

      (r.countUp?.games || []).forEach(g => addCuGame(g.score));
      (r.zeroOne || []).forEach(g => addZoGame(g.type, g.average, g.darts));

      const cp = r.cricketPractice || {};
      CRICKET_NUMS.forEach(n => {
        const inp = document.getElementById(`ci-${n}`);
        if (inp && cp[n]) inp.value = cp[n];
      });

      updateCuCalc();
      updateZoCalc();
      updateCricketCalc();
      updateTotalCalc();
    }
  }
}

function buildCricketInputs() {
  const c = document.getElementById('cricket-inputs');
  c.innerHTML = CRICKET_NUMS.map(n => `
    <div class="cricket-item">
      <label for="ci-${n}">${n}</label>
      <input type="number" id="ci-${n}" min="1" max="99" placeholder="-"
             inputmode="numeric"
             oninput="updateCricketCalc(); updateTotalCalc()">
    </div>`).join('');
}

/* --- COUNT-UP --- */
function addCuGame(scoreVal = '') {
  const rows  = document.querySelectorAll('#countup-games .game-row');
  const num   = rows.length + 1;
  const id    = `cu-${Utils.genId()}`;

  const row = document.createElement('div');
  row.className = 'game-row';
  row.id = id;
  row.innerHTML = `
    <span class="game-num">${num}</span>
    <input type="number" class="input-score" min="0" max="1200" placeholder="スコア"
           value="${Utils.esc(String(scoreVal || ''))}"
           inputmode="numeric"
           oninput="updateCuCalc(); updateTotalCalc()">
    <button type="button" class="btn-remove" onclick="removeCuGame('${id}')">✕</button>
  `;
  document.getElementById('countup-games').appendChild(row);
  updateCuCalc();
}

function removeCuGame(id) {
  const row = document.getElementById(id);
  if (row) row.remove();
  renumberRows('countup-games');
  updateCuCalc();
  updateTotalCalc();
}

function getCuGames() {
  return Array.from(document.querySelectorAll('#countup-games .game-row')).map(row => {
    const v = Number(row.querySelector('input').value);
    return { score: v };
  }).filter(g => g.score > 0);
}

function updateCuCalc() {
  const games = getCuGames();
  const el    = document.getElementById('countup-calc');
  if (!games.length) {
    el.innerHTML = '<span class="calc-placeholder">ゲームを追加してください</span>';
    return;
  }
  const totalDarts = games.length * 24;
  const best = Math.max(...games.map(g => g.score));
  const avg  = Utils.avg(games.map(g => g.score));
  el.innerHTML = `
    ゲーム数: <span class="calc-value">${games.length}回</span>
    投擲数: <span class="calc-value">${totalDarts}投</span><br>
    最高: <span class="calc-value">${best}pts</span>
    平均: <span class="calc-value">${avg !== null ? avg.toFixed(1) : '-'}pts</span>
  `;
}

/* --- 01 --- */
function addZoGame(type = '501', avg = '', darts = '') {
  const rows = document.querySelectorAll('#zeroone-games .game-row');
  const num  = rows.length + 1;
  const id   = `zo-${Utils.genId()}`;

  const makeOption = (v, label) => `<option value="${v}" ${type === v ? 'selected' : ''}>${label}</option>`;

  const row = document.createElement('div');
  row.className = 'game-row';
  row.id = id;
  row.innerHTML = `
    <span class="game-num">${num}</span>
    <select class="input-type" onchange="updateZoCalc()">
      ${makeOption('301','301')}
      ${makeOption('501','501')}
      ${makeOption('701','701')}
    </select>
    <span class="input-label">AVG</span>
    <input type="number" class="input-avg" min="0" max="300" step="0.1"
           placeholder="0.0" value="${Utils.esc(String(avg || ''))}"
           inputmode="decimal"
           oninput="updateZoCalc()">
    <span class="input-label">投</span>
    <input type="number" class="input-darts" min="1" max="999"
           placeholder="0" value="${Utils.esc(String(darts || ''))}"
           inputmode="numeric"
           oninput="updateZoCalc(); updateTotalCalc()">
    <button type="button" class="btn-remove" onclick="removeZoGame('${id}')">✕</button>
  `;
  document.getElementById('zeroone-games').appendChild(row);
  updateZoCalc();
}

function removeZoGame(id) {
  const row = document.getElementById(id);
  if (row) row.remove();
  renumberRows('zeroone-games');
  updateZoCalc();
  updateTotalCalc();
}

function getZoGames() {
  return Array.from(document.querySelectorAll('#zeroone-games .game-row')).map(row => ({
    type:    row.querySelector('.input-type').value,
    average: Number(row.querySelector('.input-avg').value) || 0,
    darts:   Number(row.querySelector('.input-darts').value) || 0,
  })).filter(g => g.darts > 0);
}

function updateZoCalc() {
  const games = getZoGames();
  const el    = document.getElementById('zeroone-calc');
  if (!games.length) {
    el.innerHTML = '<span class="calc-placeholder">ゲームを追加してください</span>';
    return;
  }
  const total = Calc.zoDarts(games);
  el.innerHTML = `
    ゲーム数: <span class="calc-value">${games.length}回</span>
    合計投擲数: <span class="calc-value">${total}投</span>
  `;
}

/* --- CRICKET --- */
function getCricketPractice() {
  const out = {};
  CRICKET_NUMS.forEach(n => {
    const v = Number(document.getElementById(`ci-${n}`)?.value);
    if (v > 0) out[n] = v;
  });
  return Object.keys(out).length ? out : null;
}

function updateCricketCalc() {
  const cp = getCricketPractice();
  const el = document.getElementById('cricket-calc');
  if (!cp) {
    el.innerHTML = '<span class="calc-placeholder">ナンバーを入力してください</span>';
    return;
  }
  const total = Object.values(cp).reduce((s, v) => s + v, 0);
  const count = Object.keys(cp).length;
  el.innerHTML = `
    入力ナンバー: <span class="calc-value">${count}種</span>
    投擲数: <span class="calc-value">${total}投</span>
  `;
}

/* --- TOTAL --- */
function updateTotalCalc() {
  const cuDarts = getCuGames().length * 24;
  const zoDarts = Calc.zoDarts(getZoGames());
  const cpDarts = Calc.cricketDarts(getCricketPractice());
  const total   = cuDarts + zoDarts + cpDarts;

  document.querySelector('.total-darts').innerHTML = `${total.toLocaleString()}<span class="total-unit"> 投</span>`;
  document.getElementById('bd-countup').textContent = cuDarts;
  document.getElementById('bd-zeroone').textContent = zoDarts;
  document.getElementById('bd-cricket').textContent = cpDarts;
}

function renumberRows(containerId) {
  document.querySelectorAll(`#${containerId} .game-row`).forEach((row, i) => {
    row.querySelector('.game-num').textContent = i + 1;
  });
}

/* ============================================================
   FORM SUBMIT
   ============================================================ */
function handleFormSubmit(e) {
  e.preventDefault();
  if (State.submitting) return;

  const date = document.getElementById('f-date').value;
  if (!date) { showToast('練習日を入力してください', 'error'); return; }

  const practiceMinutes = Number(document.getElementById('f-minutes').value) || 0;
  const memo = document.getElementById('f-memo').value.trim();
  const cuGames = getCuGames();
  const zoGames = getZoGames();
  const cp      = getCricketPractice();

  if (!cuGames.length && !zoGames.length && !cp && !practiceMinutes && !memo) {
    showToast('何か入力してください', 'error');
    return;
  }

  State.submitting = true;
  const now = new Date().toISOString();

  // Snapshot bests before save
  const allBefore = Calc.allBests(Storage.getAll().filter(r => r.id !== State.editId));

  const record = {
    id: State.editId || Utils.genId(),
    date,
    practiceMinutes,
    memo,
    countUp:         cuGames.length ? { games: cuGames } : null,
    zeroOne:         zoGames.length ? zoGames : null,
    cricketPractice: cp,
    createdAt:       State.editId ? (Storage.getById(State.editId)?.createdAt || now) : now,
    updatedAt:       now,
  };

  if (State.editId) {
    Storage.update(State.editId, record);
  } else {
    Storage.add(record);
  }

  // Check PBs after save
  const allAfter = Calc.allBests(Storage.getAll());
  const pbs = detectPBs(allBefore, allAfter);

  showToast(State.editId ? '記録を更新しました ✓' : '記録を保存しました！ ✓');

  if (pbs.length) {
    setTimeout(() => showCelebration(pbs), 600);
  }

  State.editId    = null;
  State.submitting = false;
  navigate('home');
}

function detectPBs(before, after) {
  const pbs = [];

  if (after.cuBest !== null && (before.cuBest === null || after.cuBest > before.cuBest)) {
    pbs.push(`COUNT-UP最高: ${after.cuBest}pts`);
  }

  ['301', '501', '701'].forEach(t => {
    const n = after.zoBests[t], o = before.zoBests[t];
    if (n !== null && (o === null || n < o)) pbs.push(`${t}最少: ${n}投`);
  });

  CRICKET_NUMS.forEach(n => {
    const nv = after.cricketBests[n], ov = before.cricketBests[n];
    if (nv !== null && (ov === null || nv < ov)) pbs.push(`${n}最少: ${nv}投`);
  });

  return pbs;
}

/* ============================================================
   HISTORY SCREEN
   ============================================================ */
function renderHistory() {
  const records = Storage.getAll();
  const el = document.getElementById('history-content');

  if (!records.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📝</div><p>練習記録がまだありません<br>ホームから記録を追加してください</p></div>`;
    return;
  }

  // Group by year-month
  const groups = {};
  records.forEach(r => {
    const k = Utils.yearMonth(r.date);
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  });

  let html = '';
  Object.keys(groups).sort().reverse().forEach(ym => {
    html += `<div class="history-month-header">${Utils.formatMonthLabel(ym)}</div>`;
    groups[ym].forEach(r => {
      const total   = Calc.totalDarts(r);
      const cuBest  = Calc.cuBest(r.countUp?.games);
      const zoMin   = r.zeroOne?.length ? Math.min(...r.zeroOne.map(g => Number(g.darts))) : null;

      const stats = [
        r.practiceMinutes ? `⏱ <strong>${Utils.formatMinutes(r.practiceMinutes)}</strong>` : '',
        total > 0         ? `🎯 <strong>${total.toLocaleString()}投</strong>` : '',
        cuBest !== null   ? `C-UP <strong>${cuBest}pts</strong>` : '',
        zoMin  !== null   ? `01 <strong>${zoMin}投</strong>` : '',
      ].filter(Boolean).join('　');

      html += `
        <div class="history-item" onclick="showDetail('${r.id}')">
          <div class="history-date">${Utils.formatDate(r.date)}</div>
          <div class="history-stats">${stats || '<span style="color:var(--text-muted)">記録なし</span>'}</div>
          ${r.memo ? `<div class="history-memo">💬 ${Utils.esc(r.memo)}</div>` : ''}
        </div>`;
    });
  });

  el.innerHTML = html;
}

/* ============================================================
   DETAIL MODAL
   ============================================================ */
let pendingDeleteId = null;

function showDetail(id) {
  const r = Storage.getById(id);
  if (!r) return;

  const total  = Calc.totalDarts(r);
  const cuGames = r.countUp?.games || [];

  let html = `<div class="detail-title">${Utils.formatDate(r.date)}</div>`;

  // Basic info
  html += `<div class="detail-section"><h3>基本情報</h3>`;
  html += detailRow('練習時間', Utils.formatMinutes(r.practiceMinutes));
  html += detailRow('総投擲数', `${total.toLocaleString()}投`);
  html += `</div>`;

  if (r.memo) {
    html += `<div class="memo-box">${Utils.esc(r.memo)}</div><br>`;
  }

  // COUNT-UP
  if (cuGames.length) {
    const best = Calc.cuBest(cuGames);
    const avg  = Calc.cuAvg(cuGames);
    html += `<div class="detail-section"><h3>COUNT-UP</h3>`;
    html += detailRow('ゲーム数',  `${cuGames.length}回`);
    html += detailRow('投擲数',    `${cuGames.length * 24}投`);
    html += detailRow('最高スコア', `${best}pts`);
    html += detailRow('平均スコア', `${avg !== null ? avg.toFixed(1) : '-'}pts`);
    html += `<div class="game-tags">`;
    cuGames.forEach((g, i) => {
      html += `<span class="game-tag">${i+1}G: <strong>${g.score}</strong>pts</span>`;
    });
    html += `</div></div>`;
  }

  // 01
  if (r.zeroOne?.length) {
    html += `<div class="detail-section"><h3>01ゲーム</h3>`;
    r.zeroOne.forEach((g, i) => {
      html += detailRow(`${i+1}G: ${g.type}`, `AVG ${g.average} / ${g.darts}投`);
    });
    html += detailRow('合計投擲数', `${Calc.zoDarts(r.zeroOne)}投`);
    html += `</div>`;
  }

  // Cricket
  if (r.cricketPractice) {
    const cp = r.cricketPractice;
    html += `<div class="detail-section"><h3>クリケットナンバー練習</h3>`;
    html += `<div class="detail-cricket">`;
    CRICKET_NUMS.forEach(n => {
      if (cp[n]) {
        html += `<div class="detail-cricket-item"><div class="dc-num">${n}</div><div class="dc-val">${cp[n]}</div></div>`;
      }
    });
    html += `</div>`;
    html += `<div style="margin-top:8px;font-size:14px;color:var(--text-secondary)">合計: <span style="color:var(--accent);font-weight:600">${Calc.cricketDarts(cp)}投</span></div>`;
    html += `</div>`;
  }

  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-edit').onclick = () => { closeModal(); navigate('record', { editId: id }); };
  document.getElementById('modal-delete').onclick = () => openConfirm(id);
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = closeModal;

  document.getElementById('modal').classList.remove('hidden');
}

function detailRow(label, value) {
  return `<div class="detail-row"><span class="d-label">${label}</span><span class="d-value">${value}</span></div>`;
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

function openConfirm(id) {
  pendingDeleteId = id;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeConfirm() {
  pendingDeleteId = null;
  document.getElementById('confirm-modal').classList.add('hidden');
}

/* ============================================================
   BEST RECORDS SCREEN
   ============================================================ */
function renderBest() {
  const records = Storage.getAll();
  const b = Calc.allBests(records);
  const el = document.getElementById('best-content');

  const val = (v, unit = '', fixed = 0) => {
    if (v === null || v === undefined) return `<span class="best-val no-data">-</span>`;
    const display = fixed > 0 ? Number(v).toFixed(fixed) : Number.isInteger(v) ? v : Number(v).toFixed(fixed);
    return `<span class="best-val">${display}${unit}</span>`;
  };

  el.innerHTML = `
    <div class="best-group">
      <h3>COUNT-UP</h3>
      ${bestItem('最高スコア', val(b.cuBest, 'pts'))}
      ${bestItem('平均スコア最高（1セッション）', val(b.cuAvgBest, 'pts', 1))}
    </div>

    <div class="best-group">
      <h3>01ゲーム — 最少投数</h3>
      ${['301','501','701'].map(t => bestItem(t, val(b.zoBests[t], '投'))).join('')}
    </div>

    <div class="best-group">
      <h3>01ゲーム — 最高AVG</h3>
      ${['301','501','701'].map(t => bestItem(t, val(b.zoAvgBests[t], '', 1))).join('')}
    </div>

    <div class="best-group">
      <h3>クリケット — 10カウント最少投数</h3>
      ${CRICKET_NUMS.map(n => bestItem(n, val(b.cricketBests[n], '投'))).join('')}
    </div>

    <div class="best-group">
      <h3>月間ベスト</h3>
      ${bestItem('最多練習日数', val(b.mBestDays, '日'))}
      ${bestItem('最多投擲数', b.mBestDarts !== null ? `<span class="best-val">${b.mBestDarts.toLocaleString()}投</span>` : `<span class="best-val no-data">-</span>`)}
      ${bestItem('最多練習時間', val(b.mBestMinutes, '分'))}
    </div>
  `;
}

function bestItem(label, valueHtml) {
  return `<div class="best-item"><span class="best-label">${label}</span>${valueHtml}</div>`;
}

/* ============================================================
   RANKING SCREEN
   ============================================================ */
function renderRanking() {
  const el = document.getElementById('ranking-content');
  el.innerHTML = `
    <div class="period-tabs">
      <button class="period-tab ${State.rankPeriod === '7'   ? 'active' : ''}" onclick="setRankPeriod('7')">過去7日</button>
      <button class="period-tab ${State.rankPeriod === '30'  ? 'active' : ''}" onclick="setRankPeriod('30')">過去30日</button>
      <button class="period-tab ${State.rankPeriod === 'all' ? 'active' : ''}" onclick="setRankPeriod('all')">全期間</button>
    </div>
    <div id="ranking-body">${renderRankingBody()}</div>
  `;
}

function setRankPeriod(p) {
  State.rankPeriod = p;
  document.getElementById('ranking-body').innerHTML = renderRankingBody();
  document.querySelectorAll('.period-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.includes(p === 'all' ? '全期間' : `過去${p}日`));
  });
}

function renderRankingBody() {
  const all    = Storage.getAll();
  const days   = State.rankPeriod === 'all' ? null : parseInt(State.rankPeriod);
  const recs   = Calc.filterDays(all, days);
  const avgs   = Calc.cricketAverages(recs);
  const hasData = CRICKET_NUMS.filter(n => avgs[n] !== null);

  if (!hasData.length) {
    return '<div class="empty-state"><div class="empty-icon">🎯</div><p>この期間のデータがありません</p></div>';
  }

  const worst  = [...hasData].sort((a, b) => avgs[b] - avgs[a]);
  const best   = [...hasData].sort((a, b) => avgs[a] - avgs[b]);

  const table = (title, arr) => `
    <div class="rank-table">
      <div class="rank-table-title">${title}</div>
      ${arr.map((n, i) => `
        <div class="rank-row">
          <div class="rank-num r${i+1}">${i+1}位</div>
          <div class="rank-name">${n}</div>
          <div class="rank-score">平均 ${avgs[n].toFixed(1)}投</div>
        </div>`).join('')}
    </div>`;

  return table('苦手ランキング — 投数が多い順', worst) +
         table('得意ランキング — 投数が少ない順', best);
}

/* ============================================================
   MONTHLY REPORT SCREEN
   ============================================================ */
function renderMonthly() {
  const ym = State.monthlyYM;
  const el = document.getElementById('monthly-content');
  const records = Storage.getAll();
  const stats   = Calc.monthlyStats(records, ym);
  const prev    = Calc.monthlyStats(records, Utils.prevYM(ym));

  const monthLabel = Utils.formatMonthLabel(ym);

  const cmp = (cur, prevVal, unit = '', fixed = 0, lowerBetter = false) => {
    if (cur === null || cur === undefined) return '<span style="color:var(--text-muted)">-</span>';
    const fmt = v => v === null ? '-' : (fixed ? Number(v).toFixed(fixed) : v) + unit;
    if (prevVal === null || prevVal === undefined) return `<span style="color:var(--accent)">${fmt(cur)}</span>`;
    const diff   = cur - prevVal;
    const better = lowerBetter ? diff < 0 : diff > 0;
    const sign   = diff >= 0 ? '+' : '';
    const cls    = diff === 0 ? 'cmp-neu' : (better ? 'cmp-pos' : 'cmp-neg');
    const dAbs   = Math.abs(diff);
    const dFmt   = fixed ? dAbs.toFixed(fixed) : dAbs;
    return `<span style="color:var(--text-primary)">${fmt(cur)}</span> <span class="${cls}">(前月 ${diff >= 0 ? '+' : '-'}${dFmt}${unit})</span>`;
  };

  let html = `
    <div class="month-nav">
      <button class="month-nav-btn" onclick="changeMonth(-1)">◀</button>
      <h2>${monthLabel}</h2>
      <button class="month-nav-btn" onclick="changeMonth(1)">▶</button>
    </div>`;

  if (!stats) {
    html += `<div class="empty-state"><div class="empty-icon">📅</div><p>この月の記録はありません</p></div>`;
    el.innerHTML = html;
    return;
  }

  // Cricket improvement
  const improvements = CRICKET_NUMS
    .filter(n => stats.cricketAvg[n] !== null && prev?.cricketAvg?.[n] !== null)
    .map(n => ({ n, diff: (prev.cricketAvg[n] || 0) - stats.cricketAvg[n] }))
    .sort((a, b) => b.diff - a.diff);
  const mostImproved = improvements.length && improvements[0].diff > 0 ? improvements[0] : null;
  const worstNum = CRICKET_NUMS.filter(n => stats.cricketAvg[n] !== null).sort((a, b) => stats.cricketAvg[b] - stats.cricketAvg[a])[0];

  html += `
    <div class="monthly-card">
      <h3>月間サマリー</h3>
      ${detailRow('練習日数',   cmp(stats.days,         prev?.days,         '日'))}
      ${detailRow('練習時間',   cmp(stats.totalMinutes, prev?.totalMinutes, '分'))}
      ${detailRow('総投擲数',   cmp(stats.totalDarts,   prev?.totalDarts,   '投'))}
      ${detailRow('COUNT-UP最高', cmp(stats.cuBest,     prev?.cuBest,       'pts'))}
      ${detailRow('COUNT-UP平均', cmp(stats.cuAvg,      prev?.cuAvg,        'pts', 1))}
    </div>

    <div class="monthly-card">
      <h3>01ゲーム</h3>
      ${['301','501','701'].map(type => `
        <div style="margin-bottom:8px">
          <div style="font-size:13px;color:var(--text-muted);font-weight:700;margin-bottom:2px">${type}</div>
          ${detailRow('最少投数', cmp(stats.zoStats[type].minDarts, prev?.zoStats[type]?.minDarts, '投', 0, true))}
          ${detailRow('平均AVG',  cmp(stats.zoStats[type].avgAvg,   prev?.zoStats[type]?.avgAvg,   '', 1))}
        </div>`).join('')}
    </div>

    <div class="monthly-card">
      <h3>クリケットナンバー別平均投数</h3>
      ${CRICKET_NUMS.map(n => stats.cricketAvg[n] !== null
        ? detailRow(n, cmp(stats.cricketAvg[n], prev?.cricketAvg?.[n], '投', 1, true))
        : ''
      ).join('')}
      ${mostImproved ? `<div class="highlight-box highlight-good">✨ 最も改善したナンバー: <strong>${mostImproved.n}</strong>（${mostImproved.diff.toFixed(1)}投改善）</div>` : ''}
      ${worstNum ? `<div class="highlight-box highlight-bad" style="margin-top:8px">⚠️ 最も苦手だったナンバー: <strong>${worstNum}</strong>（平均 ${stats.cricketAvg[worstNum].toFixed(1)}投）</div>` : ''}
    </div>
  `;

  if (stats.memos.length) {
    html += `<div class="monthly-card"><h3>メモ一覧</h3>`;
    stats.memos.forEach(m => {
      html += `
        <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)">
          <div style="font-size:12px;color:var(--accent);margin-bottom:4px;font-weight:600">${Utils.formatDate(m.date)}</div>
          <div style="font-size:14px;color:var(--text-secondary);line-height:1.6">${Utils.esc(m.memo)}</div>
        </div>`;
    });
    html += `</div>`;
  }

  el.innerHTML = html;
}

function changeMonth(delta) {
  State.monthlyYM = delta < 0 ? Utils.prevYM(State.monthlyYM) : Utils.nextYM(State.monthlyYM);
  renderMonthly();
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  // 起動時: 同一日付の重複レコードをマージ
  if (Storage.deduplicate()) {
    showToast('同じ日付の記録をまとめました');
  }

  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const screen = btn.dataset.screen;
      // 記録タブは当日重複チェックを挟む
      if (screen === 'record') {
        goToRecord();
      } else {
        navigate(screen);
      }
    });
  });

  // Record back button
  document.getElementById('record-back').addEventListener('click', () => {
    navigate(State.editId ? 'history' : 'home');
  });

  // Form — textarea以外でのEnterキーによる誤送信を防ぐ
  document.getElementById('practice-form').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
    }
  });
  document.getElementById('practice-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('add-countup-game').addEventListener('click', () => addCuGame());
  document.getElementById('add-zeroone-game').addEventListener('click', () => addZoGame());
  document.getElementById('cancel-record').addEventListener('click', () => {
    navigate(State.editId ? 'history' : 'home');
  });

  // Delete confirm
  document.getElementById('confirm-yes').addEventListener('click', () => {
    if (pendingDeleteId) {
      Storage.remove(pendingDeleteId);
      closeConfirm();
      closeModal();
      showToast('記録を削除しました');
      renderHistory();
    }
  });
  document.getElementById('confirm-no').addEventListener('click', closeConfirm);
  document.getElementById('confirm-overlay').addEventListener('click', closeConfirm);

  // Celebration dismiss
  document.getElementById('celebration').addEventListener('click', () => {
    document.getElementById('celebration').classList.add('hidden');
  });

  // Initial render
  navigate('home');
}

document.addEventListener('DOMContentLoaded', init);

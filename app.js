'use strict';

/* ============================================================
   FIREBASE CONFIG
   Firebase Console (console.firebase.google.com) で
   プロジェクト設定 > マイアプリ から取得した値を貼り付けてください
   ============================================================ */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyAlVzWR8x6YNz-HDog8_Hd8ylnwGXrMwnE',
  authDomain:        'darts-practice-ae2c8.firebaseapp.com',
  projectId:         'darts-practice-ae2c8',
  storageBucket:     'darts-practice-ae2c8.firebasestorage.app',
  messagingSenderId: '69157967154',
  appId:             '1:69157967154:web:26be8961f308f2495b732b',
};

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

      // クリケット: 全ラウンドを結合（旧オブジェクト形式も配列に統一）
      const allRounds = recs.flatMap(r => Calc.cpRounds(r.cricketPractice));
      const mergedCp = allRounds.length ? allRounds : null;

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

  return { getAll, saveAll, add, update, remove, getById, deduplicate };
})();

/* ============================================================
   CLOUD (Firebase Firestore sync)
   ============================================================ */
const Cloud = (() => {
  let db = null;
  let auth = null;
  let ready = false;

  function isConfigured() {
    return Boolean(FIREBASE_CONFIG.apiKey);
  }

  function init() {
    if (!isConfigured()) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db   = firebase.firestore();
      auth = firebase.auth();
      db.enablePersistence().catch(() => {});
      ready = true;
    } catch (e) {
      console.error('Firebase init:', e);
    }
  }

  function onAuthChange(cb) {
    if (!ready) return;
    auth.onAuthStateChanged(cb);
  }

  function signIn() {
    if (!ready) return Promise.reject();
    return auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  }

  function signOut() {
    if (!ready) return Promise.reject();
    return auth.signOut();
  }

  function getUser() {
    return ready ? auth.currentUser : null;
  }

  function col(uid) {
    return db.collection(`users/${uid}/records`);
  }

  async function saveRecord(uid, record) {
    if (!ready || !uid) return;
    try { await col(uid).doc(record.id).set(record); } catch (e) { console.error('Cloud.save:', e); }
  }

  async function deleteRecord(uid, id) {
    if (!ready || !uid) return;
    try { await col(uid).doc(id).delete(); } catch (e) { console.error('Cloud.delete:', e); }
  }

  // クラウドとローカルを双方向マージ（updatedAt の新しい方を正とする）
  async function syncAll(uid) {
    if (!ready || !uid) return 0;
    try {
      const snap = await col(uid).get();
      const cloudRecords = snap.docs.map(d => d.data());
      const localRecords = Storage.getAll();

      const merged = {};
      [...localRecords, ...cloudRecords].forEach(r => {
        const cur = merged[r.id];
        if (!cur || new Date(r.updatedAt) > new Date(cur.updatedAt)) merged[r.id] = r;
      });

      const mergedArr = Object.values(merged).sort((a, b) => b.date.localeCompare(a.date));

      // ローカルにない or より新しいレコードをアップロード
      const cloudById = Object.fromEntries(cloudRecords.map(r => [r.id, r]));
      await Promise.all(
        mergedArr
          .filter(r => !cloudById[r.id] || new Date(r.updatedAt) > new Date(cloudById[r.id].updatedAt))
          .map(r => saveRecord(uid, r))
      );

      const added = mergedArr.length - localRecords.length;
      Storage.saveAll(mergedArr);
      return added;
    } catch (e) {
      console.error('Cloud.syncAll:', e);
      return 0;
    }
  }

  return { isConfigured, init, onAuthChange, signIn, signOut, getUser, saveRecord, deleteRecord, syncAll };
})();

/* ============================================================
   TIMER
   ============================================================ */
const Timer = (() => {
  let interval = null;
  let seconds  = 0;
  let running  = false;

  function tick() {
    seconds++;
    const el = document.getElementById('timer-display');
    if (el) el.textContent =
      `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  }

  function updateUI() {
    const btn = document.getElementById('timer-toggle');
    if (!btn) return;
    btn.textContent = running ? '⏸ 停止' : '▶ 開始';
    btn.className   = `timer-btn timer-btn--${running ? 'stop' : 'start'}`;
  }

  function start() {
    if (running) return;
    running  = true;
    interval = setInterval(tick, 1000);
    updateUI();
  }

  function stop() {
    if (!running) return;
    clearInterval(interval);
    running = false;
    updateUI();
    if (seconds > 0) {
      const field = document.getElementById('f-minutes');
      if (field && !field.value) field.value = Math.max(1, Math.round(seconds / 60));
    }
  }

  function reset() {
    clearInterval(interval);
    running  = false;
    seconds  = 0;
    const el = document.getElementById('timer-display');
    if (el) el.textContent = '00:00';
    updateUI();
  }

  function toggle() { running ? stop() : start(); }

  return { toggle, reset };
})();

/* ============================================================
   GOALS
   ============================================================ */
const Goals = (() => {
  const KEY = 'darts_goals_v1';
  function get() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  }
  function save(g) { localStorage.setItem(KEY, JSON.stringify(g)); }
  return { get, save };
})();

function saveGoal(key, value) {
  const g = Goals.get();
  const n = Number(value);
  if (!value || isNaN(n) || n <= 0) delete g[key];
  else g[key] = n;
  Goals.save(g);
  const el = document.getElementById(`goal-prog-${key}`);
  if (el) el.innerHTML = n > 0 ? buildGoalProgress(key, n) : '';
}

function buildGoalProgress(key, goalVal) {
  const b = Calc.allBests(Storage.getAll());
  let current = null, unit = '', fixed = 0;
  if (key === 'cuScore')  { current = b.cuBest;              unit = 'pts'; }
  if (key === 'zo501Avg') { current = b.zoAvgBests?.['501']; unit = '';    fixed = 1; }
  if (key === 'mDays')    { current = b.mBestDays;           unit = '日';  }
  if (current === null)   return `<p class="goal-no-data">記録がまだありません</p>`;
  const pct      = Math.min(100, (current / goalVal) * 100);
  const achieved = pct >= 100;
  const fmt      = v => fixed ? Number(v).toFixed(fixed) : v;
  return `
    <div class="goal-bar-wrap">
      <div class="goal-bar${achieved ? ' goal-bar--done' : ''}" style="width:${pct.toFixed(1)}%"></div>
    </div>
    <span class="goal-pct">${achieved ? '🎉 ' : ''}${fmt(current)}${unit} / ${fmt(goalVal)}${unit}</span>`;
}

function buildGoalItem(key, label, unit, placeholder) {
  const goalVal = Goals.get()[key];
  return `
    <div class="goal-item">
      <div class="goal-header">
        <span class="goal-label">${label}</span>
        <div class="goal-input-wrap">
          <input type="number" class="goal-input" value="${goalVal || ''}"
                 placeholder="${placeholder}" inputmode="numeric"
                 oninput="saveGoal('${key}', this.value)">
          <span class="goal-unit">${unit}</span>
        </div>
      </div>
      <div id="goal-prog-${key}">${goalVal ? buildGoalProgress(key, goalVal) : ''}</div>
    </div>`;
}

/* ============================================================
   NUMPAD
   ============================================================ */
const NumPad = (() => {
  let currentInput = null;
  let currentValue = '';
  let allowDecimal = false;

  function open(inputEl, opts = {}) {
    currentInput = inputEl;
    currentValue = String(inputEl.value || '');
    allowDecimal = !!opts.decimal;

    document.getElementById('numpad-label').textContent = opts.label || '入力';
    updateDisplay();

    const dotKey = document.getElementById('numpad-dot');
    if (dotKey) dotKey.disabled = !allowDecimal;

    document.getElementById('numpad-overlay').classList.remove('hidden');
    inputEl.blur();
  }

  function close() {
    document.getElementById('numpad-overlay').classList.add('hidden');
    currentInput = null;
    currentValue = '';
  }

  function updateDisplay() {
    document.getElementById('numpad-display').textContent = currentValue || '-';
  }

  function press(key) {
    if (key === 'C') {
      currentValue = '';
    } else if (key === '⌫') {
      currentValue = currentValue.slice(0, -1);
    } else if (key === '.') {
      if (!allowDecimal) return;
      if (!currentValue) { currentValue = '0.'; }
      else if (!currentValue.includes('.')) { currentValue += '.'; }
    } else {
      if (currentValue.length < 6) currentValue += key;
    }
    updateDisplay();
  }

  function confirm() {
    if (currentInput) {
      currentInput.value = currentValue;
      currentInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    close();
  }

  function init() {
    const keys = ['7','8','9','4','5','6','1','2','3','.','0','⌫'];
    const grid = document.getElementById('numpad-grid');
    grid.innerHTML = keys.map(k => {
      const id  = k === '.' ? ' id="numpad-dot"' : '';
      const cls = k === '⌫' ? ' numpad-key--del' : k === '.' ? ' numpad-key--dot' : '';
      return `<button type="button" class="numpad-key${cls}"${id} data-key="${k}">${k}</button>`;
    }).join('');

    grid.addEventListener('click', e => {
      const btn = e.target.closest('[data-key]');
      if (btn) press(btn.dataset.key);
    });

    document.getElementById('numpad-clear').addEventListener('click', () => press('C'));
    document.getElementById('numpad-confirm').addEventListener('click', confirm);
    document.getElementById('numpad-backdrop').addEventListener('click', close);
  }

  return { open, close, press, confirm, init };
})();

/* ============================================================
   CRICKET COUNT MODE
   ============================================================ */
const CricketCountMode = (() => {
  let roundId   = null;
  let numIndex  = 0;
  let counts    = {};
  let advancing = false;

  function open(rid) {
    roundId   = rid;
    numIndex  = 0;
    advancing = false;
    CRICKET_NUMS.forEach(n => { counts[n] = { throws: 0, hits: 0 }; });
    document.getElementById('count-mode').classList.remove('hidden');
    renderNum();
  }

  const HIT_IDS = ['cm-hit-s', 'cm-hit-d', 'cm-hit-t'];

  function setHitButtonsDisabled(disabled) {
    document.getElementById('cm-miss').disabled = disabled;
    HIT_IDS.forEach(id => { document.getElementById(id).disabled = disabled; });
  }

  function renderNum() {
    const n    = CRICKET_NUMS[numIndex];
    const done = counts[n].hits >= 10;

    document.getElementById('cm-number').textContent   = n;
    document.getElementById('cm-progress').textContent = `${numIndex + 1} / ${CRICKET_NUMS.length}`;
    updateStatus();
    setHitButtonsDisabled(done);
  }

  function updateStatus() {
    const n    = CRICKET_NUMS[numIndex];
    const { throws, hits } = counts[n];
    const done = hits >= 10;
    const el   = document.getElementById('cm-status');
    el.textContent = done ? `✓ ${throws}投で10カウント！` : `${throws}投　${hits}/10`;
    el.className   = `cm-status${done ? ' cm-status--done' : ''}`;
  }

  function miss() {
    if (advancing) return;
    counts[CRICKET_NUMS[numIndex]].throws++;
    updateStatus();
  }

  function hit(count) {
    if (advancing) return;
    const n = CRICKET_NUMS[numIndex];
    counts[n].throws++;
    counts[n].hits += count;

    const done = counts[n].hits >= 10;
    setHitButtonsDisabled(done);
    updateStatus();

    if (done && numIndex < CRICKET_NUMS.length - 1) {
      advancing = true;
      setTimeout(() => { advancing = false; next(); }, 1200);
    }
  }

  function next() {
    if (numIndex < CRICKET_NUMS.length - 1) {
      numIndex++;
      renderNum();
    } else {
      finish();
    }
  }

  function finish() {
    if (roundId) {
      CRICKET_NUMS.forEach(n => {
        const c = counts[n];
        if (c.throws === 0) return;
        const input = document.getElementById(`${roundId}-${n}`);
        if (!input) return;
        input.value          = c.throws;
        input.dataset.throws = c.throws;
        input.dataset.hits   = c.hits;

        const infoEl = document.getElementById(`cnt-${roundId}-${n}`);
        if (infoEl) {
          const done     = c.hits >= 10;
          infoEl.textContent = done ? `✓ ${c.throws}投` : `${c.throws}投 ${c.hits}/10`;
          infoEl.className   = `cnt-info${done ? ' cnt-info--done' : ''}`;
        }
      });
      updateCricketCalc();
      updateTotalCalc();
    }
    close();
  }

  function close() {
    document.getElementById('count-mode').classList.add('hidden');
    roundId = null;
  }

  function init() {
    document.getElementById('cm-miss').addEventListener('click', miss);
    document.getElementById('cm-hit-s').addEventListener('click', () => hit(1));
    document.getElementById('cm-hit-d').addEventListener('click', () => hit(2));
    document.getElementById('cm-hit-t').addEventListener('click', () => hit(3));
    document.getElementById('cm-next').addEventListener('click', next);
    document.getElementById('cm-close').addEventListener('click', finish);
  }

  return { open, close, init };
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

  // cricketPractice は配列形式 [{20:18,...}, ...] を想定。旧オブジェクト形式も許容
  cpRounds(cp) {
    if (!cp) return [];
    return Array.isArray(cp) ? cp : [cp];
  },

  cricketDarts(cp) {
    return this.cpRounds(cp).reduce((total, round) =>
      total + Object.values(round).reduce((s, v) => s + (Number(v) || 0), 0), 0);
  },

  totalDarts(r) {
    return this.cuDarts(r.countUp?.games) + this.zoDarts(r.zeroOne) + this.cricketDarts(r.cricketPractice);
  },

  // Average throws per number across a set of records (all rounds)
  cricketAverages(records) {
    const sums = {}, counts = {};
    CRICKET_NUMS.forEach(n => { sums[n] = 0; counts[n] = 0; });
    records.forEach(r => {
      this.cpRounds(r.cricketPractice).forEach(round => {
        CRICKET_NUMS.forEach(n => {
          const v = Number(round[n]);
          if (v > 0) { sums[n] += v; counts[n]++; }
        });
      });
    });
    const out = {};
    CRICKET_NUMS.forEach(n => {
      out[n] = counts[n] > 0 ? sums[n] / counts[n] : null;
    });
    return out;
  },

  // Best (minimum) throws per number across records (all rounds)
  cricketBests(records) {
    const bests = {};
    CRICKET_NUMS.forEach(n => { bests[n] = null; });
    records.forEach(r => {
      this.cpRounds(r.cricketPractice).forEach(round => {
        CRICKET_NUMS.forEach(n => {
          const v = Number(round[n]);
          if (v > 0 && (bests[n] === null || v < bests[n])) bests[n] = v;
        });
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
  screen:        'home',
  editId:        null,
  rankPeriod:    '30',
  monthlyYM:     Utils.currentYM(),
  prevBests:     null,
  submitting:    false,
  cricketRounds: [],
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
  Timer.reset();
  State.editId = editId;
  State.cricketRounds = [];

  document.getElementById('record-title').textContent = editId ? '練習記録を編集' : '練習を記録する';
  document.getElementById('f-date').value = Utils.today();
  document.getElementById('f-minutes').value = '';
  document.getElementById('f-memo').value = '';

  document.getElementById('countup-games').innerHTML = '';
  document.getElementById('zeroone-games').innerHTML = '';
  document.getElementById('cricket-rounds').innerHTML = '';

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
      (r.zeroOne || []).forEach(g => addZoGame(g.type, g.average));

      // 旧オブジェクト形式・新配列形式どちらも対応
      Calc.cpRounds(r.cricketPractice).forEach(round => addCricketRound(round));

      updateCuCalc();
      updateZoCalc();
      updateCricketCalc();
      updateTotalCalc();
    }
  }
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
    <input type="text" class="input-score" placeholder="スコア"
           readonly
           value="${Utils.esc(String(scoreVal || ''))}"
           oninput="updateCuCalc(); updateTotalCalc()"
           onclick="NumPad.open(this, {label:'COUNT-UP スコア'})">
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
function addZoGame(type = '501', avg = '') {
  const rows = document.querySelectorAll('#zeroone-games .game-row');
  const num  = rows.length + 1;
  const id   = `zo-${Utils.genId()}`;

  const makeOption = (v, label) => `<option value="${v}" ${type === v ? 'selected' : ''}>${label}</option>`;

  const row = document.createElement('div');
  row.className = 'game-row';
  row.id = id;
  row.innerHTML = `
    <span class="game-num">${num}</span>
    <select class="input-type" onchange="updateZoGame('${id}'); updateZoCalc()">
      ${makeOption('301','301')}
      ${makeOption('501','501')}
      ${makeOption('701','701')}
    </select>
    <span class="input-label">AVG</span>
    <input type="text" class="input-avg" placeholder="0.0"
           readonly
           value="${Utils.esc(String(avg || ''))}"
           oninput="updateZoGame('${id}'); updateZoCalc()"
           onclick="NumPad.open(this, {label:'アベレージ', decimal:true})">
    <span class="zo-est" id="zo-est-${id}">≈ - 投</span>
    <button type="button" class="btn-remove" onclick="removeZoGame('${id}')">✕</button>
  `;
  document.getElementById('zeroone-games').appendChild(row);
  updateZoGame(id);
  updateZoCalc();
}

function updateZoGame(id) {
  const row = document.getElementById(id);
  if (!row) return;
  const type = row.querySelector('.input-type').value;
  const avg  = Number(row.querySelector('.input-avg').value) || 0;
  const est  = document.getElementById(`zo-est-${id}`);
  if (est) est.textContent = avg > 0 ? `≈ ${Math.round(Number(type) / avg * 3)} 投` : '≈ - 投';
  updateTotalCalc();
}

function removeZoGame(id) {
  const row = document.getElementById(id);
  if (row) row.remove();
  renumberRows('zeroone-games');
  updateZoCalc();
  updateTotalCalc();
}

function getZoGames() {
  return Array.from(document.querySelectorAll('#zeroone-games .game-row')).map(row => {
    const type    = row.querySelector('.input-type').value;
    const average = Number(row.querySelector('.input-avg').value) || 0;
    const darts   = average > 0 ? Math.round(Number(type) / average * 3) : 0;
    return { type, average, darts };
  }).filter(g => g.average > 0);
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
function addCricketRound(data = {}) {
  const roundId = `cr-${Utils.genId()}`;
  State.cricketRounds.push(roundId);

  const container = document.getElementById('cricket-rounds');
  const roundNum  = State.cricketRounds.length;

  const div = document.createElement('div');
  div.className = 'cricket-round';
  div.id = roundId;
  div.innerHTML = `
    <div class="cricket-round-header">
      <span class="cricket-round-label">ラウンド ${roundNum}</span>
      <div class="cricket-round-actions">
        <button type="button" class="btn-count-start" onclick="CricketCountMode.open('${roundId}')">▶ カウント開始</button>
        <button type="button" class="btn-remove" onclick="removeCricketRound('${roundId}')">✕</button>
      </div>
    </div>
    <div class="cricket-grid">
      ${CRICKET_NUMS.map(n => `
        <div class="cricket-item">
          <label>${n}</label>
          <input type="text" id="${roundId}-${n}" placeholder="-"
                 readonly
                 value="${data[n] || ''}"
                 data-throws="0" data-hits="0"
                 oninput="updateCricketCalc(); updateTotalCalc()"
                 onclick="NumPad.open(this, {label:'${n}'})">
          <div class="cnt-wrap">
            <span class="cnt-info" id="cnt-${roundId}-${n}">0投 0/10</span>
            <div class="cnt-btns">
              <button type="button" class="btn-cnt-miss" onclick="cricketCount('${roundId}','${n}',0)">投</button>
              <button type="button" class="btn-cnt-s"    onclick="cricketCount('${roundId}','${n}',1)">S</button>
              <button type="button" class="btn-cnt-d"    onclick="cricketCount('${roundId}','${n}',2)">D</button>
              <button type="button" class="btn-cnt-t"    onclick="cricketCount('${roundId}','${n}',3)">T</button>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
  container.appendChild(div);
  updateCricketCalc();
}

function cricketCount(roundId, num, count) {
  const input  = document.getElementById(`${roundId}-${num}`);
  const throws = (Number(input.dataset.throws) || 0) + 1;
  const hits   = (Number(input.dataset.hits)   || 0) + count;
  input.dataset.throws = throws;
  input.dataset.hits   = hits;

  const done = hits >= 10;
  if (done && !input.value) {
    input.value = throws;
    updateCricketCalc();
    updateTotalCalc();
  }

  const display = document.getElementById(`cnt-${roundId}-${num}`);
  if (display) {
    display.textContent = done ? `✓ ${throws}投` : `${throws}投 ${hits}/10`;
    display.className   = `cnt-info${done ? ' cnt-info--done' : ''}`;
  }
}

function removeCricketRound(roundId) {
  document.getElementById(roundId)?.remove();
  State.cricketRounds = State.cricketRounds.filter(id => id !== roundId);
  document.querySelectorAll('.cricket-round').forEach((el, i) => {
    el.querySelector('.cricket-round-label').textContent = `ラウンド ${i + 1}`;
  });
  updateCricketCalc();
  updateTotalCalc();
}

function getCricketPractice() {
  const rounds = [];
  document.querySelectorAll('.cricket-round').forEach(roundEl => {
    const round = {};
    CRICKET_NUMS.forEach(n => {
      const v = Number(roundEl.querySelector(`[id$="-${n}"]`)?.value);
      if (v > 0) round[n] = v;
    });
    if (Object.keys(round).length) rounds.push(round);
  });
  return rounds.length ? rounds : null;
}

function updateCricketCalc() {
  const cp = getCricketPractice();
  const el = document.getElementById('cricket-calc');
  if (!cp) {
    el.innerHTML = '<span class="calc-placeholder">ラウンドを追加してください</span>';
    return;
  }
  const totalDarts  = Calc.cricketDarts(cp);
  const totalRounds = cp.length;
  const numCount    = new Set(cp.flatMap(r => Object.keys(r))).size;
  el.innerHTML = `
    ラウンド数: <span class="calc-value">${totalRounds}回</span>
    入力ナンバー: <span class="calc-value">${numCount}種</span>
    投擲数: <span class="calc-value">${totalDarts}投</span>
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

  const syncUid = Cloud.getUser()?.uid;
  if (syncUid) Cloud.saveRecord(syncUid, record);

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
    const rounds = Calc.cpRounds(r.cricketPractice);
    html += `<div class="detail-section"><h3>クリケットナンバー練習</h3>`;
    rounds.forEach((round, i) => {
      if (rounds.length > 1) {
        html += `<div style="font-size:12px;color:var(--text-muted);font-weight:700;margin:10px 0 6px">ラウンド ${i + 1}</div>`;
      }
      html += `<div class="detail-cricket">`;
      CRICKET_NUMS.forEach(n => {
        if (round[n]) {
          html += `<div class="detail-cricket-item"><div class="dc-num">${n}</div><div class="dc-val">${round[n]}</div></div>`;
        }
      });
      html += `</div>`;
    });
    html += `<div style="margin-top:8px;font-size:14px;color:var(--text-secondary)">合計: <span style="color:var(--accent);font-weight:600">${Calc.cricketDarts(r.cricketPractice)}投</span></div>`;
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

    <div class="best-group goals-group">
      <h3>🎯 目標設定</h3>
      <p class="goals-hint">目標を入力すると達成状況が表示されます</p>
      ${buildGoalItem('cuScore',  'COUNT-UP 最高スコア', 'pts', '例: 600')}
      ${buildGoalItem('zo501Avg', '501 AVG',            '',    '例: 70.0')}
      ${buildGoalItem('mDays',    '月間練習日数',        '日',  '例: 20')}
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
    .filter(n => stats.cricketAvg[n] !== null && prev !== null && prev.cricketAvg[n] !== null)
    .map(n => ({ n, diff: prev.cricketAvg[n] - stats.cricketAvg[n] }))
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
   SYNC BAR
   ============================================================ */
function renderSyncBar(user) {
  const bar  = document.getElementById('sync-bar');
  const text = document.getElementById('sync-status-text');
  const btn  = document.getElementById('sync-login-btn');
  if (!Cloud.isConfigured()) return;
  bar.classList.remove('hidden');
  if (user) {
    text.innerHTML = user.photoURL
      ? `<img src="${Utils.esc(user.photoURL)}" class="sync-avatar" referrerpolicy="no-referrer"> ${Utils.esc(user.displayName || user.email)}`
      : Utils.esc(user.displayName || user.email || 'ログイン中');
    btn.textContent = 'ログアウト';
    btn.className   = 'sync-btn sync-btn--out';
    btn.onclick = () => Cloud.signOut().then(() => showToast('ログアウトしました'));
  } else {
    text.textContent = 'Googleアカウントで同期';
    btn.textContent  = 'ログイン';
    btn.className    = 'sync-btn sync-btn--in';
    btn.onclick = () => Cloud.signIn().catch(() => showToast('ログインに失敗しました', 'error'));
  }
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  // カスタムUI初期化
  NumPad.init();
  CricketCountMode.init();

  // Firebase初期化・認証状態の監視
  Cloud.init();
  Cloud.onAuthChange(async user => {
    renderSyncBar(user);
    if (user) {
      const added = await Cloud.syncAll(user.uid);
      Storage.deduplicate();
      showToast(added > 0 ? `クラウドから${added}件を取得しました` : '同期完了 ✓');
      navigate(State.screen);
    }
  });

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

  // Timer
  document.getElementById('timer-toggle').addEventListener('click', () => Timer.toggle());
  document.getElementById('timer-reset').addEventListener('click',  () => Timer.reset());

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
  document.getElementById('add-cricket-round').addEventListener('click', () => addCricketRound());
  document.getElementById('cancel-record').addEventListener('click', () => {
    navigate(State.editId ? 'history' : 'home');
  });

  // Delete confirm
  document.getElementById('confirm-yes').addEventListener('click', () => {
    if (pendingDeleteId) {
      const delId = pendingDeleteId;
      Storage.remove(delId);
      const delUid = Cloud.getUser()?.uid;
      if (delUid) Cloud.deleteRecord(delUid, delId);
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

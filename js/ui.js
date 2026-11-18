/* SHYL-WJ86 在线模拟 —— 界面与交互 */
(function () {
  'use strict';
  const SHYL = window.SHYL;
  const U = SHYL.U;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const SVGNS = 'http://www.w3.org/2000/svg';

  const SEG_LINES = [
    [10, 8, 46, 8],    // a
    [48, 12, 48, 44],  // b
    [48, 52, 48, 84],  // c
    [10, 88, 46, 88],  // d
    [8, 52, 8, 84],    // e
    [8, 12, 8, 44],    // f
    [10, 48, 46, 48]   // g
  ];

  const WIRE_SCHEMA = [
    {
      title: '8253 时钟与门控',
      rows: [
        { key: 'clk0', label: 'CLK0 时钟源', type: 'select', options: ['1MHz', '500kHz', '100kHz', 'AN1'] },
        { key: 'gate0', label: 'GATE0', type: 'select', options: ['+5V', 'K1', 'K2', 'K3', 'K4'] },
        { key: 'gate1', label: 'GATE1', type: 'select', options: ['+5V', 'K1', 'K2', 'K3', 'K4'] },
        { key: 'gate2', label: 'GATE2', type: 'select', options: ['+5V', 'K1', 'K2', 'K3', 'K4'] }
      ]
    },
    {
      title: '8253 输出',
      rows: [
        { key: 'out0Irq', label: 'OUT0 → 8259 IRQ0', type: 'check' },
        { key: 'out0Clk1', label: 'OUT0 → CLK1（级联）', type: 'check' },
        { key: 'out1Clk2', label: 'OUT1 → CLK2（级联）', type: 'check' },
        { key: 'out0Pc7', label: 'OUT0 → 8255 PC7（1 ms 节拍）', type: 'check' },
        { key: 'out1Pc0', label: 'OUT1 → 8255 PC0（1 s 节拍）', type: 'check' },
        { key: 'out0Led', label: 'OUT0 → L1', type: 'check' },
        { key: 'out1Led', label: 'OUT1 → L1', type: 'check' },
        { key: 'out2Led', label: 'OUT2 → L1', type: 'check' }
      ]
    },
    {
      title: '中断与模拟量',
      rows: [
        { key: 'adcIrq', label: '0809 EOC → 8259 IRQ1', type: 'check' },
        { key: 'an2Irq', label: 'AN2 → 8259 IRQ2', type: 'check' }
      ]
    },
    {
      title: '显示与极性',
      rows: [
        { key: 'digitPort', label: '数码管位选端口', type: 'select', options: ['PC', 'PB'] },
        { key: 'ledPort', label: '发光二极管接在', type: 'select', options: ['PB', 'PA'] },
        { key: 'matrixMode', label: '点阵接法（PA 行 / PB 列）', type: 'check' },
        { key: 'digitReverse', label: '数码管位序反转（PC0 最左）', type: 'check' },
        { key: 'invertSeg', label: '共阳数码管（段码反相）', type: 'check' },
        { key: 'invertDig', label: '位选低有效', type: 'check' },
        { key: 'invertLed', label: 'LED 低电平点亮', type: 'check' },
        { key: 'invertRow', label: '点阵行反相', type: 'check' },
        { key: 'invertCol', label: '点阵列反相', type: 'check' }
      ]
    }
  ];

  const sys = new SHYL.System();
  const asm = new SHYL.Assembler();
  const DEFAULT_WIRING = Object.assign({}, sys.wiring);

  let running = false;
  let paused = false;
  let speed = 1;
  let lastTs = 0;
  let lastPanelTs = 0;
  let lastScopeTs = 0;
  let uiLog = '';
  let faultReported = false;

  let editor, gutter, consoleEl, errorsEl, sampleSel, statusPill, statusText;
  let digitEls = [];
  let matrixCells = [];
  let ledEls = [];
  let switchEls = [];
  let scopeCanvas, scopeCtx, scopeBaseSel;

  /* ------------------------------------------------------------------ */
  /* 构建面板                                                           */
  /* ------------------------------------------------------------------ */
  function buildDigits() {
    const host = $('#digits');
    host.innerHTML = '';
    digitEls = [];
    for (let d = 0; d < 8; d++) {
      const div = document.createElement('div');
      div.className = 'digit';
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', '0 0 56 96');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const segs = [];
      SEG_LINES.forEach((p, i) => {
        const line = document.createElementNS(SVGNS, 'line');
        line.setAttribute('x1', p[0]); line.setAttribute('y1', p[1]);
        line.setAttribute('x2', p[2]); line.setAttribute('y2', p[3]);
        line.setAttribute('stroke-width', '7');
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('class', 'seg s' + i);
        svg.appendChild(line);
        segs.push(line);
      });
      const dp = document.createElementNS(SVGNS, 'circle');
      dp.setAttribute('cx', '50'); dp.setAttribute('cy', '86'); dp.setAttribute('r', '3.4');
      dp.setAttribute('class', 'dp');
      svg.appendChild(dp);
      div.appendChild(svg);
      host.appendChild(div);
      digitEls.push({ root: div, segs: segs, dp: dp });
    }
  }

  function buildMatrix() {
    const host = $('#matrix');
    host.innerHTML = '';
    matrixCells = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        host.appendChild(cell);
        matrixCells.push(cell);
      }
    }
  }

  function buildLeds() {
    const host = $('#leds');
    host.innerHTML = '';
    ledEls = [];
    for (let i = 0; i < 8; i++) {
      const item = document.createElement('div');
      item.className = 'led-item';
      const bulb = document.createElement('i');
      bulb.className = 'bulb';
      const label = document.createElement('span');
      label.textContent = 'L' + (i + 1);
      item.appendChild(bulb);
      item.appendChild(label);
      host.appendChild(item);
      ledEls.push(item);
    }
  }

  function buildSwitches() {
    const host = $('#switches');
    host.innerHTML = '';
    switchEls = [];
    for (let i = 0; i < 12; i++) {
      const btn = document.createElement('button');
      btn.className = 'switch';
      btn.type = 'button';
      btn.title = 'K' + (i + 1) + '：点击切换 0/1';
      const knob = document.createElement('i');
      knob.className = 'knob';
      const label = document.createElement('span');
      label.textContent = 'K' + (i + 1);
      btn.appendChild(knob);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        sys.setSwitch(i, sys.switches[i] ? 0 : 1);
        btn.classList.toggle('on', !!sys.switches[i]);
      });
      host.appendChild(btn);
      switchEls.push(btn);
    }
  }

  function buildWires() {
    const host = $('#wireForm');
    host.innerHTML = '';
    for (const group of WIRE_SCHEMA) {
      const box = document.createElement('div');
      box.className = 'wire-group';
      const h = document.createElement('h4');
      h.textContent = group.title;
      box.appendChild(h);
      for (const row of group.rows) {
        const div = document.createElement('div');
        div.className = 'wire-row';
        if (row.type === 'check') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.key = row.key;
          cb.checked = !!sys.wiring[row.key];
          const label = document.createElement('label');
          label.textContent = row.label;
          label.prepend(cb);
          div.appendChild(label);
        } else {
          const label = document.createElement('label');
          label.textContent = row.label;
          const sel = document.createElement('select');
          sel.dataset.key = row.key;
          for (const opt of row.options) {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            sel.appendChild(o);
          }
          sel.value = sys.wiring[row.key];
          div.appendChild(label);
          div.appendChild(sel);
        }
        box.appendChild(div);
      }
      host.appendChild(box);
    }

    host.addEventListener('change', e => {
      const key = e.target.dataset && e.target.dataset.key;
      if (!key) return;
      if (e.target.type === 'checkbox') sys.wiring[key] = e.target.checked;
      else sys.wiring[key] = e.target.value;
      sys.configureClocks();
      updateBoardTags();
      if (key === 'out0Irq' && !sys.wiring.out0Irq) sys.pic.setLine(0, 0);
    });
  }

  function syncWireUI() {
    $$('#wireForm [data-key]').forEach(el => {
      const key = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!sys.wiring[key];
      else el.value = sys.wiring[key];
    });
  }

  function updateBoardTags() {
    const w = sys.wiring;
    $('#matrixTag').textContent = w.matrixMode ? 'PA=行 / PB=列' : '未接入（接线页启用）';
    $('#segTag').textContent = (w.invertSeg ? '共阳' : '共阴') + ' / ' + (w.invertDig ? '位选低有效' : '段高有效');
    $('#segFoot').textContent = w.digitPort === 'PB'
      ? 'PA=段码，PB=位选' + (w.digitReverse ? '（PB0 最左）' : '（PB0 最右）')
      : (w.digitReverse ? 'PA=段码，PC0 最左' : 'PA=段码，PC0 最右');
    $('#ledFoot').textContent = (w.ledPort === 'PB' && (w.digitPort === 'PB' || w.matrixMode))
      ? 'PB 已用于' + (w.digitPort === 'PB' ? '位选' : '点阵列') + '，L1…L8 不显示'
      : 'L1 … L8 ← ' + w.ledPort + '0…' + w.ledPort + '7' + (w.invertLed ? '（低电平点亮）' : '（高电平点亮）');
    $('#matrix').classList.toggle('off', !w.matrixMode);
  }

  /* ------------------------------------------------------------------ */
  /* 编辑器                                                             */
  /* ------------------------------------------------------------------ */
  function updateGutter() {
    const n = editor.value.split('\n').length;
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = i + 1;
    gutter.textContent = arr.join('\n');
    gutter.scrollTop = editor.scrollTop;
  }

  function setEditorText(text) {
    editor.value = text;
    editor.scrollTop = 0;
    updateGutter();
  }

  function jumpToLine(n) {
    const lines = editor.value.split('\n');
    n = Math.max(1, Math.min(lines.length, n));
    let pos = 0;
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
    editor.focus();
    editor.setSelectionRange(pos, pos + lines[n - 1].length);
    editor.scrollTop = Math.max(0, (n - 4) * 19);
    gutter.scrollTop = editor.scrollTop;
  }

  function showErrors(errors) {
    errorsEl.innerHTML = '';
    if (!errors.length) { errorsEl.classList.remove('show'); return; }
    for (const e of errors) {
      const item = document.createElement('div');
      item.className = 'error-item';
      const b = document.createElement('b');
      b.textContent = 'L' + e.line;
      item.appendChild(b);
      item.appendChild(document.createTextNode('  ' + e.msg));
      item.addEventListener('click', () => jumpToLine(e.line));
      errorsEl.appendChild(item);
    }
    errorsEl.classList.add('show');
  }

  /* ------------------------------------------------------------------ */
  /* 日志 / 状态                                                        */
  /* ------------------------------------------------------------------ */
  function appendLog(text) {
    uiLog += text;
    if (uiLog.length > 30000) uiLog = uiLog.slice(-30000);
    consoleEl.textContent = uiLog;
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function logLine(text) {
    appendLog((uiLog && !uiLog.endsWith('\n') ? '\n' : '') + text + '\n');
  }

  function setStatus(text, cls) {
    statusText.textContent = text;
    statusPill.className = 'status-pill' + (cls ? ' ' + cls : '');
  }

  function setButtons() {
    $('#btnPause').disabled = !running;
    $('#btnReset').disabled = !sys.program;
    $('#btnPause').textContent = paused ? '继续' : '暂停';
    $('#btnRun').textContent = running ? '↻ 重新汇编运行' : '▶ 汇编并运行';
  }

  /* ------------------------------------------------------------------ */
  /* 运行控制                                                           */
  /* ------------------------------------------------------------------ */
  function assembleAndRun() {
    showErrors([]);
    faultReported = false;
    const res = asm.assemble(editor.value);
    if (!res.ok) {
      showErrors(res.errors);
      setStatus('汇编错误', 'error');
      logLine('✗ 汇编失败，共 ' + res.errors.length + ' 处错误。');
      running = false; paused = false; setButtons();
      return false;
    }
    showErrors([]);
    uiLog = '';
    consoleEl.textContent = '';
    sys.load(res.program);
    sys.setCpuHz(parseInt($('#cpuSel').value, 10));
    sys.configureClocks();
    running = true;
    paused = false;
    lastTs = 0;
    setStatus('运行中', 'run');
    setButtons();
    logLine('✓ 汇编成功：' + res.program.code.length + ' 条指令，数据 ' + res.program.dataLen + ' 字节。');
    if (res.warnings.length) {
      for (const w of res.warnings.slice(0, 8)) logLine('  提示 L' + w.line + '：' + w.msg);
    }
    renderPanels();
    return true;
  }

  function resetMachine() {
    sys.reset();
    running = !!sys.program;
    paused = true;
    faultReported = false;
    setStatus('已复位', 'paused');
    setButtons();
    logLine('■ 已复位（程序与接线保留）。');
    renderPanels();
    renderBoard();
  }

  function togglePause() {
    if (!running) return;
    paused = !paused;
    setStatus(paused ? '已暂停' : '运行中', paused ? 'paused' : 'run');
    setButtons();
  }

  /* ------------------------------------------------------------------ */
  /* 渲染面板                                                           */
  /* ------------------------------------------------------------------ */
  function renderBoard() {
    const snap = sys.snapshot();
    const w = sys.wiring;

    // 数码管
    const segs = snap.seg;
    for (let i = 0; i < 8; i++) {
      const d = digitEls[i];
      const mask = segs[i] && segs[i].on ? segs[i].seg : 0;
      d.root.classList.toggle('dark', mask === 0);
      for (let s = 0; s < 7; s++) d.segs[s].classList.toggle('on', !!((mask >> s) & 1));
      d.dp.classList.toggle('on', !!((mask >> 7) & 1));
    }

    // 点阵
    const matrixOn = w.matrixMode;
    if (matrixOn) {
      const m = snap.matrix;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const b = m[r][c];
          const cell = matrixCells[r * 8 + c];
          if (b > 0.02) {
            cell.style.background = 'rgba(255,74,48,' + (0.10 + b * 0.9).toFixed(3) + ')';
            cell.style.boxShadow = b > 0.45 ? '0 0 ' + (4 + b * 10).toFixed(1) + 'px rgba(255,74,48,' + (b * 0.6).toFixed(2) + ')' : 'none';
          } else {
            cell.style.background = '';
            cell.style.boxShadow = '';
          }
        }
      }
    } else {
      for (const cell of matrixCells) { cell.style.background = ''; cell.style.boxShadow = ''; }
    }

    // LED
    let leds = snap.leds;
    if (w.out0Led || w.out1Led || w.out2Led) {
      leds = (leds & 0xFE) | (snap.extLed ? 1 : 0);
    }
    for (let i = 0; i < 8; i++) ledEls[i].classList.toggle('on', !!((leds >> i) & 1));

    // DAC
    const dv = snap.dac.volts;
    $('#dacVolt').textContent = (dv >= 0 ? '+' : '−') + Math.abs(dv).toFixed(2) + ' V';
    $('#dacCode').textContent = 'N = ' + U.byte(snap.dac.value) + 'H';
    $('#dacFill').style.width = ((dv + 5) / 10 * 100).toFixed(1) + '%';

    // ADC
    const av = parseFloat($('#adcRange').value);
    $('#adcVolt').textContent = av.toFixed(2) + ' V';
    $('#adcCode').textContent = U.byte(snap.adc.val) + 'H';
    $('#adcState').textContent = snap.adc.converting ? '转换中' : (snap.adc.eoc ? 'EOC' : '就绪');

    const sub = [];
    sub.push(U.fmtTime(snap.t));
    sub.push((sys.cpuHz / 1e6).toFixed(1) + ' MHz');
    if (snap.fault) sub.push('错误');
    else if (snap.halted) sub.push('CPU 停机');
    else if (paused) sub.push('已暂停');
    else if (running) sub.push('运行中');
    $('#boardSub').textContent = sub.join(' · ');
  }

  function renderPanels() {
    const snap = sys.snapshot();
    const w = sys.wiring;

    // 寄存器
    const regs = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS'];
    const parts = [];
    for (const r of regs) {
      parts.push('<div class="reg-card"><span>' + r + '</span><b>' + U.word(snap.regs[r]) +
        '<em>' + snap.regs[r] + '</em></b></div>');
    }
    parts.push('<div class="reg-card"><span>IP</span><b>' + snap.ip + '<em>指令</em></b></div>');
    parts.push('<div class="reg-card"><span>周期</span><b>' + snap.cycles + '</b></div>');
    $('#regGrid').innerHTML = parts.join('');

    const flags = ['CF', 'PF', 'AF', 'ZF', 'SF', 'TF', 'IF', 'DF', 'OF'];
    $('#flagRow').innerHTML = flags.map(f => '<span class="flag' + (snap.flags[f] ? ' on' : '') + '">' + f + '</span>').join('');

    $('#ipInfo').textContent = snap.fault
      ? '执行错误：' + snap.fault
      : (snap.halted ? 'CPU 已停机（HLT 或程序结束）' : 'IP 指向第 ' + snap.ip + ' 条指令（从 0 计数）');

    // 芯片
    const cards = [];
    const timers = snap.timers;
    cards.push('<div class="chip-card"><div class="chip-title">8253 / 8254 定时计数器<span>200H~203H</span></div><div class="chip-body">');
    for (const t of timers) {
      cards.push('<div class="kv"><span>C' + t.index + ' · 方式' + t.mode + ' · ' + t.clock + '</span><b>N=' + t.n + ' 计=' + t.count + '</b></div>');
      cards.push('<div class="kv"><span>OUT' + t.index + '</span><b class="' + (t.out ? 'hi' : '') + '">' + t.out + ' · GATE=' + (t.gate ? '1' : '0') + '</b></div>');
    }
    cards.push('</div></div>');

    const ppi = snap.ppi;
    const bits = (v) => {
      let s = '';
      for (let i = 0; i < 8; i++) s += '<i class="' + ((v >> i) & 1 ? 'on' : '') + '">' + i + '</i>';
      return s;
    };
    cards.push('<div class="chip-card"><div class="chip-title">8255 并行接口<span>210H~213H</span></div><div class="chip-body">');
    cards.push('<div class="kv"><span>控制字</span><b class="hi">' + U.byte(ppi.control) + 'H</b></div>');
    cards.push('<div class="kv"><span>PA（' + ppi.paDir + '）</span><b>' + U.byte(ppi.PA) + 'H</b></div><div class="bitrow">' + bits(ppi.PA) + '</div>');
    cards.push('<div class="kv"><span>PB（' + ppi.pbDir + '）</span><b>' + U.byte(ppi.PB) + 'H</b></div><div class="bitrow">' + bits(ppi.PB) + '</div>');
    cards.push('<div class="kv"><span>PC（' + ppi.pcDir + '）</span><b>' + U.byte(ppi.PC) + 'H</b></div><div class="bitrow">' + bits(ppi.PC) + '</div>');
    cards.push('</div></div>');

    const pic = snap.pic;
    cards.push('<div class="chip-card"><div class="chip-title">8259 中断控制器<span>230H / 231H</span></div><div class="chip-body">');
    cards.push('<div class="kv"><span>中断类型基址</span><b>' + U.byte(pic.base) + 'H</b></div>');
    cards.push('<div class="kv"><span>IMR 屏蔽</span><b>' + U.byte(pic.imr) + 'H</b></div><div class="bitrow">' + bits(pic.imr) + '</div>');
    cards.push('<div class="kv"><span>IRR 请求</span><b>' + U.byte(pic.irr) + 'H</b></div><div class="bitrow">' + bits(pic.irr) + '</div>');
    cards.push('<div class="kv"><span>ISR 服务</span><b>' + U.byte(pic.isr) + 'H</b></div><div class="bitrow">' + bits(pic.isr) + '</div>');
    cards.push('<div class="kv"><span>触发方式</span><b>' + (pic.edge ? '边沿' : '电平') + '</b></div>');
    cards.push('</div></div>');

    const adc = snap.adc;
    cards.push('<div class="chip-card"><div class="chip-title">ADC0809<span>260H~267H</span></div><div class="chip-body">');
    cards.push('<div class="kv"><span>通道 / 数字量</span><b>IN' + adc.ch + ' · ' + U.byte(adc.val) + 'H</b></div>');
    cards.push('<div class="kv"><span>EOC / 转换次数</span><b>' + (adc.eoc ? '1' : '0') + ' · ' + adc.count + '</b></div>');
    cards.push('</div></div>');

    cards.push('<div class="chip-card"><div class="chip-title">DAC0832<span>250H</span></div><div class="chip-body">');
    cards.push('<div class="kv"><span>数字量 N</span><b>' + U.byte(snap.dac.value) + 'H</b></div>');
    cards.push('<div class="kv"><span>DAOUT</span><b class="hi">' + snap.dac.volts.toFixed(2) + ' V</b></div>');
    cards.push('</div></div>');

    $('#chipCards').innerHTML = cards.join('');
  }

  /* ------------------------------------------------------------------ */
  /* 示波器                                                             */
  /* ------------------------------------------------------------------ */
  function findStart(events, t0) {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].t < t0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function drawScope() {
    if (!scopeCtx) return;
    const rect = scopeCanvas.getBoundingClientRect();
    const w = Math.max(200, rect.width), h = Math.max(80, rect.height);
    const dpr = window.devicePixelRatio || 1;
    if (scopeCanvas.width !== Math.round(w * dpr) || scopeCanvas.height !== Math.round(h * dpr)) {
      scopeCanvas.width = Math.round(w * dpr);
      scopeCanvas.height = Math.round(h * dpr);
    }
    const ctx = scopeCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const win = parseFloat(scopeBaseSel.value) || 0.05;
    sys.scopeWindow = win;
    const t1 = Math.max(sys.t, win);
    const t0 = t1 - win;
    const events = sys.scopeEvents;
    const start = findStart(events, t0);

    // 背景
    ctx.fillStyle = '#040a08';
    ctx.fillRect(0, 0, w, h);

    // 网格
    ctx.strokeStyle = 'rgba(110,255,190,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = Math.round(i * w / 10) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    const rows = 4;
    const rh = h / rows;
    for (let i = 0; i <= rows; i++) {
      const y = Math.round(i * rh) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const colors = ['#37d6ff', '#76f0b0', '#ffc45c', '#ff6b8a'];
    const names = ['OUT0', 'OUT1', 'OUT2', 'IRQ0'];

    for (let ch = 0; ch < 4; ch++) {
      // 初始电平
      let level = 0;
      for (let i = start - 1; i >= 0; i--) {
        if (events[i].ch === ch) { level = events[i].level; break; }
      }
      const top = ch * rh + 12;
      const bot = (ch + 1) * rh - 12;
      const y = lv => lv ? top : bot;

      ctx.strokeStyle = colors[ch];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let lastX = 0;
      ctx.moveTo(0, y(level));
      for (let i = start; i < events.length; i++) {
        const e = events[i];
        if (e.ch !== ch) continue;
        if (e.t > t1) break;
        const x = Math.max(0, Math.min(w, (e.t - t0) / win * w));
        ctx.lineTo(x, y(level));
        level = e.level ? 1 : 0;
        ctx.lineTo(x, y(level));
        lastX = x;
      }
      ctx.lineTo(w, y(level));
      ctx.stroke();

      ctx.fillStyle = colors[ch];
      ctx.font = '9.5px Consolas, monospace';
      ctx.globalAlpha = 0.9;
      ctx.fillText(names[ch], 4, ch * rh + 10);
      ctx.globalAlpha = 1;
    }

    // 时间标注
    ctx.fillStyle = 'rgba(150,210,190,0.55)';
    ctx.font = '9px Consolas, monospace';
    ctx.fillText('−' + (win >= 1 ? win.toFixed(1) + ' s' : (win * 1000).toFixed(win < 0.01 ? 1 : 0) + ' ms'), 4, h - 3);
    ctx.fillText('0', w - 12, h - 3);
  }

  /* ------------------------------------------------------------------ */
  /* 主循环                                                             */
  /* ------------------------------------------------------------------ */
  function frame(ts) {
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.05) dt = 0.05;

    if (running && !paused) {
      sys.runForWallTime(dt, speed);
      if (sys.cpu.fault && !faultReported) {
        faultReported = true;
        running = false;
        paused = true;
        setStatus('运行错误', 'error');
        setButtons();
        logLine('✗ ' + sys.cpu.fault);
      }
    }

    renderBoard();
    if (ts - lastPanelTs > 140) { renderPanels(); lastPanelTs = ts; }
    if (ts - lastScopeTs > 40) { drawScope(); lastScopeTs = ts; }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                             */
  /* ------------------------------------------------------------------ */
  function init() {
    editor = $('#editor');
    gutter = $('#gutter');
    consoleEl = $('#console');
    errorsEl = $('#errors');
    sampleSel = $('#sampleSel');
    statusPill = $('#statusPill');
    statusText = $('#statusText');
    scopeCanvas = $('#scopeCanvas');
    scopeCtx = scopeCanvas.getContext('2d');
    scopeBaseSel = $('#scopeBase');

    buildDigits();
    buildMatrix();
    buildLeds();
    buildSwitches();
    buildWires();

    sys.adc.volts[0] = 2.5;
    sys.onOutput = text => appendLog(text);
    sys.onWarn = msg => logLine('[警告] ' + msg);
    sys.onFault = msg => { /* 主循环统一处理 */ };
    $('#adcRange').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      sys.adc.volts[0] = v;
      $('#adcVolt').textContent = v.toFixed(2) + ' V';
    });

    $('#an1').addEventListener('click', () => { sys.pulseAN1(); });
    $('#an2').addEventListener('click', () => { sys.pulseAN2(); });

    // 标签页
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
        $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + tab.dataset.tab));
      });
    });

    editor.addEventListener('input', updateGutter);
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = editor.selectionStart, t = editor.selectionEnd;
        editor.setRangeText('\t', s, t, 'end');
        updateGutter();
      }
    });

    // 内置示例
    const samples = window.SHYL_SAMPLES || [];
    samples.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sampleSel.appendChild(o);
    });
    sampleSel.addEventListener('change', () => {
      const s = samples.find(x => x.id === sampleSel.value);
      if (!s) return;
      setEditorText(s.source);
      sys.wiring = Object.assign({}, DEFAULT_WIRING, s.wiring || {});
      syncWireUI();
      sys.configureClocks();
      updateBoardTags();
      assembleAndRun();
      logLine('── 载入示例：' + s.name + ' ──');
      if (s.note) logLine('   ' + s.note);
    });

    // 按钮
    $('#btnRun').addEventListener('click', assembleAndRun);
    $('#btnPause').addEventListener('click', togglePause);
    $('#btnReset').addEventListener('click', resetMachine);
    $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = U.decodeSource(reader.result);
          setEditorText(text);
          logLine('── 已载入文件：' + f.name + ' ──');
          $('#btnRun').focus();
        } catch (err) {
          logLine('✗ 读取文件失败：' + err.message);
        }
      };
      reader.readAsArrayBuffer(f);
      e.target.value = '';
    });
    $('#btnSave').addEventListener('click', () => {
      const blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'program.asm';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#btnClearLog').addEventListener('click', () => { uiLog = ''; consoleEl.textContent = ''; });

    $('#cpuSel').addEventListener('change', e => {
      sys.setCpuHz(parseInt(e.target.value, 10));
      if (running) logLine('CPU 主频改为 ' + (sys.cpuHz / 1e6).toFixed(1) + ' MHz（复位后完全生效）');
    });
    $('#speedSel').addEventListener('change', e => {
      speed = parseFloat(e.target.value) || 1;
    });

    // 快捷键
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); assembleAndRun(); }
      else if (e.key === 'F5') { e.preventDefault(); togglePause(); }
      else if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); resetMachine(); }
    });

    // 窗口尺寸变化时重绘
    window.addEventListener('resize', () => { drawScope(); });

    // 首次载入考试模板
    const exam = samples.find(s => s.id === 'exam') || samples[0];
    if (exam) {
      setEditorText(exam.source);
      if (exam.wiring) sys.wiring = Object.assign({}, DEFAULT_WIRING, exam.wiring);
      syncWireUI();
      sys.configureClocks();
      updateBoardTags();
      logLine('SHYL-WJ86 在线模拟已启动。');
      logLine('已载入：' + exam.name);
      if (exam.note) logLine('   ' + exam.note);
      assembleAndRun();
    } else {
      setEditorText('; 在这里粘贴 8086 汇编代码，然后点“汇编并运行”\n');
      updateGutter();
      setStatus('待机', '');
    }

    setButtons();
    updateBoardTags();
    renderPanels();
    window.SHYL_DEBUG = { sys: sys, asm: asm };
    requestAnimationFrame(frame);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

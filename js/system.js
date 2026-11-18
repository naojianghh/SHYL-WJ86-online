/* SHYL-WJ86 在线模拟 —— 系统总线、自由接线与仿真主循环 */
(function (global) {
  'use strict';
  const SHYL = (global.SHYL = global.SHYL || {});
  const U = SHYL.U;

  const CLOCKS = {
    '1MHz': 1e6,
    '500kHz': 5e5,
    '100kHz': 1e5,
    '10kHz': 1e4,
    '1kHz': 1e3,
    '100Hz': 1e2,
    '10Hz': 10,
    '1Hz': 1
  };

  /* 自由接线表：每个“目的端”可接任意一个“信号源”。
     这里给出与实验箱默认接线一致的初始值。 */
  const PATCH_DEFAULT = {
    CLK0: '1MHz', CLK1: 'GND', CLK2: 'GND',
    GATE0: '+5V', GATE1: '+5V', GATE2: '+5V',
    IRQ0: 'OUT0', IRQ1: 'EOC', IRQ2: 'AN2', IRQ3: 'NC', IRQ4: 'NC', IRQ5: 'NC', IRQ6: 'NC', IRQ7: 'NC',
    PC0: 'K1', PC1: 'K2', PC2: 'K3', PC3: 'K4', PC4: 'K5', PC5: 'K6', PC6: 'K7', PC7: 'K8',
    L1: 'PB0', L2: 'PB1', L3: 'PB2', L4: 'PB3', L5: 'PB4', L6: 'PB5', L7: 'PB6', L8: 'PB7'
  };

  const STRUCT_DEFAULT = {
    matrixMode: false,
    digitReverse: false,
    digitPort: 'PC',
    invertSeg: false,
    invertDig: false,
    invertLed: false,
    invertRow: false,
    invertCol: false
  };

  class System {
    constructor() {
      this.mem = new Uint8Array(1 << 20);
      this.cpu = new SHYL.CPU8086(this);
      this.timers = [new SHYL.Timer8253(this, 0), new SHYL.Timer8253(this, 1), new SHYL.Timer8253(this, 2)];
      this.ppi = new SHYL.PPI8255(this);
      this.pic = new SHYL.PIC8259(this);
      this.adc = new SHYL.ADC0809(this);
      this.dac = new SHYL.DAC0832(this);
      this.seg = new SHYL.SegDisplay(8);
      this.matrix = new SHYL.DotMatrix();

      this.inputs = { PA: 0, PB: 0, PC: 0 };
      this.switches = new Array(12).fill(0);
      this.an1Level = 0;
      this.an2Level = 0;
      this.an1Until = 0;
      this.an2Until = 0;
      this.clkLevels = [-1, -1, -1];

      this.t = 0;
      this.cycles = 0;
      this.cpuHz = 4e6;
      this.tickInterval = 10e-6;

      this.wiring = Object.assign({}, STRUCT_DEFAULT, {
        patch: Object.assign({}, PATCH_DEFAULT)
      });

      this.program = null;
      this.initialData = null;
      this.dataSymbols = new Map();
      this.scopeEvents = [];
      this.scopeChannels = ['OUT0', 'OUT1', 'OUT2', 'IRQ0'];
      this.scopeLevels = { OUT0: 0, OUT1: 0, OUT2: 0, IRQ0: 0 };

      this.consoleText = '';
      this.warnings = [];
      this.onOutput = null;
      this.onWarn = null;
      this.onFault = null;
      this.lastStepCount = 0;

      this.resetChips();
    }

    resetChips() {
      for (const t of this.timers) t.reset();
      this.ppi.reset();
      this.pic.reset();
      this.adc.reset();
      this.dac.reset();
      this.seg.reset();
      this.matrix.reset();
      this.an1Level = this.an2Level = 0;
      this.an1Until = this.an2Until = 0;
      this.clkLevels = [-1, -1, -1];
      this.scopeEvents.length = 0;
      this.scopeLevels = { OUT0: 0, OUT1: 0, OUT2: 0, IRQ0: 0 };
      this.configureClocks();
    }

    /* ---------------- 接线 ---------------- */
    patch(key, value) {
      if (arguments.length === 1) return this.wiring.patch[key];
      this.wiring.patch[key] = value;
      this.configureClocks();
    }

    resetPatch() {
      this.wiring.patch = Object.assign({}, PATCH_DEFAULT);
      this.configureClocks();
    }

    /* 把旧版示例里的预设接线翻译成自由接线表 */
    applySampleWiring(w) {
      w = w || {};
      const s = this.wiring;
      s.matrixMode = !!w.matrixMode;
      s.digitReverse = !!w.digitReverse;
      s.digitPort = w.digitPort || 'PC';
      s.invertSeg = !!w.invertSeg;
      s.invertDig = !!w.invertDig;
      s.invertLed = !!w.invertLed;
      s.invertRow = !!w.invertRow;
      s.invertCol = !!w.invertCol;

      const p = Object.assign({}, PATCH_DEFAULT);
      if (w.clk0) p.CLK0 = w.clk0;
      if (w.gate0) p.GATE0 = w.gate0;
      if (w.gate1) p.GATE1 = w.gate1;
      if (w.gate2) p.GATE2 = w.gate2;
      if (w.out0Irq === false) p.IRQ0 = 'NC';
      if (w.out0Clk1) p.CLK1 = 'OUT0';
      if (w.out1Clk2) p.CLK2 = 'OUT1';
      if (w.out0Pc7) p.PC7 = 'OUT0';
      if (w.out1Pc0) p.PC0 = 'OUT1';
      if (w.out0Led) p.L1 = 'OUT0';
      if (w.out1Led) p.L1 = 'OUT1';
      if (w.out2Led) p.L1 = 'OUT2';
      if (w.adcIrq === false) p.IRQ1 = 'NC';
      if (w.an2Irq === false) p.IRQ2 = 'NC';
      if (w.ledPort === 'PA') {
        for (let i = 0; i < 8; i++) p['L' + (i + 1)] = 'PA' + i;
      }
      if (w.patch) Object.assign(p, w.patch);
      s.patch = p;
      this.configureClocks();
    }

    configureClocks() {
      const p = this.wiring.patch;
      for (let i = 0; i < 3; i++) {
        const src = p['CLK' + i];
        const hz = CLOCKS[src];
        const tm = this.timers[i];
        if (hz) {
          tm.clockType = 'internal';
          tm.clockFreq = hz;
        } else {
          tm.clockType = 'external';
        }
      }
      this.clkLevels = [-1, -1, -1];
    }

    /* ---------------- 信号电平 ---------------- */
    levelOf(src, t) {
      if (!src || src === 'NC' || src === 'GND') return 0;
      if (src === '+5V') return 1;
      if (CLOCKS[src]) {
        const f = CLOCKS[src];
        return (Math.floor((t || this.t) * f * 2) & 1) ? 1 : 0;
      }
      if (src === 'AN1') return this.an1Level ? 1 : 0;
      if (src === 'AN2') return this.an2Level ? 1 : 0;
      if (src === 'EOC') return this.adc.eoc ? 1 : 0;
      let m = /^OUT(\d)$/.exec(src);
      if (m) return this.timers[+m[1]].out ? 1 : 0;
      m = /^K(\d+)$/.exec(src);
      if (m) return this.switches[parseInt(m[1], 10) - 1] ? 1 : 0;
      m = /^P([ABC])(\d)$/.exec(src);
      if (m) return (this.ppi.out['P' + m[1]] >> parseInt(m[2], 10)) & 1;
      return 0;
    }

    getInputs() {
      let PA = 0, PB = 0, PC = 0;
      for (let i = 0; i < 8; i++) {
        if (this.switches[i]) { PA |= (1 << i); PB |= (1 << i); }
        if (this.levelOf(this.wiring.patch['PC' + i], this.t)) PC |= (1 << i);
      }
      return { PA: PA, PB: PB, PC: PC };
    }

    warn(msg) {
      this.warnings.push({ t: this.t, msg: msg });
      if (this.warnings.length > 100) this.warnings.shift();
      if (this.onWarn) this.onWarn(msg);
    }

    output(text) {
      this.consoleText += text;
      if (this.consoleText.length > 20000) this.consoleText = this.consoleText.slice(-20000);
      if (this.onOutput) this.onOutput(text);
    }

    load(program) {
      this.program = program;
      this.initialData = new Uint8Array(65536);
      this.initialData.set(program.data.subarray(0, Math.min(65536, program.dataLen)));
      this.dataSymbols.clear();
      for (const s of program.symbols) {
        if (s.kind === 'data') this.dataSymbols.set(s.name, s);
        if (s.kind === 'code') this.dataSymbols.set(s.name, s);
      }
      this.reset();
    }

    reset() {
      this.mem.fill(0);
      if (this.initialData) {
        this.mem.set(this.initialData, 0x1000 << 4);
      }
      this.cpu.reset(this.program || { code: [], entry: 0 });
      this.t = 0;
      this.cycles = 0;
      this.consoleText = '';
      this.warnings = [];
      this.resetChips();
      // 数据段写入后再清一次中断向量表，避免程序数据落在 0 段
      this.mem.fill(0, 0, 0x400);
      this.lastTickT = -1;
    }

    setCpuHz(hz) {
      this.cpuHz = hz;
    }

    setSwitch(i, v) {
      this.switches[i] = v ? 1 : 0;
    }

    pulseAN1() {
      this.an1Level = 1;
      this.an1Until = this.t + 0.002;
    }

    pulseAN2() {
      this.an2Level = 1;
      this.an2Until = this.t + 0.002;
    }

    /* ---------------- 端口译码 ---------------- */
    ioRead(port) {
      port &= 0xFFFF;
      if (port >= 0x200 && port <= 0x20F) {
        const idx = port & 3;
        if (idx < 3) return this.timers[idx].readCount();
        return 0;
      }
      if (port >= 0x210 && port <= 0x21F) return this.ppi.read(port & 3);
      if (port >= 0x230 && port <= 0x23F) return 0; // 8259 读 IRR/ISR 未实现
      if (port >= 0x250 && port <= 0x25F) return this.dac.value;
      if (port >= 0x260 && port <= 0x26F) {
        const v = this.adc.read();
        this.pic.setLine(1, this.levelOf(this.wiring.patch.IRQ1, this.t) ? 1 : 0);
        return v;
      }
      return 0xFF;
    }

    ioWrite(port, v) {
      port &= 0xFFFF;
      v &= 0xFF;
      if (port >= 0x200 && port <= 0x20F) {
        const idx = port & 3;
        if (idx === 3) {
          for (const t of this.timers) t.control(v);
        } else {
          this.timers[idx].writeCount(v);
        }
        return;
      }
      if (port >= 0x210 && port <= 0x21F) {
        this.ppi.write(port & 3, v);
        return;
      }
      if (port >= 0x230 && port <= 0x23F) {
        this.pic.write(port & 1, v);
        return;
      }
      if (port >= 0x250 && port <= 0x25F) {
        this.dac.write(v);
        return;
      }
      if (port >= 0x260 && port <= 0x26F) {
        this.adc.start(v, port & 7);
        return;
      }
      this.warn('访问了未译码的 I/O 端口 ' + U.hex(port, 4) + 'H');
    }

    /* ---------------- 芯片刷新 ---------------- */
    tick(t) {
      const w = this.wiring;
      const p = w.patch;

      if (this.an1Until && t >= this.an1Until) { this.an1Until = 0; this.an1Level = 0; }
      if (this.an2Until && t >= this.an2Until) { this.an2Until = 0; this.an2Level = 0; }

      // GATE 电平和外部时钟边沿（非 OUT 源）
      for (let i = 0; i < 3; i++) {
        this.timers[i].setGate(!!this.levelOf(p['GATE' + i], t), t);
        const src = p['CLK' + i];
        if (!CLOCKS[src] && !/^OUT\d$/.test(src)) {
          const lv = this.levelOf(src, t) ? 1 : 0;
          if (this.clkLevels[i] === 1 && lv === 0) this.timers[i].addEdges(1, t);
          this.clkLevels[i] = lv;
        }
      }

      // 计数器更新 + OUT 级联
      const res = [null, null, null];
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let i = 0; i < 3; i++) res[i] = this.timers[i].update(t);
        for (let i = 0; i < 3; i++) {
          const m = /^OUT(\d)$/.exec(p['CLK' + i]);
          if (m) {
            const j = +m[1];
            if (j !== i && res[j].falls > 0) {
              this.timers[i].addEdges(res[j].falls, t);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }

      this.adc.tick(t);

      // 8259 的 8 根中断输入
      for (let i = 0; i < 8; i++) {
        this.pic.setLine(i, this.levelOf(p['IRQ' + i], t) ? 1 : 0);
      }

      // 数码管 / 点阵扫描余辉
      const pa = this.ppi.out.PA, pb = this.ppi.out.PB, pc = this.ppi.out.PC;
      const digitSel = w.digitPort === 'PB' ? pb : pc;
      if (pa !== this.lastPA || digitSel !== this.lastPC) {
        this.seg.update(pa, digitSel, t, w.invertSeg, w.invertDig);
        this.lastPA = pa; this.lastPC = digitSel;
      }
      this.seg.tick(t);
      const colSel = w.invertCol ? (~pb & 0xFF) : pb;
      if (colSel !== this.lastMatrixPB && colSel !== 0 && (colSel & (colSel - 1)) === 0) {
        this.matrix.update(pa, pb, t, w.invertRow, w.invertCol);
      }
      this.lastMatrixPB = colSel;
      this.lastMatrixPA = pa;

      this.recordScope(t);
    }

    recordScope(t) {
      const levels = [this.timers[0].out, this.timers[1].out, this.timers[2].out, this.pic.lines[0]];
      for (let i = 0; i < levels.length; i++) {
        const name = this.scopeChannels[i];
        const lv = levels[i] ? 1 : 0;
        if (this.scopeLevels[name] !== lv) {
          this.scopeLevels[name] = lv;
          this.scopeEvents.push({ t: t, ch: i, level: lv });
        }
      }
      if (this.scopeEvents.length > 40000) this.scopeEvents.splice(0, 10000);
    }

    /* ---------------- 执行 ---------------- */
    stepOnce() {
      if (this.cpu.halted) {
        if (this.cpu.flags.IF && this.pic.peek() >= 0) {
          const vec = this.pic.ack();
          if (vec >= 0) {
            if (!this.cpu.serviceInterrupt(vec)) this.reportFault();
          }
        }
        return 0;
      }
      if (this.cpu.flags.IF && this.pic.peek() >= 0) {
        const vec = this.pic.ack();
        if (vec >= 0) {
          if (!this.cpu.serviceInterrupt(vec)) { this.reportFault(); return 0; }
        }
      }
      const c = this.cpu.step();
      if (this.cpu.fault) this.reportFault();
      if (c <= 0) return 0;
      this.cycles += c;
      this.t += c / this.cpuHz;
      if (this.t - this.lastTickT >= this.tickInterval || this.lastTickT < 0) {
        this.tick(this.t);
        this.lastTickT = this.t;
      }
      return c;
    }

    reportFault() {
      if (this.cpu.fault && this.onFault) this.onFault(this.cpu.fault);
    }

    runSeconds(seconds, maxSteps) {
      const targetCycles = Math.floor(seconds * this.cpuHz);
      let used = 0;
      let steps = 0;
      const limit = maxSteps || 5000000;
      while (used < targetCycles && steps < limit && !this.cpu.fault) {
        const c = this.stepOnce();
        if (c === 0) {
          if (this.cpu.halted) {
            const dt = Math.min(0.001, (targetCycles - used) / this.cpuHz);
            this.t += dt;
            this.cycles += Math.floor(dt * this.cpuHz);
            used += Math.floor(dt * this.cpuHz);
            this.tick(this.t);
            steps++;
            continue;
          }
          break;
        }
        used += c;
        steps++;
      }
      this.lastStepCount = steps;
      return { cycles: used, steps: steps };
    }

    runForWallTime(seconds, speed) {
      const budget = Math.max(0, seconds * this.cpuHz * (speed || 1));
      let used = 0;
      let steps = 0;
      const start = performance.now ? performance.now() : Date.now();
      while (used < budget && steps < 400000) {
        const c = this.stepOnce();
        if (c === 0) {
          if (this.cpu.halted && !this.cpu.fault) {
            const dt = Math.min(0.001, (budget - used) / this.cpuHz);
            if (dt <= 0) break;
            this.t += dt;
            const cyc = Math.floor(dt * this.cpuHz);
            this.cycles += cyc;
            used += cyc;
            this.tick(this.t);
            steps++;
            continue;
          }
          break;
        }
        used += c;
        steps++;
        if ((steps & 0x3FF) === 0) {
          const elapsed = (performance.now ? performance.now() : Date.now()) - start;
          if (elapsed > 28) break;
        }
      }
      this.lastStepCount = steps;
      return used;
    }

    /* ---------------- 快照 ---------------- */
    snapshot() {
      const cpu = this.cpu;
      const regs = {};
      for (const r of ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS']) regs[r] = cpu.regs[r];
      const w = this.wiring;
      const p = w.patch;

      let leds = 0;
      let allPB = true;
      for (let i = 0; i < 8; i++) {
        let v = this.levelOf(p['L' + (i + 1)], this.t) ? 1 : 0;
        if (p['L' + (i + 1)] !== 'PB' + i) allPB = false;
        if (w.invertLed) v = v ? 0 : 1;
        leds |= v << i;
      }
      const ledHidden = (w.digitPort === 'PB' || w.matrixMode) && allPB;

      return {
        t: this.t,
        cycles: this.cycles,
        regs: regs,
        ip: cpu.IP,
        flags: Object.assign({}, cpu.flags),
        halted: cpu.halted,
        fault: cpu.fault,
        timers: this.timers.map(t => t.describe()),
        ppi: this.ppi.describe(),
        pic: this.pic.describe(),
        adc: {
          ch: this.adc.channel, val: this.adc.result, volts: this.adc.volts[this.adc.channel],
          eoc: this.adc.eoc, converting: this.adc.converting, count: this.adc.conversions
        },
        dac: { value: this.dac.value, volts: this.dac.volts },
        seg: this.seg.render(this.t, w.digitReverse),
        matrix: this.matrix.render(this.t),
        leds: ledHidden ? 0 : leds,
        extLed: 0,
        switches: this.switches.slice(),
        scope: this.scopeEvents,
        scopeWindow: this.scopeWindow || 0.05,
        matrixMode: w.matrixMode
      };
    }

    readDataSymbol(name) {
      const sym = this.dataSymbols.get(name);
      if (!sym || sym.kind !== 'data') return null;
      if (sym.size === 2) return this.cpu.read16(0x1000, sym.off);
      return this.cpu.read8(0x1000, sym.off);
    }
  }

  SHYL.System = System;
  SHYL.PATCH_DEFAULT = PATCH_DEFAULT;
  SHYL.STRUCT_DEFAULT = STRUCT_DEFAULT;
  SHYL.CLOCKS = CLOCKS;
})(typeof window !== 'undefined' ? window : globalThis);

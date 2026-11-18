/* SHYL-WJ86 在线模拟 —— 系统总线、接线与仿真主循环 */
(function (global) {
  'use strict';
  const SHYL = (global.SHYL = global.SHYL || {});
  const U = SHYL.U;

  const CLOCKS = { '1MHz': 1e6, '500kHz': 5e5, '100kHz': 1e5 };

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
      this.an1Until = 0;
      this.an2Until = 0;
      this.ledExternal = 0;

      this.t = 0;
      this.cycles = 0;
      this.cpuHz = 4e6;
      this.tickInterval = 10e-6;

      this.wiring = {
        clk0: '1MHz',
        gate0: '+5V',
        gate1: '+5V',
        gate2: '+5V',
        out0Irq: true,
        out0Clk1: false,
        out1Clk2: false,
        out0Led: false,
        out1Led: false,
        out2Led: false,
        out0Pc7: false,
        out1Pc0: false,
        adcIrq: true,
        an2Irq: true,
        matrixMode: false,
        digitReverse: false,
        digitPort: 'PC',
        ledPort: 'PB',
        invertSeg: false,
        invertDig: false,
        invertLed: false,
        invertRow: false,
        invertCol: false
      };

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
      this.ledExternal = 0;
      this.an1Until = this.an2Until = 0;
      this.scopeEvents.length = 0;
      this.scopeLevels = { OUT0: 0, OUT1: 0, OUT2: 0, IRQ0: 0 };
      this.configureClocks();
    }

    configureClocks() {
      const w = this.wiring;
      if (w.clk0 === 'AN1') {
        this.timers[0].clockType = 'external';
      } else {
        this.timers[0].clockType = 'internal';
        this.timers[0].clockFreq = CLOCKS[w.clk0] || 1e6;
      }
      this.timers[1].clockType = w.out0Clk1 ? 'external' : 'internal';
      this.timers[1].clockFreq = 1e6;
      this.timers[2].clockType = w.out1Clk2 ? 'external' : 'internal';
      this.timers[2].clockFreq = 1e6;
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

    /* ------------------------------------------------------------------ */
    /* 端口译码                                                           */
    /* ------------------------------------------------------------------ */
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
        if (this.wiring.adcIrq) this.pic.setLine(1, 0);
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

    /* ------------------------------------------------------------------ */
    /* 接线与芯片刷新                                                     */
    /* ------------------------------------------------------------------ */
    gateFor(name) {
      if (name === '+5V') return true;
      const m = /^K(\d+)$/.exec(name);
      if (m) return !!this.switches[parseInt(m[1], 10) - 1];
      return true;
    }

    tick(t) {
      const w = this.wiring;
      this.timers[0].setGate(this.gateFor(w.gate0), t);
      this.timers[1].setGate(this.gateFor(w.gate1), t);
      this.timers[2].setGate(this.gateFor(w.gate2), t);

      // 8253 计数器 0
      const r0 = this.timers[0].update(t);
      if (w.out0Irq) this.pic.setLine(0, r0.level);
      if (w.out0Led) this.ledExternal = r0.level;
      if (w.out0Clk1) this.timers[1].addEdges(r0.falls, t);

      // 计数器 1
      const r1 = this.timers[1].update(t);
      if (w.out1Led) this.ledExternal = r1.level;
      if (w.out1Clk2) this.timers[2].addEdges(r1.falls, t);

      // 计数器 2
      const r2 = this.timers[2].update(t);
      if (w.out2Led) this.ledExternal = r2.level;

      // ADC
      this.adc.tick(t);
      if (w.adcIrq) this.pic.setLine(1, this.adc.eoc ? 1 : 0);

      // 按键脉冲
      if (this.an2Until && t >= this.an2Until) {
        this.an2Until = 0;
        if (w.an2Irq) this.pic.setLine(2, 0);
      }

      // 数码管 / 点阵扫描余辉
      const pa = this.ppi.out.PA, pb = this.ppi.out.PB, pc = this.ppi.out.PC;
      const digitSel = w.digitPort === 'PB' ? pb : pc;
      if (pa !== this.lastPA || digitSel !== this.lastPC) {
        this.seg.update(pa, digitSel, t, w.invertSeg, w.invertDig);
        this.lastPA = pa; this.lastPC = digitSel;
      }
      this.seg.tick(t);
      // 点阵：只在列选通变为“单列有效”时取行数据，避免 PA 先变、PB 未变时产生鬼影
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

    getInputs() {
      let PA = 0, PB = 0, PC = 0;
      for (let i = 0; i < 8; i++) {
        if (this.switches[i]) { PA |= (1 << i); PB |= (1 << i); PC |= (1 << i); }
      }
      if (this.wiring.out0Pc7) PC = (PC & 0x7F) | ((this.timers[0].out ? 1 : 0) << 7);
      if (this.wiring.out1Pc0) PC = (PC & 0xFE) | (this.timers[1].out ? 1 : 0);
      return { PA: PA, PB: PB, PC: PC };
    }

    pulseAN1() {
      if (this.wiring.clk0 === 'AN1') {
        this.timers[0].addEdges(1, this.t);
      } else {
        this.warn('AN1 未接到 CLK0，脉冲不影响 8253');
      }
    }

    pulseAN2() {
      this.an2Until = this.t + 0.002;
      if (this.wiring.an2Irq) this.pic.setLine(2, 1);
      else this.warn('AN2 未接到 IRQ2');
    }

    /* ------------------------------------------------------------------ */
    /* 执行                                                               */
    /* ------------------------------------------------------------------ */
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

    /* 运行指定虚拟秒数（无 UI 时用于测试） */
    runSeconds(seconds, maxSteps) {
      const targetCycles = Math.floor(seconds * this.cpuHz);
      let used = 0;
      let steps = 0;
      const limit = maxSteps || 5000000;
      while (used < targetCycles && steps < limit && !this.cpu.fault) {
        const c = this.stepOnce();
        if (c === 0) {
          // CPU 停顿：推进时间，仍让定时器工作
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

    /* 每帧按实际耗时推进 */
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

    /* ------------------------------------------------------------------ */
    /* 给 UI 用的快照                                                     */
    /* ------------------------------------------------------------------ */
    snapshot() {
      const cpu = this.cpu;
      const regs = {};
      for (const r of ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS']) regs[r] = cpu.regs[r];
      const w = this.wiring;
      const ledSrc = w.ledPort === 'PA' ? this.ppi.out.PA : this.ppi.out.PB;
      const ledHidden = (w.ledPort === 'PB' && (w.digitPort === 'PB' || w.matrixMode));
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
        seg: this.seg.render(this.t, this.wiring.digitReverse),
        matrix: this.matrix.render(this.t),
        leds: ledHidden ? 0 : ((w.invertLed ? ~ledSrc : ledSrc) & 0xFF),
        extLed: this.ledExternal,
        switches: this.switches.slice(),
        scope: this.scopeEvents,
        scopeWindow: this.scopeWindow || 0.05,
        matrixMode: this.wiring.matrixMode
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
})(typeof window !== 'undefined' ? window : globalThis);

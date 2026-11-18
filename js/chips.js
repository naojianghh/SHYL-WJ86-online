/* SHYL-WJ86 在线模拟 —— 接口芯片模型
 * 8253 定时/计数器、8255 并行口、8259 中断控制器、ADC0809、DAC0832
 * 以及数码管 / 点阵的“扫描余辉”模型。
 */
(function (global) {
  'use strict';
  const SHYL = (global.SHYL = global.SHYL || {});

  /* ==================================================================== */
  /* 8253 / 8254                                                          */
  /* ==================================================================== */
  class Timer8253 {
    constructor(system, index) {
      this.system = system;
      this.index = index;
      this.mode = 3;
      this.n = 0;
      this.reload = 0;
      this.wrMode = 3;
      this.bcd = false;
      this.writeState = 0;
      this.lowByte = 0;
      this.running = false;
      this.startT = 0;
      this.extEdges = 0;
      this.gate = true;
      this.out = 0;
      this.lastRises = 0;
      this.lastFalls = 0;
      this.pausedCounts = 0;
      this.clockFreq = 1e6;
      this.clockType = 'internal'; // 'internal' | 'external'
      this.warned = false;
    }

    reset() {
      this.mode = 3; this.n = 0; this.reload = 0; this.wrMode = 3; this.bcd = false;
      this.writeState = 0; this.lowByte = 0; this.running = false; this.startT = 0;
      this.extEdges = 0; this.gate = true; this.out = 0; this.lastRises = 0; this.lastFalls = 0;
      this.pausedCounts = 0;
    }

    control(v) {
      const sel = (v >> 6) & 3;
      if (sel !== this.index) return;
      this.mode = (v >> 1) & 7;
      this.wrMode = (v >> 4) & 3;
      this.bcd = !!(v & 1);
      this.writeState = 0;
      this.lowByte = 0;
      this.running = false;
      this.out = this.mode === 0 ? 0 : 1;
      if (this.bcd && !this.warned) {
        this.warned = true;
        this.system.warn('8253 计数器 ' + this.index + ' 设置了 BCD 计数，模拟器按二进制处理');
      }
    }

    writeCount(v) {
      v &= 0xFF;
      if (this.wrMode === 3) {
        if (this.writeState === 0) { this.lowByte = v; this.writeState = 1; }
        else {
          const n = (v << 8) | this.lowByte;
          this.writeState = 0;
          this.load(n);
        }
      } else if (this.wrMode === 1) {
        this.load(v);
      } else if (this.wrMode === 2) {
        this.load(v << 8);
      }
    }

    load(n) {
      if (n === 0) n = 65536;
      this.n = n;
      this.reload = n;
      this.startT = this.system.t;
      this.extEdges = 0;
      this.pausedCounts = 0;
      this.lastRises = 0;
      this.lastFalls = 0;
      this.running = true;
      this.out = this.mode === 0 ? 0 : (this.mode === 1 ? 0 : 1);
    }

    countsAt(t) {
      if (!this.running) return 0;
      if (this.clockType === 'external') return this.extEdges;
      if (!this.gate) return this.pausedCounts;
      return Math.max(0, Math.floor((t - this.startT) * this.clockFreq));
    }

    outAt(c) {
      const n = this.n || 65536;
      switch (this.mode) {
        case 0: return c >= n ? 1 : 0;
        case 1: return c >= n ? 1 : 0;
        case 2: return (c % n) === (n - 1) ? 0 : 1;
        case 3: {
          const half = Math.ceil(n / 2);
          return (c % n) < half ? 1 : 0;
        }
        case 4: return (c % n) === (n - 1) ? 0 : 1;
        case 5: return c >= n ? 1 : 0;
        default: return 0;
      }
    }

    risingAt(c) {
      const n = this.n || 65536;
      if (this.mode === 0 || this.mode === 1 || this.mode === 5) return c >= n ? 1 : 0;
      return Math.floor(c / n);
    }

    fallingAt(c) {
      const n = this.n || 65536;
      if (this.mode === 2 || this.mode === 4) {
        return c >= n - 1 ? Math.floor((c - (n - 1)) / n) + 1 : 0;
      }
      if (this.mode === 3) {
        const half = Math.ceil(n / 2);
        return c >= half ? Math.floor((c - half) / n) + 1 : 0;
      }
      return 0;
    }

    update(t) {
      if (!this.running) return { level: this.out, rises: 0, falls: 0, count: 0 };
      const c = this.countsAt(t);
      const level = this.outAt(c);
      const r = this.risingAt(c);
      const f = this.fallingAt(c);
      const out = { level: level, rises: r - this.lastRises, falls: f - this.lastFalls, count: c };
      this.lastRises = r;
      this.lastFalls = f;
      this.out = level;
      return out;
    }

    addEdges(k, t) {
      if (!this.running || !this.gate) return;
      if (k <= 0) return;
      this.extEdges += Math.min(k, 1000000);
    }

    setGate(g, t) {
      if (g === this.gate) return;
      if (!g) {
        this.pausedCounts = this.countsAt(t);
        this.gate = false;
      } else {
        this.gate = true;
        if (this.clockType === 'internal') {
          this.startT = t - this.pausedCounts / this.clockFreq;
        }
      }
    }

    readCount() {
      if (!this.running) return 0;
      const c = this.countsAt(this.system.t);
      const n = this.n || 65536;
      let remain;
      if (this.mode === 0) remain = Math.max(0, n - c);
      else remain = n - (c % n);
      if (remain === n) remain = 0;
      if (this.wrMode === 3) {
        const lo = remain & 0xFF;
        if (!this.readToggle) { this.readToggle = 1; return lo; }
        this.readToggle = 0;
        return (remain >> 8) & 0xFF;
      }
      return remain & 0xFF;
    }

    describe() {
      const n = this.n || 0;
      const c = this.countsAt(this.system.t);
      return {
        index: this.index, mode: this.mode, n: n, count: c,
        remain: this.mode === 0 ? Math.max(0, n - c) : (n ? n - (c % n) : 0),
        out: this.out, running: this.running, gate: this.gate,
        clock: this.clockType === 'external' ? '级联' : (this.clockFreq / 1e6).toFixed(3) + ' MHz'
      };
    }
  }

  /* ==================================================================== */
  /* 8255                                                                 */
  /* ==================================================================== */
  class PPI8255 {
    constructor(system) {
      this.system = system;
      this.control = 0x9B;
      this.out = { PA: 0, PB: 0, PC: 0 };
      this.dir = { PA: 'out', PB: 'out', PCU: 'out', PCL: 'out' };
      this.modeA = 0;
      this.modeB = 0;
      this.reset();
    }

    reset() {
      this.control = 0x9B;
      this.out = { PA: 0, PB: 0, PC: 0 };
      this.dir = { PA: 'out', PB: 'out', PCU: 'out', PCL: 'out' };
      this.modeA = 0; this.modeB = 0;
    }

    writeControl(v) {
      this.control = v & 0xFF;
      if (v & 0x80) {
        this.modeA = (v >> 5) & 3;
        this.modeB = (v >> 2) & 1;
        this.dir.PA = (v & 0x10) ? 'in' : 'out';
        this.dir.PCU = (v & 0x08) ? 'in' : 'out';
        this.dir.PB = (v & 0x02) ? 'in' : 'out';
        this.dir.PCL = (v & 0x01) ? 'in' : 'out';
        if (this.modeA !== 0 || this.modeB !== 0) {
          this.system.warn('8255 工作在方式 ' + this.modeA + '/' + this.modeB + '，模拟器按方式 0 的端口行为处理');
        }
      } else {
        // 位置位/复位：PC 的某一位
        const bit = (v >> 1) & 7;
        const val = v & 1;
        const mask = 1 << bit;
        if (val) this.out.PC |= mask;
        else this.out.PC &= ~mask & 0xFF;
      }
    }

    write(port, v) {
      v &= 0xFF;
      if (port === 0) { if (this.dir.PA === 'out') this.out.PA = v; }
      else if (port === 1) { if (this.dir.PB === 'out') this.out.PB = v; }
      else if (port === 2) {
        const upperOut = this.dir.PCU === 'out';
        const lowerOut = this.dir.PCL === 'out';
        let mask = 0, val = 0;
        if (lowerOut) { mask |= 0x0F; val |= v & 0x0F; }
        if (upperOut) { mask |= 0xF0; val |= v & 0xF0; }
        this.out.PC = (this.out.PC & ~mask & 0xFF) | val;
      } else {
        this.writeControl(v);
      }
    }

    read(port) {
      const inp = this.system.getInputs();
      if (port === 0) return this.dir.PA === 'out' ? this.out.PA : inp.PA;
      if (port === 1) return this.dir.PB === 'out' ? this.out.PB : inp.PB;
      if (port === 2) {
        let v = 0;
        if (this.dir.PCL === 'out') v |= this.out.PC & 0x0F; else v |= inp.PC & 0x0F;
        if (this.dir.PCU === 'out') v |= this.out.PC & 0xF0; else v |= inp.PC & 0xF0;
        return v;
      }
      return this.control;
    }

    describe() {
      return {
        control: this.control,
        PA: this.out.PA, PB: this.out.PB, PC: this.out.PC,
        paDir: this.dir.PA, pbDir: this.dir.PB, pcDir: this.dir.PCU + '/' + this.dir.PCL
      };
    }
  }

  /* ==================================================================== */
  /* 8259                                                                 */
  /* ==================================================================== */
  class PIC8259 {
    constructor(system) {
      this.system = system;
      this.reset();
    }

    reset() {
      this.base = 8;
      this.imr = 0xFF;
      this.irr = 0;
      this.isr = 0;
      this.edge = true;
      this.aeoi = false;
      this.single = true;
      this.needICW4 = false;
      this.expect = 0; // 0=OCW, 1=ICW2, 2=ICW3, 3=ICW4
      this.lines = [0, 0, 0, 0, 0, 0, 0, 0];
      this.autoRotate = false;
    }

    write(port, v) {
      v &= 0xFF;
      if (port === 0) {
        if (v & 0x10) {
          // ICW1：D3=1 电平触发，D3=0 边沿触发（实验程序的 13H 是边沿触发）
          this.edge = !(v & 0x08);
          this.single = !!(v & 0x02);
          this.needICW4 = !!(v & 0x01);
          this.imr = 0;
          this.irr = 0;
          this.isr = 0;
          this.expect = 1;
          this.lines = [0, 0, 0, 0, 0, 0, 0, 0];
        } else if (v & 0x20) {
          // OCW2：EOI
          if (v & 0x40) {
            const l = v & 7;
            this.isr &= ~(1 << l);
          } else {
            this.eoi();
          }
          if (v & 0x80) this.autoRotate = true;
        } else {
          // OCW3：读寄存器/查询，实验程序很少用
        }
        return;
      }
      // A0=1
      if (this.expect === 1) {
        this.base = v & 0xF8;
        this.expect = this.single ? (this.needICW4 ? 3 : 0) : 2;
      } else if (this.expect === 2) {
        // ICW3 级联寄存器
        this.expect = this.needICW4 ? 3 : 0;
      } else if (this.expect === 3) {
        this.aeoi = !!(v & 0x02);
        this.expect = 0;
      } else {
        this.imr = v;
      }
    }

    setLine(irq, level) {
      level = level ? 1 : 0;
      if (this.edge) {
        if (level && !this.lines[irq]) this.irr |= (1 << irq);
      } else {
        if (level) this.irr |= (1 << irq);
        else this.irr &= ~(1 << irq);
      }
      this.lines[irq] = level;
    }

    lowestBit(mask) {
      if (!mask) return -1;
      for (let i = 0; i < 8; i++) if (mask & (1 << i)) return i;
      return -1;
    }

    peek() {
      let pending = this.irr & ~this.imr & 0xFF;
      if (!pending) return -1;
      let irq = this.lowestBit(pending);
      if (this.isr) {
        const top = this.lowestBit(this.isr);
        if (irq >= top) return -1;
        if (this.isr & (1 << irq)) return -1;
      }
      return irq;
    }

    ack() {
      const irq = this.peek();
      if (irq < 0) return -1;
      this.irr &= ~(1 << irq);
      this.isr |= (1 << irq);
      if (this.aeoi) this.isr &= ~(1 << irq);
      return this.base + irq;
    }

    eoi() {
      const irq = this.lowestBit(this.isr);
      if (irq >= 0) this.isr &= ~(1 << irq);
    }

    describe() {
      return {
        base: this.base, imr: this.imr, irr: this.irr, isr: this.isr,
        edge: this.edge, aeoi: this.aeoi, pending: this.peek()
      };
    }
  }

  /* ==================================================================== */
  /* ADC0809                                                              */
  /* ==================================================================== */
  class ADC0809 {
    constructor(system) {
      this.system = system;
      this.volts = [0, 0, 0, 0, 0, 0, 0, 0];
      this.channel = 0;
      this.result = 0;
      this.converting = false;
      this.eocAt = 0;
      this.eoc = false;
      this.irq = false;
      this.conversions = 0;
    }

    reset() {
      this.channel = 0; this.result = 0; this.converting = false;
      this.eoc = false; this.irq = false; this.conversions = 0;
    }

    start(v, ch) {
      this.channel = ((ch === undefined ? 0 : ch) || (v & 7)) & 7;
      this.result = Math.round(this.volts[this.channel] / 5 * 255);
      this.result = Math.max(0, Math.min(255, this.result));
      this.converting = true;
      this.eoc = false;
      this.irq = false;
      this.eocAt = this.system.t + 100e-6;
      this.conversions++;
    }

    read() {
      const v = this.result;
      this.eoc = false;
      this.irq = false;
      return v;
    }

    tick(t) {
      if (this.converting && t >= this.eocAt) {
        this.converting = false;
        this.eoc = true;
        this.irq = true;
      }
    }
  }

  /* ==================================================================== */
  /* DAC0832                                                              */
  /* ==================================================================== */
  class DAC0832 {
    constructor(system) {
      this.system = system;
      this.value = 0;
      this.volts = -5;
      this.updates = 0;
    }

    reset() { this.value = 0; this.volts = -5; this.updates = 0; }

    write(v) {
      this.value = v & 0xFF;
      // SHYL-WJ86 的 0832 按双极性接法：U = 2*Uref*N/256 - 5，Uref=+5V
      this.volts = (10 * this.value / 256) - 5;
      this.updates++;
    }
  }

  /* ==================================================================== */
  /* 显示模型                                                             */
  /* ==================================================================== */
  class SegDisplay {
    constructor(n) {
      this.n = n || 8;
      this.segs = new Array(this.n).fill(0);
      this.last = new Array(this.n).fill(-1);
      this.bright = new Array(this.n).fill(0);
      this.blankAt = new Array(this.n).fill(-1);
    }

    reset() {
      this.segs.fill(0); this.last.fill(-1); this.bright.fill(0); this.blankAt.fill(-1);
    }

    /* 共阴数码管：PA 段码 a~g,dp；PC 位选，bit0 最右。
       扫描程序常常先把段码清 0 消隐、再送段码。消隐期间不能立刻覆盖上一位的
       段码，否则视觉暂留模型会把所有位都清空；这里延迟 200µs 再确认“真的熄灭”。 */
    update(pa, pc, t, invertSeg, invertDig) {
      const seg = (invertSeg ? (~pa) : pa) & 0xFF;
      for (let bit = 0; bit < this.n; bit++) {
        const on = invertDig ? !((pc >> bit) & 1) : !!((pc >> bit) & 1);
        if (!on) {
          // 该位已不再选中，之前记录的“消隐”不算数
          this.blankAt[bit] = -1;
          continue;
        }
        if (seg === 0) {
          if (this.blankAt[bit] < 0) this.blankAt[bit] = t;
        } else {
          this.segs[bit] = seg;
          this.last[bit] = t;
          this.blankAt[bit] = -1;
        }
      }
    }

    tick(t) {
      for (let bit = 0; bit < this.n; bit++) {
        if (this.blankAt[bit] >= 0 && t - this.blankAt[bit] > 200e-6) {
          this.segs[bit] = 0;
          this.blankAt[bit] = -1;
        }
      }
    }

    /* 返回从左到右每个数字的 {seg,on}。reverse=false 时 PC0 在最右 */
    render(t, reverse) {
      const out = [];
      for (let pos = 0; pos < this.n; pos++) {
        const bit = reverse ? pos : this.n - 1 - pos;
        const dt = t - this.last[bit];
        out.push({ seg: this.segs[bit], on: dt >= 0 && dt < 0.05 });
      }
      return out;
    }
  }

  class DotMatrix {
    constructor() {
      this.lastOn = [];
      for (let r = 0; r < 8; r++) this.lastOn.push(new Array(8).fill(-1));
    }

    reset() {
      for (let r = 0; r < 8; r++) this.lastOn[r].fill(-1);
    }

    /* PA = 行数据 R1~R8（PA7 最上一行），PB = 列选通 C1~C8（PB0 最左）。
       rotate 为显示方向：0/90/180/270 顺时针角度。 */
    update(pa, pb, t, invertRow, invertCol, rotate) {
      const rows = (invertRow ? ~pa : pa) & 0xFF;
      const cols = (invertCol ? ~pb : pb) & 0xFF;
      rotate = +rotate || 0;
      for (let r = 0; r < 8; r++) {
        if (!((rows >> (7 - r)) & 1)) continue;
        for (let c = 0; c < 8; c++) {
          if ((cols >> c) & 1) {
            let rr = r, cc = c;
            if (rotate === 90) { rr = c; cc = 7 - r; }
            else if (rotate === 180) { rr = 7 - r; cc = 7 - c; }
            else if (rotate === 270) { rr = 7 - c; cc = r; }
            this.lastOn[rr][cc] = t;
          }
        }
      }
    }

    render(t) {
      const out = [];
      for (let r = 0; r < 8; r++) {
        const row = [];
        for (let c = 0; c < 8; c++) {
          const dt = t - this.lastOn[r][c];
          const b = dt >= 0 ? Math.max(0, 1 - dt / 0.04) : 0;
          row.push(b);
        }
        out.push(row);
      }
      return out;
    }
  }

  SHYL.Timer8253 = Timer8253;
  SHYL.PPI8255 = PPI8255;
  SHYL.PIC8259 = PIC8259;
  SHYL.ADC0809 = ADC0809;
  SHYL.DAC0832 = DAC0832;
  SHYL.SegDisplay = SegDisplay;
  SHYL.DotMatrix = DotMatrix;
})(typeof window !== 'undefined' ? window : globalThis);

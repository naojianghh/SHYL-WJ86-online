/* SHYL-WJ86 在线模拟 —— 8086 实模式解释器
 *
 * IP 不是字节偏移，而是“指令序号”。代码段不参与内存寻址，只保存 CS 选择子，
 * 这样无需实现指令编码也能正确执行 CALL/RET/INT/IRET。
 */
(function (global) {
  'use strict';
  const SHYL = (global.SHYL = global.SHYL || {});
  const U = SHYL.U;

  const REG16 = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP'];
  const REG8 = ['AL', 'AH', 'BL', 'BH', 'CL', 'CH', 'DL', 'DH'];

  const JCC = {
    JA: f => !f.CF && !f.ZF, JNBE: f => !f.CF && !f.ZF,
    JAE: f => !f.CF, JNB: f => !f.CF, JNC: f => !f.CF,
    JB: f => f.CF, JC: f => f.CF, JNAE: f => f.CF,
    JBE: f => f.CF || f.ZF, JNA: f => f.CF || f.ZF,
    JE: f => f.ZF, JZ: f => f.ZF,
    JNE: f => !f.ZF, JNZ: f => !f.ZF,
    JG: f => !f.ZF && f.SF === f.OF, JNLE: f => !f.ZF && f.SF === f.OF,
    JGE: f => f.SF === f.OF, JNL: f => f.SF === f.OF,
    JL: f => f.SF !== f.OF, JNGE: f => f.SF !== f.OF,
    JLE: f => f.ZF || f.SF !== f.OF, JNG: f => f.ZF || f.SF !== f.OF,
    JS: f => f.SF, JNS: f => !f.SF,
    JO: f => f.OF, JNO: f => !f.OF,
    JP: f => f.PF, JPE: f => f.PF,
    JNP: f => !f.PF, JPO: f => !f.PF
  };

  class CPU8086 {
    constructor(system) {
      this.system = system;
      this.resetFlags();
      this.regs = { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, BP: 0, SP: 0xFFFE, CS: 0x3000, DS: 0, ES: 0, SS: 0x2000 };
      this.IP = 0;
      this.code = [];
      this.halted = false;
      this.fault = null;
      this.cycles = 0;
      this.ioLog = [];
    }

    resetFlags() {
      this.flags = { CF: false, PF: false, AF: false, ZF: false, SF: false, TF: false, IF: false, DF: false, OF: false };
    }

    reset(program) {
      this.regs = { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, BP: 0, SP: 0xFFFE, CS: 0x3000, DS: 0, ES: 0, SS: 0x2000 };
      this.resetFlags();
      this.code = program.code || [];
      this.IP = program.entry || 0;
      this.halted = false;
      this.fault = null;
      this.cycles = 0;
    }

    /* ---------------- 寄存器与内存 ---------------- */
    getR(name) {
      return this.regs[name] & 0xFFFF;
    }

    setR(name, v) {
      if (name === 'CS') return;
      this.regs[name] = v & 0xFFFF;
    }

    getR8(name) {
      const lo = name[1] === 'L' || name === 'AL' || name === 'BL' || name === 'CL' || name === 'DL';
      const base = { A: 'AX', B: 'BX', C: 'CX', D: 'DX' }[name[0]];
      const v = this.regs[base];
      return lo ? (v & 0xFF) : ((v >> 8) & 0xFF);
    }

    setR8(name, v) {
      const lo = name[1] === 'L';
      const base = { A: 'AX', B: 'BX', C: 'CX', D: 'DX' }[name[0]];
      v &= 0xFF;
      if (lo) this.regs[base] = (this.regs[base] & 0xFF00) | v;
      else this.regs[base] = (this.regs[base] & 0x00FF) | (v << 8);
    }

    read8(seg, off) {
      return this.system.mem[((seg << 4) + (off & 0xFFFF)) & 0xFFFFF];
    }

    write8(seg, off, v) {
      this.system.mem[((seg << 4) + (off & 0xFFFF)) & 0xFFFFF] = v & 0xFF;
    }

    read16(seg, off) {
      return this.read8(seg, off) | (this.read8(seg, (off + 1) & 0xFFFF) << 8);
    }

    write16(seg, off, v) {
      this.write8(seg, off, v & 0xFF);
      this.write8(seg, (off + 1) & 0xFFFF, (v >> 8) & 0xFF);
    }

    addr(mem) {
      let seg;
      if (mem.seg) seg = this.regs[mem.seg];
      else if (mem.base === 'BP' || mem.base === 'SP') seg = this.regs.SS;
      else seg = this.regs.DS;
      let off = mem.disp || 0;
      if (mem.base) off += this.regs[mem.base];
      if (mem.index) off += this.regs[mem.index];
      return { seg: seg & 0xFFFF, off: off & 0xFFFF };
    }

    offsetOf(mem) {
      let off = mem.disp || 0;
      if (mem.base) off += this.regs[mem.base];
      if (mem.index) off += this.regs[mem.index];
      return off & 0xFFFF;
    }

    readOp(o, size) {
      if (!o) return 0;
      if (o.kind === 'reg') return o.size === 1 ? this.getR8(o.name) : this.getR(o.name);
      if (o.kind === 'sreg') return this.regs[o.name] & 0xFFFF;
      if (o.kind === 'imm') return o.value & 0xFFFF;
      if (o.kind === 'mem') {
        const s = o.size || size || 2;
        const a = this.addr(o);
        if (s === 1) return this.read8(a.seg, a.off);
        return this.read16(a.seg, a.off);
      }
      return 0;
    }

    writeOp(o, v, size) {
      if (!o) return;
      if (o.kind === 'reg') {
        if (o.size === 1) this.setR8(o.name, v);
        else this.setR(o.name, v);
        return;
      }
      if (o.kind === 'sreg') {
        if (o.name !== 'CS') this.regs[o.name] = v & 0xFFFF;
        return;
      }
      if (o.kind === 'mem') {
        const s = o.size || size || 2;
        const a = this.addr(o);
        if (s === 1) this.write8(a.seg, a.off, v);
        else this.write16(a.seg, a.off, v);
        return;
      }
      throw new Error('立即数不能作为目的操作数');
    }

    sizeOf(o) {
      if (!o) return 2;
      if (o.kind === 'reg') return o.size;
      if (o.kind === 'sreg') return 2;
      if (o.kind === 'mem') return o.size || 2;
      return 2;
    }

    push(v) {
      this.regs.SP = (this.regs.SP - 2) & 0xFFFF;
      this.write16(this.regs.SS, this.regs.SP, v);
    }

    pop() {
      const v = this.read16(this.regs.SS, this.regs.SP);
      this.regs.SP = (this.regs.SP + 2) & 0xFFFF;
      return v;
    }

    /* ---------------- 标志位 ---------------- */
    flagsWord() {
      const f = this.flags;
      return 0xF002 |
        (f.CF ? 1 : 0) | (f.PF ? 4 : 0) | (f.AF ? 16 : 0) | (f.ZF ? 64 : 0) |
        (f.SF ? 128 : 0) | (f.TF ? 256 : 0) | (f.IF ? 512 : 0) |
        (f.DF ? 1024 : 0) | (f.OF ? 2048 : 0);
    }

    setFlagsWord(w) {
      const f = this.flags;
      f.CF = !!(w & 1); f.PF = !!(w & 4); f.AF = !!(w & 16); f.ZF = !!(w & 64);
      f.SF = !!(w & 128); f.TF = !!(w & 256); f.IF = !!(w & 512); f.DF = !!(w & 1024); f.OF = !!(w & 2048);
    }

    parity(v) {
      v &= 0xFF;
      let p = 0;
      while (v) { p ^= (v & 1); v >>= 1; }
      return p === 0;
    }

    setSZP(res, size) {
      const mask = size === 1 ? 0xFF : 0xFFFF;
      res &= mask;
      this.flags.ZF = res === 0;
      this.flags.SF = size === 1 ? !!(res & 0x80) : !!(res & 0x8000);
      this.flags.PF = this.parity(res);
      return res;
    }

    add(a, b, size, carry) {
      const mask = size === 1 ? 0xFF : 0xFFFF;
      const sign = size === 1 ? 0x80 : 0x8000;
      const c = carry ? 1 : 0;
      const r = (a + b + c) & mask;
      this.flags.CF = (a + b + c) > mask;
      this.flags.OF = !!(((a ^ r) & (b ^ r) & sign));
      this.flags.AF = !!(((a ^ b ^ r) & 0x10));
      return this.setSZP(r, size);
    }

    sub(a, b, size, borrow) {
      const mask = size === 1 ? 0xFF : 0xFFFF;
      const sign = size === 1 ? 0x80 : 0x8000;
      const c = borrow ? 1 : 0;
      const r = (a - b - c) & mask;
      this.flags.CF = (a - b - c) < 0;
      this.flags.OF = !!(((a ^ b) & (a ^ r) & sign));
      this.flags.AF = !!(((a ^ b ^ r) & 0x10));
      return this.setSZP(r, size);
    }

    logic(res, size) {
      this.flags.CF = false;
      this.flags.OF = false;
      this.flags.AF = false;
      return this.setSZP(res, size);
    }

    shift(op, v, count, size) {
      const bits = size === 1 ? 8 : 16;
      const mask = size === 1 ? 0xFF : 0xFFFF;
      const sign = size === 1 ? 0x80 : 0x8000;
      count = count & 0x1F;
      if (count === 0) return v & mask;
      v &= mask;
      let cf = this.flags.CF;
      let of = this.flags.OF;
      const old = v;
      for (let i = 0; i < count; i++) {
        switch (op) {
          case 'SHL': case 'SAL':
            cf = !!(v & sign); v = (v << 1) & mask;
            of = !!(v & sign) !== cf;
            break;
          case 'SHR':
            cf = !!(v & 1); v = v >>> 1;
            of = !!(old & sign);
            break;
          case 'SAR':
            cf = !!(v & 1); v = ((v >> 1) | (v & sign)) & mask;
            of = false;
            break;
          case 'ROL':
            cf = !!(v & sign); v = ((v << 1) | (cf ? 1 : 0)) & mask;
            of = !!(v & sign) !== cf;
            break;
          case 'ROR':
            cf = !!(v & 1); v = ((v >>> 1) | (cf ? sign : 0)) & mask;
            of = !!(v & sign) !== !!(v & (sign >> 1));
            break;
          case 'RCL':
            { const nc = !!(v & sign); v = ((v << 1) | (cf ? 1 : 0)) & mask; of = nc !== !!(v & sign); cf = nc; }
            break;
          case 'RCR':
            { const nc = !!(v & 1); v = ((v >>> 1) | (cf ? sign : 0)) & mask; of = !!(v & sign) !== !!(v & (sign >> 1)); cf = nc; }
            break;
        }
      }
      this.flags.CF = cf;
      this.flags.OF = of;
      this.setSZP(v, size);
      return v & mask;
    }

    cond(name) {
      const fn = JCC[name];
      return fn ? fn(this.flags) : false;
    }

    /* ---------------- 中断 ---------------- */
    serviceInterrupt(vector, fromPic) {
      const off = this.read16(0, (vector * 4) & 0xFFFF);
      const seg = this.read16(0, (vector * 4 + 2) & 0xFFFF);
      if (off === 0 && seg === 0) {
        this.halted = true;
        this.fault = '中断向量 ' + U.hex(vector, 2) + 'H 未安装（主程序没有写中断矢量）';
        return false;
      }
      this.push(this.flagsWord());
      this.push(this.regs.CS);
      this.push(this.IP);
      this.flags.IF = false;
      this.flags.TF = false;
      this.regs.CS = seg;
      this.IP = off;
      this.halted = false;
      this.cycles += 40;
      return true;
    }

    dos21() {
      const ah = (this.regs.AX >> 8) & 0xFF;
      if (ah === 0x09) {
        let addr = (this.regs.DS << 4) + this.regs.DX;
        let s = '';
        for (let i = 0; i < 4096; i++) {
          const ch = this.system.mem[(addr + i) & 0xFFFFF];
          if (ch === 0x24) break;
          s += String.fromCharCode(ch);
        }
        this.system.output(s.replace(/\r/g, ''));
      } else if (ah === 0x02) {
        this.system.output(String.fromCharCode(this.regs.DX & 0xFF));
      } else if (ah === 0x4C) {
        this.halted = true;
      } else if (ah === 0x01) {
        this.regs.AX = (this.regs.AX & 0xFF00) | 0x0D;
      }
    }

    softInt(n) {
      n &= 0xFF;
      if (n === 0x21) {
        const off = this.read16(0, 0x84);
        const seg = this.read16(0, 0x86);
        if (off === 0 && seg === 0) { this.dos21(); this.cycles += 30; return; }
      }
      if (n === 0x20) { this.halted = true; return; }
      this.push(this.flagsWord());
      this.push(this.regs.CS);
      this.push(this.IP);
      this.flags.IF = false;
      this.flags.TF = false;
      const off = this.read16(0, (n * 4) & 0xFFFF);
      const seg = this.read16(0, (n * 4 + 2) & 0xFFFF);
      if (off === 0 && seg === 0) {
        this.halted = true;
        this.fault = '中断向量 ' + U.hex(n, 2) + 'H 未安装';
        return;
      }
      this.regs.CS = seg;
      this.IP = off;
      this.cycles += 30;
    }

    /* ---------------- 主执行 ---------------- */
    step() {
      if (this.halted) return 0;
      const inst = this.code[this.IP];
      if (!inst) {
        this.halted = true;
        this.fault = '程序计数器超出范围（IP=' + this.IP + '）';
        return 0;
      }
      const startCycles = this.cycles;
      this.IP++;
      this.currentPrefix = inst.prefix || null;
      try {
        this.exec(inst);
      } catch (e) {
        this.halted = true;
        this.fault = '指令执行错误（第 ' + inst.line + ' 行 ' + inst.mnemonic + '）：' + e.message;
      }
      let cost = 4;
      if (inst.ops && inst.ops.some(o => o && o.kind === 'mem')) cost += 6;
      if (inst.mnemonic === 'MUL' || inst.mnemonic === 'IMUL') cost += 20;
      if (inst.mnemonic === 'DIV' || inst.mnemonic === 'IDIV') cost += 24;
      if (inst.mnemonic === 'INT' || inst.mnemonic === 'IRET') cost += 30;
      if (/^J/.test(inst.mnemonic) || inst.mnemonic === 'LOOP' || inst.mnemonic === 'CALL') cost += 4;
      this.cycles += cost;
      return cost;
    }

    exec(inst) {
      const m = inst.mnemonic;
      const ops = inst.ops || [];
      const a = ops[0], b = ops[1];
      const size = a ? this.sizeOf(a) : 2;

      switch (m) {
        case 'MOV': {
          if (a.kind === 'sreg') {
            if (a.name === 'CS') throw new Error('不能写入 CS');
            this.regs[a.name] = this.readOp(b, 2);
            return;
          }
          if (b.kind === 'sreg') {
            this.writeOp(a, this.regs[b.name], size);
            return;
          }
          if (a.kind === 'mem' && b.kind === 'mem') throw new Error('MOV 不支持内存到内存');
          this.writeOp(a, this.readOp(b, size), size);
          return;
        }
        case 'XCHG': {
          const tmp = this.readOp(a, size);
          this.writeOp(a, this.readOp(b, size), size);
          this.writeOp(b, tmp, size);
          return;
        }
        case 'LEA': {
          if (b.kind !== 'mem') throw new Error('LEA 需要内存操作数');
          this.writeOp(a, this.offsetOf(b), 2);
          return;
        }
        case 'LDS':
        case 'LES': {
          if (b.kind !== 'mem') throw new Error(m + ' 需要内存操作数');
          const at = this.addr(b);
          this.writeOp(a, this.read16(at.seg, at.off), 2);
          const segv = this.read16(at.seg, (at.off + 2) & 0xFFFF);
          this.regs[m === 'LDS' ? 'DS' : 'ES'] = segv;
          return;
        }
        case 'XLAT': {
          const at = (this.regs.DS << 4) + ((this.regs.BX + (this.regs.AX & 0xFF)) & 0xFFFF);
          this.regs.AX = (this.regs.AX & 0xFF00) | this.system.mem[at & 0xFFFFF];
          return;
        }
        case 'PUSH': {
          const v = a.kind === 'imm' ? (a.value & 0xFFFF) : this.readOp(a, 2);
          this.push(v);
          return;
        }
        case 'POP': {
          const v = this.pop();
          this.writeOp(a, v, 2);
          return;
        }
        case 'PUSHF': this.push(this.flagsWord()); return;
        case 'POPF': this.setFlagsWord(this.pop()); return;
        case 'LAHF': {
          const lo = this.flagsWord() & 0xFF;
          this.regs.AX = (this.regs.AX & 0xFF00) | lo;
          return;
        }
        case 'SAHF': {
          const w = (this.flagsWord() & 0xFF00) | (this.regs.AX & 0xFF);
          this.setFlagsWord(w);
          return;
        }
        case 'IN': {
          const port = b ? (b.kind === 'reg' ? this.readOp(b, 2) : b.value) : 0;
          this.writeOp(a, this.system.ioRead(port), a.size === 1 ? 1 : 2);
          return;
        }
        case 'OUT': {
          const port = a.kind === 'reg' ? this.readOp(a, 2) : a.value;
          const v = b.kind === 'reg' ? this.readOp(b, 1) : b.value;
          this.system.ioWrite(port & 0xFFFF, v & 0xFF);
          return;
        }
        case 'ADD': case 'ADC': case 'SUB': case 'SBB': case 'CMP': {
          const av = this.readOp(a, size);
          const bv = this.readOp(b, size);
          let r;
          const carry = m === 'ADC' ? this.flags.CF : (m === 'SBB' ? this.flags.CF : false);
          if (m === 'ADD' || m === 'ADC') r = this.add(av, bv, size, carry);
          else r = this.sub(av, bv, size, carry);
          if (m !== 'CMP') this.writeOp(a, r, size);
          return;
        }
        case 'INC': case 'DEC': {
          const av = this.readOp(a, size);
          const cf = this.flags.CF;
          const r = m === 'INC' ? this.add(av, 1, size, false) : this.sub(av, 1, size, false);
          this.flags.CF = cf;
          this.writeOp(a, r, size);
          return;
        }
        case 'NEG': {
          const av = this.readOp(a, size);
          const r = this.sub(0, av, size, false);
          this.flags.CF = av !== 0;
          this.writeOp(a, r, size);
          return;
        }
        case 'MUL': case 'IMUL': {
          const av = this.readOp(a, size);
          if (size === 1) {
            const r = (this.regs.AX & 0xFF) * av;
            this.regs.AX = r & 0xFFFF;
            this.flags.CF = this.flags.OF = (r & 0xFF00) !== 0;
          } else {
            const r = this.regs.AX * av;
            this.regs.AX = r & 0xFFFF;
            this.regs.DX = (r >> 16) & 0xFFFF;
            this.flags.CF = this.flags.OF = (r >> 16) !== 0;
          }
          return;
        }
        case 'DIV': case 'IDIV': {
          const av = this.readOp(a, size);
          if (av === 0) throw new Error('除数为 0');
          if (size === 1) {
            const n = this.regs.AX;
            const q = Math.floor(n / av), r = n % av;
            if (q > 0xFF) throw new Error('除法溢出');
            this.regs.AX = ((r & 0xFF) << 8) | (q & 0xFF);
            this.cycles += 20;
          } else {
            const n = ((this.regs.DX << 16) | this.regs.AX) >>> 0;
            const q = Math.floor(n / av), r = n % av;
            if (q > 0xFFFF) throw new Error('除法溢出');
            this.regs.AX = q & 0xFFFF;
            this.regs.DX = r & 0xFFFF;
            this.cycles += 30;
          }
          return;
        }
        case 'AND': case 'OR': case 'XOR': case 'TEST': {
          const av = this.readOp(a, size);
          const bv = this.readOp(b, size);
          let r;
          if (m === 'AND' || m === 'TEST') r = av & bv;
          else if (m === 'OR') r = av | bv;
          else r = av ^ bv;
          r = this.logic(r, size);
          if (m !== 'TEST') this.writeOp(a, r, size);
          return;
        }
        case 'NOT': {
          const av = this.readOp(a, size);
          this.writeOp(a, ~av & (size === 1 ? 0xFF : 0xFFFF), size);
          return;
        }
        case 'SHL': case 'SAL': case 'SHR': case 'SAR': case 'ROL': case 'ROR': case 'RCL': case 'RCR': {
          const av = this.readOp(a, size);
          let cnt;
          if (!b) cnt = 1;
          else if (b.kind === 'reg' && b.name === 'CL') cnt = this.regs.CX & 0xFF;
          else cnt = b.value & 0xFF;
          const r = this.shift(m, av, cnt, size);
          this.writeOp(a, r, size);
          return;
        }
        case 'JMP': {
          this.IP = this.jumpTarget(a);
          return;
        }
        case 'CALL': {
          this.push(this.IP);
          this.IP = this.jumpTarget(a);
          return;
        }
        case 'RET': {
          this.IP = this.pop();
          if (a && a.kind === 'imm') this.regs.SP = (this.regs.SP + (a.value & 0xFFFF)) & 0xFFFF;
          return;
        }
        case 'RETF': {
          this.IP = this.pop();
          this.regs.CS = this.pop();
          if (a && a.kind === 'imm') this.regs.SP = (this.regs.SP + (a.value & 0xFFFF)) & 0xFFFF;
          return;
        }
        case 'IRET': {
          this.IP = this.pop();
          this.regs.CS = this.pop();
          this.setFlagsWord(this.pop());
          return;
        }
        case 'INT': {
          this.softInt(a ? a.value : 0);
          return;
        }
        case 'INT3': this.softInt(3); return;
        case 'INTO': if (this.flags.OF) this.softInt(4); return;
        case 'LOOP': case 'LOOPE': case 'LOOPZ': case 'LOOPNE': case 'LOOPNZ': {
          this.regs.CX = (this.regs.CX - 1) & 0xFFFF;
          let take = this.regs.CX !== 0;
          if (m === 'LOOPE' || m === 'LOOPZ') take = take && this.flags.ZF;
          if (m === 'LOOPNE' || m === 'LOOPNZ') take = take && !this.flags.ZF;
          if (take) this.IP = this.jumpTarget(a);
          return;
        }
        case 'JCXZ': {
          if (this.regs.CX === 0) this.IP = this.jumpTarget(a);
          return;
        }
        case 'HLT': this.halted = true; return;
        case 'NOP': case 'WAIT': case 'LOCK': return;
        case 'CLI': this.flags.IF = false; return;
        case 'STI': this.flags.IF = true; return;
        case 'CLD': this.flags.DF = false; return;
        case 'STD': this.flags.DF = true; return;
        case 'CLC': this.flags.CF = false; return;
        case 'STC': this.flags.CF = true; return;
        case 'CMC': this.flags.CF = !this.flags.CF; return;
        case 'CBW': this.regs.AX = (this.regs.AX & 0x80) ? (this.regs.AX | 0xFF00) : (this.regs.AX & 0xFF); return;
        case 'CWD': this.regs.DX = (this.regs.AX & 0x8000) ? 0xFFFF : 0; return;
        case 'MOVSB': this.doString(1, 'MOV'); return;
        case 'MOVSW': this.doString(2, 'MOV'); return;
        case 'STOSB': this.doString(1, 'STOS'); return;
        case 'STOSW': this.doString(2, 'STOS'); return;
        case 'LODSB': this.doString(1, 'LODS'); return;
        case 'LODSW': this.doString(2, 'LODS'); return;
        case 'SCASB': this.doString(1, 'SCAS'); return;
        case 'SCASW': this.doString(2, 'SCAS'); return;
        case 'CMPSB': this.doString(1, 'CMPS'); return;
        case 'CMPSW': this.doString(2, 'CMPS'); return;
        case 'REP': case 'REPE': case 'REPZ': case 'REPNE': case 'REPNZ':
          return;
        default:
          if (JCC[m]) {
            if (this.cond(m)) this.IP = this.jumpTarget(a);
            return;
          }
          throw new Error('未实现的指令：' + m);
      }
    }

    jumpTarget(o) {
      if (!o) throw new Error('跳转缺少目标');
      if (o.kind === 'imm') return o.value;
      return this.readOp(o, 2);
    }

    doString(size, kind) {
      const prefix = this.currentPrefix;
      const rep = prefix === 'REP' || prefix === 'REPE' || prefix === 'REPZ' || prefix === 'REPNE' || prefix === 'REPNZ';
      const step = this.flags.DF ? -size : size;
      let count = rep ? (this.regs.CX & 0xFFFF) : 1;
      if (rep && count === 0) return;
      let guard = 0;
      while (count > 0 && guard++ < 0x100000) {
        if (size === 1) {
          const v = this.read8(this.regs.DS, this.regs.SI);
          if (kind === 'MOV') this.write8(this.regs.ES, this.regs.DI, v);
          else if (kind === 'STOS') this.write8(this.regs.ES, this.regs.DI, this.regs.AX & 0xFF);
          else if (kind === 'LODS') this.regs.AX = (this.regs.AX & 0xFF00) | v;
          else if (kind === 'SCAS') this.sub(this.regs.AX & 0xFF, this.read8(this.regs.ES, this.regs.DI), 1, false);
          else if (kind === 'CMPS') this.sub(v, this.read8(this.regs.ES, this.regs.DI), 1, false);
        } else {
          const v = this.read16(this.regs.DS, this.regs.SI);
          if (kind === 'MOV') this.write16(this.regs.ES, this.regs.DI, v);
          else if (kind === 'STOS') this.write16(this.regs.ES, this.regs.DI, this.regs.AX);
          else if (kind === 'LODS') this.regs.AX = v;
          else if (kind === 'SCAS') this.sub(this.regs.AX, this.read16(this.regs.ES, this.regs.DI), 2, false);
          else if (kind === 'CMPS') this.sub(v, this.read16(this.regs.ES, this.regs.DI), 2, false);
        }
        if (kind === 'MOV' || kind === 'LODS' || kind === 'CMPS') this.regs.SI = (this.regs.SI + step) & 0xFFFF;
        if (kind === 'MOV' || kind === 'STOS' || kind === 'SCAS' || kind === 'CMPS') this.regs.DI = (this.regs.DI + step) & 0xFFFF;
        count--;
        if (rep) {
          this.regs.CX = (this.regs.CX - 1) & 0xFFFF;
          if (prefix === 'REPE' || prefix === 'REPZ') { if (!this.flags.ZF) break; }
          if (prefix === 'REPNE' || prefix === 'REPNZ') { if (this.flags.ZF) break; }
        }
      }
      this.cycles += 8;
    }
  }

  SHYL.CPU8086 = CPU8086;
})(typeof window !== 'undefined' ? window : globalThis);

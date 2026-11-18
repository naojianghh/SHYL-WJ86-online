/* SHYL-WJ86 在线模拟 —— MASM 子集汇编器
 *
 * 只负责“把学生实验代码变成可执行的内部表示”，不生成机器码：
 *   - 代码标签解析成指令序号（CPU 的 IP 就是指令序号）
 *   - 数据标签解析成数据段内偏移
 *   - 段寄存器用固定选择子：CODE=3000H DATA=1000H STACK=2000H
 * 这样无需实现 8086 指令编码，也能完整跑通实验程序。
 */
(function (global) {
  'use strict';
  const SHYL = (global.SHYL = global.SHYL || {});

  const REG8 = { AL: 1, CL: 1, DL: 1, BL: 1, AH: 1, CH: 1, DH: 1, BH: 1 };
  const REG16 = { AX: 1, CX: 1, DX: 1, BX: 1, SP: 1, BP: 1, SI: 1, DI: 1 };
  const SREG = { ES: 1, CS: 1, SS: 1, DS: 1 };

  const MNEMONICS = new Set((
    'MOV XCHG LEA LDS LES XLAT PUSH POP PUSHF POPF LAHF SAHF ' +
    'IN OUT ADD ADC SUB SBB CMP INC DEC NEG MUL IMUL DIV IDIV ' +
    'DAA DAS AAA AAS AAM AAD AND OR XOR NOT TEST ' +
    'SHL SAL SHR SAR ROL ROR RCL RCR ' +
    'JMP JA JNBE JAE JNB JNC JB JC JNAE JBE JNA JCXZ JE JZ JG JNLE JGE JNL JL JNGE ' +
    'JLE JNG JNE JNZ JNO JNP JPO JNS JO JP JPE JS ' +
    'LOOP LOOPE LOOPZ LOOPNE LOOPNZ CALL RET RETF IRET INT INT3 INTO HLT NOP ' +
    'CLI STI CLD STD CLC STC CMC WAIT LOCK ' +
    'MOVSB MOVSW STOSB STOSW LODSB LODSW SCASB SCASW CMPSB CMPSW REP REPE REPZ REPNE REPNZ'
  ).split(/\s+/));

  const PREFIXES = new Set(['REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ', 'LOCK']);
  const DATA_OPS = new Set(['DB', 'DW', 'DD']);

  function splitTop(text, sep) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        cur += c;
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() !== '' || out.length) out.push(cur);
    return out.map(s => s.trim());
  }

  function stripComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === ';') {
        return line.slice(0, i);
      }
    }
    return line;
  }

  class Assembler {
    constructor() {
      this.reset();
    }

    reset() {
      this.errors = [];
      this.warnings = [];
      this.symbols = new Map();
      this.data = new Uint8Array(65536);
      this.dataLen = 0;
      this.dataDefs = [];
      this.code = [];
      this.instCount = 0;
      this.currentSeg = null;
      this.entryLabel = null;
      this.segSelectors = { CODE: 0x3000, DATA: 0x1000, STACK: 0x2000 };
      this.symbols.set('@DATA', { kind: 'equ', name: '@DATA', value: 0x1000 });
      this.symbols.set('@CODE', { kind: 'equ', name: '@CODE', value: 0x3000 });
      this.symbols.set('@STACK', { kind: 'equ', name: '@STACK', value: 0x2000 });
      this.defined = new Set();
    }

    error(line, msg) {
      this.errors.push({ line: line || 0, msg: msg });
    }

    warn(line, msg) {
      this.warnings.push({ line: line || 0, msg: msg });
    }

    /* ------------------------------------------------------------------ */
    /* 第一遍：识别标号、分配数据、给指令编号                             */
    /* ------------------------------------------------------------------ */
    pass1(source) {
      const lines = source.split(/\r?\n/);
      for (let ln = 0; ln < lines.length; ln++) {
        const lineNo = ln + 1;
        let s = stripComment(lines[ln]).trim();
        if (!s) continue;

        // 以点开头的伪指令
        if (s[0] === '.') {
          const dm = /^\.([A-Za-z0-9]+)\b\s*(.*)$/.exec(s);
          if (!dm) { this.error(lineNo, '无法识别的伪指令：' + s); continue; }
          const d = dm[1].toUpperCase();
          const arg = dm[2].trim();
          if (d === 'MODEL') { this.model = arg; continue; }
          if (d === 'STACK') { this.stackSize = arg || '100H'; continue; }
          if (d === 'DATA') { this.currentSeg = 'DATA'; continue; }
          if (d === 'CODE') { this.currentSeg = 'CODE'; continue; }
          if (d === '8086' || d === '386' || d === '486' || d === '586' || d === '686') { continue; }
          this.warn(lineNo, '忽略伪指令 .' + d);
          continue;
        }

        if (/^END\b/i.test(s)) {
          const m = /^END\b\s*([A-Za-z_@?$][\w@?$]*)?/i.exec(s);
          if (m && m[1]) this.entryLabel = m[1].toUpperCase();
          break;
        }

        if (/^ASSUME\b/i.test(s)) continue;
        if (/^PUBLIC\b/i.test(s) || /^EXTRN\b/i.test(s) || /^INCLUDE\b/i.test(s)) {
          this.warn(lineNo, '忽略伪指令 ' + s.split(/\s/)[0]);
          continue;
        }

        // 段定义
        let m = /^([A-Za-z_@?$][\w@?$]*)\s+SEGMENT\b(.*)$/i.exec(s);
        if (m) {
          const name = m[1].toUpperCase();
          this.currentSeg = name;
          if (name === 'DATA' || name === 'CODE' || name === 'STACK') {
            this.symbols.set(name, { kind: 'seg', name: name, value: this.segSelectors[name] });
          }
          continue;
        }
        m = /^([A-Za-z_@?$][\w@?$]*)\s+ENDS\b/i.exec(s);
        if (m) { this.currentSeg = null; continue; }

        // 标签（带冒号）与后续语句分开
        let label = null;
        let rest = s;
        m = /^([A-Za-z_@?$][\w@?$]*)\s*:\s*(.*)$/.exec(s);
        if (m) { label = m[1].toUpperCase(); rest = m[2].trim(); }

        // PROC / ENDP
        m = /^([A-Za-z_@?$][\w@?$]*)\s+PROC\b(.*)$/i.exec(rest);
        if (m) {
          if (label) this.error(lineNo, '一行里出现两个标号');
          this.defineCodeLabel(m[1].toUpperCase(), lineNo);
          continue;
        }
        m = /^([A-Za-z_@?$][\w@?$]*)\s+ENDP\b/i.exec(rest);
        if (m) continue;

        // 常量定义
        m = /^([A-Za-z_@?$][\w@?$]*)\s+EQU\s+(.+)$/i.exec(rest);
        if (m) {
          const name = m[1].toUpperCase();
          const sym = { kind: 'equ', name: name, expr: m[2], line: lineNo };
          this.symbols.set(name, sym);
          try { sym.value = this.evalExpr(m[2], lineNo); } catch (e) { /* 第二遍再算 */ }
          continue;
        }

        // 数据定义
        m = /^(?:([A-Za-z_@?$][\w@?$]*)\s+)?(DB|DW|DD)\s+(.+)$/i.exec(rest);
        if (m) {
          const name = m[1] ? m[1].toUpperCase() : (label || null);
          const op = m[2].toUpperCase();
          const items = this.parseDataItems(m[3], lineNo);
          const size = this.itemsSize(items, op, lineNo);
          const off = this.dataLen;
          if (this.dataLen + size > 65536) {
            this.error(lineNo, '数据段超过 64KB');
          }
          if (name) {
            this.defineDataLabel(name, off, op === 'DW' || op === 'DD' ? (op === 'DW' ? 2 : 4) : 1, lineNo);
          }
          this.dataDefs.push({ off: off, op: op, items: items, line: lineNo });
          this.dataLen = Math.min(65536, this.dataLen + size);
          if (this.dataLen > 65535) this.dataLen = 65536;
          continue;
        }

        // 一般指令
        let mnem = null;
        let ops = '';
        m = /^([A-Za-z][A-Za-z0-9]*)\b\s*(.*)$/.exec(rest);
        if (m) {
          const cand = m[1].toUpperCase();
          if (MNEMONICS.has(cand) || PREFIXES.has(cand)) {
            mnem = cand;
            ops = m[2];
          }
        }
        if (mnem === null && rest) {
          // 无冒号标号：HERE JMP $ 这种写法
          const m2 = /^([A-Za-z_@?$][\w@?$]*)\s+([A-Za-z][A-Za-z0-9]*)\b\s*(.*)$/.exec(rest);
          if (m2 && (MNEMONICS.has(m2[2].toUpperCase()) || PREFIXES.has(m2[2].toUpperCase()))) {
            if (!label) label = m2[1].toUpperCase();
            mnem = m2[2].toUpperCase();
            ops = m2[3];
          }
        }
        if (mnem === null) {
          if (label) {
            this.defineCodeLabel(label, lineNo);
          } else {
            this.error(lineNo, '无法识别的语句：' + s);
          }
          continue;
        }

        if (label) this.defineCodeLabel(label, lineNo);
        this.code.push({
          line: lineNo,
          text: rest,
          mnemonic: mnem,
          index: this.instCount++
        });
      }

      // 把 @DATA 指向真正的 DATA 段
      this.symbols.set('@DATA', { kind: 'equ', name: '@DATA', value: this.segSelectors.DATA });
      this.symbols.set('@CODE', { kind: 'equ', name: '@CODE', value: this.segSelectors.CODE });
    }

    defineCodeLabel(name, line) {
      if (this.symbols.has(name)) {
        // 允许 PROC 与前面标号同名（很少见），忽略重复
        const old = this.symbols.get(name);
        if (old.kind === 'code') return;
        this.error(line, '符号重复定义：' + name);
        return;
      }
      this.symbols.set(name, { kind: 'code', name: name, index: this.instCount, line: line });
    }

    defineDataLabel(name, off, size, line) {
      if (this.symbols.has(name)) {
        this.error(line, '符号重复定义：' + name);
        return;
      }
      this.symbols.set(name, { kind: 'data', name: name, off: off, size: size, seg: 'DATA', line: line });
    }

    parseDataItems(text, line) {
      const parts = splitTop(text, ',');
      const items = [];
      for (let p of parts) {
        p = p.trim();
        if (!p) continue;
        let m = /^(.+?)\s+DUP\s*\((.*)\)$/i.exec(p);
        if (m) {
          const count = this.evalExpr(m[1], line);
          const inner = this.parseDataItems(m[2], line);
          items.push({ kind: 'dup', count: count, items: inner, line: line });
          continue;
        }
        if (p === '?') { items.push({ kind: 'num', value: 0, line: line }); continue; }
        if ((p[0] === "'" && p[p.length - 1] === "'") || (p[0] === '"' && p[p.length - 1] === '"')) {
          items.push({ kind: 'str', value: p.slice(1, -1), line: line });
          continue;
        }
        items.push({ kind: 'expr', text: p, line: line });
      }
      return items;
    }

    itemsSize(items, op, line) {
      const unit = op === 'DD' ? 4 : op === 'DW' ? 2 : 1;
      let total = 0;
      for (const it of items) {
        if (it.kind === 'str') total += it.value.length * (op === 'DW' ? 2 : 1);
        else if (it.kind === 'dup') total += it.count * this.itemsSize(it.items, op, line);
        else total += unit;
      }
      return total;
    }

    /* ------------------------------------------------------------------ */
    /* 表达式求值                                                          */
    /* ------------------------------------------------------------------ */
    tokenizeExpr(text) {
      const toks = [];
      let i = 0;
      const s = text.trim();
      while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "'" || c === '"') {
          let j = s.indexOf(c, i + 1);
          if (j < 0) throw new Error('引号未闭合');
          const str = s.slice(i + 1, j);
          toks.push({ t: 'num', v: str.length ? str.charCodeAt(0) : 0 });
          i = j + 1;
          continue;
        }
        let m = /^0[xX][0-9A-Fa-f]+/.exec(s.slice(i));
        if (m) { toks.push({ t: 'num', v: parseInt(m[0], 16) }); i += m[0].length; continue; }
        m = /^[0-9][0-9A-Fa-f]*[hH]/.exec(s.slice(i));
        if (m) { toks.push({ t: 'num', v: parseInt(m[0].slice(0, -1), 16) }); i += m[0].length; continue; }
        m = /^[01]+[bB](?![A-Za-z0-9_])/.exec(s.slice(i));
        if (m) { toks.push({ t: 'num', v: parseInt(m[0].slice(0, -1), 2) }); i += m[0].length; continue; }
        m = /^[0-9]+/.exec(s.slice(i));
        if (m) { toks.push({ t: 'num', v: parseInt(m[0], 10) }); i += m[0].length; continue; }
        m = /^[A-Za-z_@?$][\w@?$]*/.exec(s.slice(i));
        if (m) {
          const id = m[0].toUpperCase();
          toks.push({ t: 'id', v: id });
          i += m[0].length;
          continue;
        }
        if ('+-*/()%'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
        throw new Error('表达式中有非法字符：' + c);
      }
      return toks;
    }

    evalExpr(text, line) {
      const toks = this.tokenizeExpr(text);
      let pos = 0;
      const peek = () => toks[pos];
      const eat = (v) => {
        const t = toks[pos];
        if (t && (t.v === v || (t.t === 'id' && t.v === v))) { pos++; return true; }
        return false;
      };
      const resolve = (name) => {
        const sym = this.symbols.get(name);
        if (!sym) throw new Error('未定义的符号：' + name);
        if (sym.kind === 'equ') {
          if (sym.value === undefined) {
            if (sym.busy) throw new Error('循环定义：' + name);
            sym.busy = true;
            sym.value = this.evalExpr(sym.expr, sym.line);
            sym.busy = false;
          }
          return sym.value;
        }
        if (sym.kind === 'data') return sym.off;
        if (sym.kind === 'code') return sym.index;
        if (sym.kind === 'seg') return sym.value;
        throw new Error('符号无法用于表达式：' + name);
      };
      const primary = () => {
        const t = toks[pos++];
        if (!t) throw new Error('表达式不完整');
        if (t.t === 'num') return t.v;
        if (t.t === 'id') {
          if (t.v === 'OFFSET') {
            const n = toks[pos++];
            if (!n || n.t !== 'id') throw new Error('OFFSET 后缺符号');
            return resolve(n.v);
          }
          if (t.v === 'SEG') {
            const n = toks[pos++];
            if (!n || n.t !== 'id') throw new Error('SEG 后缺符号');
            const sym = this.symbols.get(n.v);
            if (!sym) throw new Error('未定义的符号：' + n.v);
            if (sym.kind === 'data') return this.segSelectors[sym.seg] || 0;
            if (sym.kind === 'code') return this.segSelectors.CODE;
            if (sym.kind === 'seg') return sym.value;
            throw new Error('SEG 需要段内符号');
          }
          if (t.v === '$') return 0;
          return resolve(t.v);
        }
        if (t.v === '(') {
          const v = expr();
          if (!eat(')')) throw new Error('缺少右括号');
          return v;
        }
        if (t.v === '-') return -primary();
        if (t.v === '+') return primary();
        if (t.v === 'NOT') return ~primary();
        throw new Error('表达式语法错误');
      };
      const term = () => {
        let v = primary();
        while (pos < toks.length) {
          const t = toks[pos];
          if (t.v === '*') { pos++; v = v * primary(); }
          else if (t.v === '/') { pos++; const d = primary(); v = d === 0 ? 0 : Math.trunc(v / d); }
          else if (t.v === '%' || (t.t === 'id' && t.v === 'MOD')) { pos++; const d = primary(); v = d === 0 ? 0 : v % d; }
          else if (t.t === 'id' && t.v === 'SHL') { pos++; v = v << primary(); }
          else if (t.t === 'id' && t.v === 'SHR') { pos++; v = v >>> primary(); }
          else if (t.t === 'id' && t.v === 'AND') { pos++; v = v & primary(); }
          else if (t.t === 'id' && t.v === 'OR') { pos++; v = v | primary(); }
          else if (t.t === 'id' && t.v === 'XOR') { pos++; v = v ^ primary(); }
          else break;
        }
        return v;
      };
      const expr = () => {
        let v = term();
        while (pos < toks.length) {
          const t = toks[pos];
          if (t.v === '+') { pos++; v = v + term(); }
          else if (t.v === '-') { pos++; v = v - term(); }
          else break;
        }
        return v;
      };
      const v = expr();
      if (pos !== toks.length) throw new Error('表达式多余内容：' + text);
      return v;
    }

    tryEval(text, line) {
      try { return this.evalExpr(text, line); }
      catch (e) { this.error(line, e.message); return 0; }
    }

    /* ------------------------------------------------------------------ */
    /* 第二遍：解析操作数                                                  */
    /* ------------------------------------------------------------------ */
    pass2() {
      // 先写数据
      for (const def of this.dataDefs) {
        try { this.writeData(def.op, def.off, def.items, def.line); }
        catch (e) { this.error(def.line, e.message); }
      }

      for (const inst of this.code) {
        try { this.buildInstruction(inst); }
        catch (e) { this.error(inst.line, e.message); }
      }
    }

    writeData(op, off, items, line) {
      const unit = op === 'DD' ? 4 : op === 'DW' ? 2 : 1;
      let p = off;
      const put = (v) => {
        if (p + unit > 65536) throw new Error('数据越界');
        for (let i = 0; i < unit; i++) {
          this.data[p++] = (v >> (8 * i)) & 0xFF;
        }
      };
      const walk = (list) => {
        for (const it of list) {
          if (it.kind === 'str') {
            if (op === 'DW') {
              for (const ch of it.value) put(ch.charCodeAt(0));
            } else {
              for (const ch of it.value) {
                if (p >= 65536) throw new Error('数据越界');
                this.data[p++] = ch.charCodeAt(0) & 0xFF;
              }
            }
          } else if (it.kind === 'dup') {
            const n = it.count | 0;
            for (let k = 0; k < n; k++) walk(it.items);
          } else if (it.kind === 'num') {
            put(it.value);
          } else {
            put(this.evalExpr(it.text, it.line || line));
          }
        }
      };
      walk(items);
    }

    buildInstruction(inst) {
      let text = inst.text.trim();
      let prefix = null;
      let m = /^(REP|REPE|REPZ|REPNE|REPNZ|LOCK)\b\s*(.*)$/i.exec(text);
      if (m) { prefix = m[1].toUpperCase(); text = m[2].trim(); }

      m = /^([A-Za-z][A-Za-z0-9]*)\b\s*(.*)$/.exec(text);
      if (!m) throw new Error('缺少指令助记符');
      let mn = m[1].toUpperCase();
      const opText = m[2].trim();
      if (PREFIXES.has(mn)) {
        prefix = mn;
        const m2 = /^([A-Za-z][A-Za-z0-9]*)\b\s*(.*)$/.exec(opText);
        if (!m2) throw new Error('前缀后缺少指令');
        mn = m2[1].toUpperCase();
        inst.text = m2[2];
        inst.prefix = prefix;
      }
      if (!MNEMONICS.has(mn)) throw new Error('不支持的指令：' + mn);
      inst.mnemonic = mn;
      inst.prefix = prefix;

      const parts = splitTop(opText, ',');
      if (parts.length === 1 && parts[0] === '') parts.length = 0;
      if (parts.some(p => p === '')) throw new Error('操作数缺失');
      if (parts.length > 3) throw new Error('操作数过多');

      let ops = parts.map(p => this.parseOperand(p, inst));
      this.reconcileSizes(mn, ops);
      inst.ops = ops;
    }

    reconcileSizes(mn, ops) {
      if (!ops.length) return;
      let size = 0;
      for (const o of ops) {
        if (!o) continue;
        if (o.kind === 'reg') size = o.size;
        else if (o.kind === 'sreg') size = 2;
      }
      if (!size) {
        for (const o of ops) {
          if (o && o.kind === 'mem' && o.size) size = o.size;
        }
      }
      if (!size) {
        if (mn === 'PUSH' || mn === 'POP' || mn === 'CALL' || mn === 'JMP' || /^J/.test(mn) || mn === 'LOOP') size = 2;
        else size = 1;
      }
      for (const o of ops) {
        if (o && o.kind === 'mem' && !o.size) o.size = size;
      }
    }

    parseOperand(text, inst) {
      text = (text || '').trim();
      if (!text) return null;
      let size = 0;

      let m = /^(BYTE|WORD|DWORD)\s+PTR\s+(.*)$/i.exec(text);
      if (m) {
        size = m[1].toUpperCase() === 'BYTE' ? 1 : m[1].toUpperCase() === 'WORD' ? 2 : 4;
        text = m[2].trim();
      }

      const up = text.toUpperCase();
      if (REG8[up]) return { kind: 'reg', name: up, size: 1 };
      if (REG16[up]) return { kind: 'reg', name: up, size: 2 };
      if (SREG[up]) return { kind: 'sreg', name: up, size: 2 };

      let segOverride = null;
      m = /^(ES|CS|DS|SS)\s*:\s*(.*)$/i.exec(text);
      if (m) {
        segOverride = m[1].toUpperCase();
        text = m[2].trim();
      }

      if (text.indexOf('[') >= 0) {
        return this.parseMem(text, segOverride, size, inst);
      }

      // 不带方括号：可能是数据标号（直接寻址）、段名、常量或标号
      const name = text.toUpperCase();
      const sym = this.symbols.get(name);
      if (sym) {
        if (sym.kind === 'data') {
          return { kind: 'mem', base: null, index: null, disp: sym.off, seg: segOverride, size: size || sym.size, direct: true, symbol: sym.name };
        }
        if (sym.kind === 'code') {
          if (inst.mnemonic === 'JMP' || inst.mnemonic === 'CALL' || /^J[A-Z]/.test(inst.mnemonic) ||
              /^LOOP/.test(inst.mnemonic)) {
            return { kind: 'imm', value: sym.index, size: 2, symbol: sym.name };
          }
          return { kind: 'imm', value: sym.index, size: 2, symbol: sym.name };
        }
        if (sym.kind === 'seg') return { kind: 'imm', value: sym.value, size: 2, symbol: sym.name };
        if (sym.kind === 'equ') {
          if (sym.value === undefined) {
            try { sym.value = this.evalExpr(sym.expr, sym.line); } catch (e) { /* 交给下面统一报错 */ }
          }
          return { kind: 'imm', value: sym.value, size: 2, symbol: sym.name };
        }
      }

      if (/^(OFFSET|SEG)\b/i.test(text) || /^[-+(0-9'"]/.test(text)) {
        return { kind: 'imm', value: this.evalExpr(text, inst.line), size: 0 };
      }

      // 最后再试表达式
      return { kind: 'imm', value: this.evalExpr(text, inst.line), size: 0 };
    }

    parseMem(text, segOverride, size, inst) {
      let outer = '';
      let inner = '';
      const lb = text.indexOf('[');
      const rb = text.lastIndexOf(']');
      if (rb < lb) throw new Error('方括号不匹配：' + text);
      if (lb === 0) {
        inner = text.slice(1, rb);
      } else {
        outer = text.slice(0, lb).trim();
        inner = text.slice(lb + 1, rb);
      }
      let disp = 0;
      if (outer) disp += this.evalExpr(outer, inst.line);

      let base = null, index = null;
      const expr = inner.replace(/\s+/g, '');
      if (expr) {
        const parts = expr.replace(/-/g, '+-').split('+').filter(Boolean);
        for (let part of parts) {
          let sign = 1;
          while (part.startsWith('-')) { sign = -sign; part = part.slice(1); }
          if (!part) continue;
          const u = part.toUpperCase();
          if (u === 'BX' || u === 'BP') {
            if (sign < 0) throw new Error('基址寄存器不能为负：' + u);
            if (base) throw new Error('重复的基址寄存器');
            base = u;
          } else if (u === 'SI' || u === 'DI') {
            if (sign < 0) throw new Error('变址寄存器不能为负：' + u);
            if (index) throw new Error('重复的变址寄存器');
            index = u;
          } else {
            disp += sign * this.evalExpr(part, inst.line);
          }
        }
        if (base && (base === 'BX' ? !(index === null || index === 'SI' || index === 'DI') : !(index === null || index === 'SI' || index === 'DI'))) {
          throw new Error('非法的基址/变址组合');
        }
        if (index && !base) {
          // [SI+DI] 之类不允许；单独的 SI/DI 是合法的
          if (index !== 'SI' && index !== 'DI') throw new Error('非法变址');
        }
        if (base === 'BP' && index === 'SI') { /* 合法 */ }
      }
      // 归一化：把 SI/DI 放到 index
      if (base === 'SI' || base === 'DI') {
        if (index) throw new Error('非法寻址组合');
        index = base;
        base = null;
      }
      return {
        kind: 'mem', base: base, index: index, disp: disp & 0xFFFF,
        seg: segOverride, size: size || 0, direct: !base && !index
      };
    }

    /* ------------------------------------------------------------------ */
    assemble(source) {
      this.reset();
      try {
        this.pass1(source);
        this.pass2();
      } catch (e) {
        this.error(0, e.message);
      }

      let entry = 0;
      if (this.entryLabel) {
        const sym = this.symbols.get(this.entryLabel);
        if (sym && sym.kind === 'code') entry = sym.index;
        else this.error(0, '入口标号不存在：' + this.entryLabel);
      }

      const symbols = [];
      for (const [name, sym] of this.symbols) {
        symbols.push({ name: name, kind: sym.kind, value: sym.value, off: sym.off, size: sym.size, index: sym.index });
      }

      return {
        ok: this.errors.length === 0,
        errors: this.errors,
        warnings: this.warnings,
        program: {
          code: this.code,
          entry: entry,
          data: this.data,
          dataLen: this.dataLen,
          symbols: symbols,
          segSelectors: this.segSelectors,
          source: source
        }
      };
    }
  }

  SHYL.Assembler = Assembler;
  SHYL.asmUtil = { splitTop: splitTop, stripComment: stripComment };
})(typeof window !== 'undefined' ? window : globalThis);

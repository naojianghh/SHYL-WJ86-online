/* SHYL-WJ86 在线模拟 —— 通用工具 */
(function (global) {
  'use strict';
  const SHYL = (global.SHYL = global.SHYL || {});

  const U = {};

  U.hex = function (value, width) {
    let v = (value >>> 0);
    let s = v.toString(16).toUpperCase();
    width = width || 0;
    while (s.length < width) s = '0' + s;
    return s;
  };

  U.byte = function (v) { return U.hex(v & 0xFF, 2); };
  U.word = function (v) { return U.hex(v & 0xFFFF, 4); };

  U.bin = function (v, width) {
    let s = (v >>> 0).toString(2);
    width = width || 8;
    while (s.length < width) s = '0' + s;
    return s;
  };

  U.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  U.debounce = function (fn, ms) {
    let timer = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms || 100);
    };
  };

  /* 解码上传的汇编源文件：优先 UTF-8，失败则按 GBK/GB18030（实验指导书与
     A86 工程里的 .ASM 多数是 GBK 编码）。返回文本与编码，保存时按原编码写回。 */
  U.decodeSourceEx = function (arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let text = null;
    let encoding = 'utf-8';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      text = null;
    }
    if (text === null) {
      for (const enc of ['gb18030', 'gbk']) {
        try {
          text = new TextDecoder(enc, { fatal: true }).decode(bytes);
          encoding = 'gbk';
          break;
        } catch (e) { /* 继续尝试 */ }
      }
    }
    if (text === null) {
      text = new TextDecoder('utf-8').decode(bytes);
      encoding = 'utf-8';
    }
    return { text: text.replace(/^\uFEFF/, ''), encoding: encoding };
  };

  U.decodeSource = function (arrayBuffer) {
    return U.decodeSourceEx(arrayBuffer).text;
  };

  /* 把文本按指定编码写回文件。浏览器只原生支持 UTF-8 编码，
     GBK 用 TextDecoder 反查出来的双字节表来编码，保留原始文件的中文注释编码。 */
  let gbkEncodeMap = null;

  function buildGbkMap() {
    gbkEncodeMap = new Map();
    let dec = null;
    try { dec = new TextDecoder('gbk'); } catch (e) { dec = null; }
    if (!dec) return;
    const pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xFE; lead++) {
      for (let trail = 0x40; trail <= 0xFE; trail++) {
        if (trail === 0x7F) continue;
        pair[0] = lead; pair[1] = trail;
        let ch;
        try { ch = dec.decode(pair); } catch (e) { continue; }
        if (ch.length === 1 && ch !== '\uFFFD' && !gbkEncodeMap.has(ch)) {
          gbkEncodeMap.set(ch, [lead, trail]);
        }
      }
    }
  }

  U.gbkEncode = function (text) {
    if (!gbkEncodeMap) buildGbkMap();
    const out = [];
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 0x80) { out.push(code); continue; }
      if (code === 0x20AC) { out.push(0x80); continue; }
      const pair = gbkEncodeMap.get(ch);
      if (pair) out.push(pair[0], pair[1]);
      else out.push(0x3F); // 无法用 GBK 表示的字符写成 '?'
    }
    return new Uint8Array(out);
  };

  U.encodeSource = function (text, encoding) {
    if (encoding === 'gbk') {
      try { return U.gbkEncode(text); }
      catch (e) { return new TextEncoder().encode(text); }
    }
    return new TextEncoder().encode(text);
  };

  U.fmtTime = function (seconds) {
    if (seconds < 0.001) return (seconds * 1e6).toFixed(0) + ' µs';
    if (seconds < 1) return (seconds * 1e3).toFixed(seconds < 0.01 ? 2 : 1) + ' ms';
    return seconds.toFixed(3) + ' s';
  };

  U.fmtHz = function (hz) {
    if (!isFinite(hz) || hz <= 0) return '—';
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
    return hz.toFixed(hz < 10 ? 2 : 1) + ' Hz';
  };

  SHYL.U = U;
})(typeof window !== 'undefined' ? window : globalThis);

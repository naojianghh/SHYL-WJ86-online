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
     A86 工程里的 .ASM 多数是 GBK 编码）。 */
  U.decodeSource = function (arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      text = null;
    }
    if (text === null) {
      for (const enc of ['gb18030', 'gbk']) {
        try {
          text = new TextDecoder(enc, { fatal: true }).decode(bytes);
          break;
        } catch (e) { /* 继续尝试 */ }
      }
    }
    if (text === null) {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    return text.replace(/^\uFEFF/, '');
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

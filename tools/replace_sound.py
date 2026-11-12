#!/usr/bin/env python3
# 将 engine.js 中的程序化音效（Sound 类）整体替换为采样播放实现
import io, re, sys

path = r"C:/Users/xgamer/WorkBuddy/战舰世界/js/engine.js"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

start_marker = "/* ---------------- 程序化音效 ---------------- */"
end_marker = "IT.Sound = Sound;"

si = src.find(start_marker)
ei = src.find(end_marker)
assert si != -1, "start marker not found"
assert ei != -1, "end marker not found"
# 包含 end_marker 整行
line_end = src.find("\n", ei)
assert line_end != -1
old = src[si:line_end]

NEW = r'''/* ---------------- 采样音效（真实感 WAV 播放） ----------------
   音频用 Web Audio 播放离线渲染的采样；优先 fetch sounds/<name>.wav/.mp3，
   失败（如 file:// 双击）回退到 js/sounds.js 内嵌的 base64。
   把 sounds/ 下同名文件换成真实录音即可，无需改代码。
------------------------------------------- */
function Sound() {
  this.ctx = null;
  this.master = null;
  this.enabled = true;
  this.buffers = {};
  this.ambientSrc = null;
  this.ambientGain = null;
  this.last = {};
  // 1 = 循环（环境音）
  this.manifest = {
    gun: 0, gun_heavy: 0, explosion: 0, explosion_big: 0, hit: 0, hit_crit: 0,
    splash: 0, torpedo: 0, sink: 0, alarm: 0, ui_up: 0, ui_down: 0, ambient: 1
  };
}
Sound.prototype.init = function () {
  if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
  var AC = global.AudioContext || global.webkitAudioContext;
  if (!AC) { this.enabled = false; return; }
  try {
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.6 : 0;
    this.master.connect(this.ctx.destination);
    this.loadAll();
  } catch (e) { this.enabled = false; }
};
Sound.prototype.loadAll = function () {
  var self = this, names = Object.keys(this.manifest);
  names.forEach(function (name) {
    self.fetchBuffer(name).then(function (buf) {
      self.buffers[name] = buf;
      if (name === 'ambient' && self.enabled) self.startAmbient();
    }).catch(function () {});
  });
};
Sound.prototype.fetchBuffer = function (name) {
  var self = this, exts = ['wav', 'mp3'];
  function tryFetch(i) {
    if (i >= exts.length) {
      var b64 = global.SOUND_BASE64 && global.SOUND_BASE64[name];
      if (!b64) return Promise.reject('no asset: ' + name);
      var bin = atob(b64), arr = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      return new Promise(function (res, rej) {
        self.ctx.decodeAudioData(arr.buffer, res, rej);
      });
    }
    return fetch('sounds/' + name + '.' + exts[i]).then(function (r) {
      if (!r.ok) return tryFetch(i + 1);
      return r.arrayBuffer();
    }).then(function (ab) {
      if (ab instanceof ArrayBuffer) {
        return new Promise(function (res, rej) {
          self.ctx.decodeAudioData(ab, res, rej);
        });
      }
      return tryFetch(i + 1);
    }).catch(function () { return tryFetch(i + 1); });
  }
  return tryFetch(0);
};
Sound.prototype.play = function (name, gain) {
  if (!this.enabled || !this.ctx) return null;
  var buf = this.buffers[name]; if (!buf) return null;
  var t = this.ctx.currentTime;
  var src = this.ctx.createBufferSource();
  src.buffer = buf; src.loop = !!this.manifest[name];
  var g = this.ctx.createGain();
  g.gain.value = (gain == null ? 1 : gain);
  src.connect(g); g.connect(this.master);
  src.start(t);
  return src;
};
Sound.prototype.ok = function (key, ms) {
  if (!this.enabled || !this.ctx) return false;
  var now = performance.now();
  if (this.last[key] && now - this.last[key] < ms) return false;
  this.last[key] = now;
  return true;
};
Sound.prototype.gun = function (power, type) {
  if (!this.ok('gun', 55)) return;
  this.play(type === 'bb' ? 'gun_heavy' : 'gun', (power || 1) * 0.95);
};
Sound.prototype.splash = function () {
  if (!this.ok('splash', 70)) return;
  this.play('splash', 1);
};
Sound.prototype.explosion = function (big) {
  if (!this.ok('exp', 45)) return;
  this.play(big ? 'explosion_big' : 'explosion', 1);
};
Sound.prototype.hit = function (crit) {
  if (!this.ok('hit', 60)) return;
  this.play(crit ? 'hit_crit' : 'hit', 1);
};
Sound.prototype.torpedo = function () {
  if (!this.ok('torp', 90)) return;
  this.play('torpedo', 1);
};
Sound.prototype.sink = function () {
  if (!this.ok('sink', 500)) return;
  this.play('sink', 0.9);
};
Sound.prototype.ui = function (up) {
  if (!this.ok('ui', 60)) return;
  this.play(up ? 'ui_up' : 'ui_down', 1);
};
Sound.prototype.alarm = function () {
  if (!this.ok('alarm', 900)) return;
  this.play('alarm', 0.7);
};
Sound.prototype.startAmbient = function () {
  if (this.ambientSrc || !this.ctx) return;
  var b = this.buffers.ambient; if (!b) return;
  var s = this.ctx.createBufferSource();
  s.buffer = b; s.loop = true;
  var g = this.ctx.createGain(); g.gain.value = 0.12;
  s.connect(g); g.connect(this.master);
  s.start();
  this.ambientSrc = s; this.ambientGain = g;
};
Sound.prototype.toggle = function () {
  this.enabled = !this.enabled;
  if (this.master) this.master.gain.value = this.enabled ? 0.6 : 0;
  if (this.enabled && !this.ambientSrc) this.startAmbient();
  return this.enabled;
};
IT.Sound = Sound;'''

new_src = src[:si] + NEW + src[line_end:]
with open(path, "w", encoding="utf-8") as f:
    f.write(new_src)
print("OK: replaced %d chars (old Sound block) with sample-based implementation" % len(old))

/* =========================================================
   IRON TIDE · engine.js
   数学工具 / 采样音效 / 粒子系统 / 海面与舰船渲染
   纯原生，无任何依赖
   ========================================================= */
(function (global) {
'use strict';

var IT = window.IT = {};

/* ---------------- 数学工具 ---------------- */
var U = IT.util = {
  TAU: Math.PI * 2,
  clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
  lerp: function (a, b, t) { return a + (b - a) * t; },
  rand: function (a, b) { return a + Math.random() * (b - a); },
  randInt: function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },
  pick: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  gauss: function () { // 近似正态分布，用于散布
    return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.9;
  },
  dist: function (ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); },
  dist2: function (ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; },
  norm: function (a) {
    while (a > Math.PI) a -= U.TAU;
    while (a < -Math.PI) a += U.TAU;
    return a;
  },
  angDiff: function (a, b) { return U.norm(b - a); },
  approach: function (cur, target, step) {
    var d = target - cur;
    if (Math.abs(d) <= step) return target;
    return cur + Math.sign(d) * step;
  },
  // 把世界点变换到以 (ox,oy) 为原点、朝向 ang 的局部坐标
  toLocal: function (px, py, ox, oy, ang) {
    var dx = px - ox, dy = py - oy, c = Math.cos(-ang), s = Math.sin(-ang);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  },
  fmt: function (n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); },
  clock: function (sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
};

/* ---------------- 采样音效（真实感 WAV 播放） ----------------
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
  this.listener = null;
  this.last = {};
  // 1 = 循环（环境音）
  this.manifest = {
    gun: 0, gun_heavy: 0, explosion: 0, explosion_big: 0, hit: 0, hit_crit: 0,
    splash: 0, torpedo: 0, sink: 0, alarm: 0, ui_up: 0, ui_down: 0, ambient: 1
  };
}
Sound.prototype.init = function () {
  if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
  var AC = window.AudioContext || window.webkitAudioContext;
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
  var self = this, exts = ['wav', 'mp3', 'ogg'];
  var offline = window.location && window.location.protocol === 'file:';
  function tryFetch(i) {
    if (offline) i = exts.length; // 离线双击：直接读内嵌 base64，避免 404 噪音
    if (i >= exts.length) {
      var b64 = window.SOUND_BASE64 && window.SOUND_BASE64[name];
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
/* ---------------- 空间化音效 ----------------
   听点 = 本舰位置 + 航向，由 game.js 用 setListener 注入。
   1km = 187 世界单位：近距离满音量，远距离按平方衰减、高频被滤掉变闷，
   并按「右舷分量」分到左右声道；超出可闻半径直接不发声。
   UI 音 / 语音不传坐标，保持原音量。
------------------------------------------- */
Sound.prototype.setListener = function (fn) { this.listener = fn; };
Sound.prototype.spatial = function (at, range) {
  var near = 240, far = range || 3600;
  var flat = { vol: 1, pan: 0, cutoff: 0, dist: 0 };
  if (!at || !this.listener) return flat;
  var L = this.listener();
  if (!L) return flat;
  var dx = at.x - L.x, dy = at.y - L.y;
  var d = Math.sqrt(dx * dx + dy * dy);
  if (d >= far) return { vol: 0, pan: 0, cutoff: 0, dist: d };
  var t = U.clamp((d - near) / (far - near), 0, 1);
  var vol = (1 - t) * (1 - t);
  // 右舷方向 = (-sin(ang), cos(ang))；贴脸时不分左右，避免声像乱跳
  var pan = d < 120 ? 0 : U.clamp((dx * -Math.sin(L.ang) + dy * Math.cos(L.ang)) / d, -1, 1) * 0.7;
  var cutoff = t > 0.12 ? Math.round(16000 - t * 13200) : 0;
  return { vol: vol, pan: pan, cutoff: cutoff, dist: d };
};
Sound.prototype.play = function (name, gain, fx) {
  if (!this.enabled || !this.ctx) return null;
  var buf = this.buffers[name]; if (!buf) return null;
  fx = fx || { vol: 1, pan: 0, cutoff: 0 };
  if (fx.vol <= 0) return null;
  var t = this.ctx.currentTime;
  var src = this.ctx.createBufferSource();
  src.buffer = buf; src.loop = !!this.manifest[name];
  var g = this.ctx.createGain();
  g.gain.value = (gain == null ? 1 : gain) * fx.vol;
  src.connect(g);
  var tail = g;
  if (fx.cutoff && this.ctx.createBiquadFilter) {
    var lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = fx.cutoff;
    tail.connect(lp); tail = lp;
  }
  if (fx.pan && this.ctx.createStereoPanner) {
    var pn = this.ctx.createStereoPanner();
    pn.pan.value = fx.pan;
    tail.connect(pn); tail = pn;
  }
  tail.connect(this.master);
  src.start(t);
  return src;
};
Sound.prototype.ok = function (key, ms, vol) {
  if (!this.enabled || !this.ctx) return false;
  var now = performance.now(), prev = this.last[key], v = vol == null ? 1 : vol;
  // 节流窗口内只允许「明显更近」的一声插队：远处炮声不会盖掉近处炮声，
  // 更近的一声也不会被同一波齐射里先落地的远弹吃掉
  if (prev && now - prev.t < ms && v <= prev.v * 1.4) return false;
  this.last[key] = { t: now, v: v };
  return true;
};
Sound.prototype.gun = function (power, type, at) {
  var far = type === 'bb' ? 4600 : (type === 'ca' ? 3900 : 3100);  // 口径越大传得越远
  var fx = this.spatial(at, far);
  if (fx.vol < 0.035) return;
  if (!this.ok('gun', 55, fx.vol)) return;
  this.play(type === 'bb' ? 'gun_heavy' : 'gun', (power || 1) * 0.95, fx);
};
Sound.prototype.splash = function (at) {
  var fx = this.spatial(at, 3000);
  if (fx.vol < 0.035) return;
  if (!this.ok('splash', 70, fx.vol)) return;
  this.play('splash', 1, fx);
};
Sound.prototype.explosion = function (big, at) {
  var fx = this.spatial(at, big ? 4200 : 3300);
  if (fx.vol < 0.035) return;
  if (!this.ok('exp', 45, fx.vol)) return;
  this.play(big ? 'explosion_big' : 'explosion', 1, fx);
};
Sound.prototype.hit = function (crit, at) {
  var fx = this.spatial(at, 2600);
  if (fx.vol < 0.035) return;
  if (!this.ok('hit', 60, fx.vol)) return;
  this.play(crit ? 'hit_crit' : 'hit', 1, fx);
};
Sound.prototype.torpedo = function (at) {
  var fx = this.spatial(at, 2400);
  if (fx.vol < 0.035) return;
  if (!this.ok('torp', 90, fx.vol)) return;
  this.play('torpedo', 1, fx);
};
Sound.prototype.sink = function (at) {
  var fx = this.spatial(at, 4000);
  if (fx.vol < 0.035) return;
  if (!this.ok('sink', 500, fx.vol)) return;
  this.play('sink', 0.9, fx);
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
IT.Sound = Sound;

/* ---------------- 语音播报（Breeze TTS 本地生成） ----------------
   与 Sound 类似：优先 fetch sounds/vo/<name>.wav，失败（file:// 双击）回退
   js/voice.js 内嵌的 base64。复用 Sound 的 AudioContext，避免多上下文。 */
function Voice() {
  this.ctx = null; this.master = null; this.enabled = true;
  this.buffers = {}; this.last = {};
  this.exts = ['wav', 'mp3', 'ogg'];
}
Voice.prototype.init = function () {
  if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = (window.G && window.G.sound && window.G.sound.ctx) ? window.G.sound.ctx : (AC ? new AC() : null);
  if (!ctx) { this.enabled = false; return; }
  this.ctx = ctx;
  try {
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.95 : 0;
    this.master.connect(this.ctx.destination);
    this.loadAll();
  } catch (e) { this.enabled = false; }
};
Voice.prototype.loadAll = function () {
  var self = this, names = Object.keys(window.VOICE_BASE64 || {});
  names.forEach(function (name) {
    self.fetchBuffer(name).then(function (buf) { self.buffers[name] = buf; }).catch(function () {});
  });
};
Voice.prototype.fetchBuffer = function (name) {
  var self = this, exts = this.exts;
  var offline = window.location && window.location.protocol === 'file:';
  function tryFetch(i) {
    if (offline) i = exts.length; // 离线双击：直接读内嵌 base64，避免 404 噪音
    if (i >= exts.length) {
      var b64 = window.VOICE_BASE64 && window.VOICE_BASE64[name];
      if (!b64) return Promise.reject('no voice: ' + name);
      var bin = atob(b64), arr = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      return new Promise(function (res, rej) { self.ctx.decodeAudioData(arr.buffer, res, rej); });
    }
    return fetch('sounds/vo/' + name + '.' + exts[i]).then(function (r) {
      if (!r.ok) return tryFetch(i + 1);
      return r.arrayBuffer();
    }).then(function (ab) {
      if (ab instanceof ArrayBuffer) return new Promise(function (res, rej) { self.ctx.decodeAudioData(ab, res, rej); });
      return tryFetch(i + 1);
    }).catch(function () { return tryFetch(i + 1); });
  }
  return tryFetch(0);
};
Voice.prototype.play = function (name) {
  if (!this.enabled || !this.ctx) return;
  var buf = this.buffers[name]; if (!buf) return;
  var t = this.ctx.currentTime;
  var src = this.ctx.createBufferSource();
  src.buffer = buf; src.loop = false;
  var g = this.ctx.createGain(); g.gain.value = 1;
  src.connect(g); g.connect(this.master); src.start(t);
};
Voice.prototype.ok = function (name, ms) {
  if (!this.enabled || !this.ctx) return false;
  var now = performance.now();
  if (this.last[name] && now - this.last[name] < ms) return false;
  this.last[name] = now; return true;
};
Voice.prototype.say = function (name, ms) {
  if (!this.ok('v_' + name, ms || 350)) return;
  this.play(name);
};
Voice.prototype.toggle = function () {
  this.enabled = !this.enabled;
  if (this.master) this.master.gain.value = this.enabled ? 0.95 : 0;
  return this.enabled;
};
IT.Voice = Voice;

/* ---------------- 粒子系统 ---------------- */
function Particles() { this.list = []; this.max = 620; }
Particles.prototype.add = function (p) {
  if (this.list.length >= this.max) this.list.shift();
  p.life = p.life || 1; p.max = p.life; p.vx = p.vx || 0; p.vy = p.vy || 0;
  p.drag = p.drag == null ? 0.94 : p.drag; p.size = p.size || 3;
  p.grow = p.grow || 0; p.grav = p.grav || 0; p.alpha = p.alpha == null ? 1 : p.alpha;
  this.list.push(p);
};
Particles.prototype.burst = function (x, y, opt) {
  var n = opt.count || 12;
  for (var i = 0; i < n; i++) {
    var a = opt.angle == null ? Math.random() * U.TAU : opt.angle + U.rand(-0.7, 0.7);
    var sp = U.rand(opt.speedMin || 20, opt.speedMax || 130);
    this.add({
      x: x + U.rand(-(opt.spread || 0), opt.spread || 0),
      y: y + U.rand(-(opt.spread || 0), opt.spread || 0),
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: U.rand(opt.lifeMin || 0.35, opt.lifeMax || 0.9),
      size: U.rand(opt.sizeMin || 2, opt.sizeMax || 7),
      color: U.pick(opt.colors || ['#ffd9a0']),
      type: opt.type || 'spark', grow: opt.grow || 0, grav: opt.grav || 0,
      drag: opt.drag == null ? 0.93 : opt.drag, alpha: opt.alpha == null ? 1 : opt.alpha
    });
  }
};
Particles.prototype.update = function (dt) {
  var l = this.list, k = 1 - Math.pow(0.06, dt); // 帧率无关的阻尼
  for (var i = l.length - 1; i >= 0; i--) {
    var p = l[i];
    p.life -= dt;
    if (p.life <= 0) { l.splice(i, 1); continue; }
    p.vx *= (1 - k * (1 - p.drag) * 10);
    p.vy *= (1 - k * (1 - p.drag) * 10);
    p.vy += p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.size += p.grow * dt;
  }
};
Particles.prototype.draw = function (ctx) {
  var l = this.list;
  ctx.save();
  for (var i = 0; i < l.length; i++) {
    var p = l[i], t = p.life / p.max;
    ctx.globalAlpha = U.clamp(t * p.alpha, 0, 1);
    ctx.fillStyle = p.color;
    if (p.type === 'line') {
      ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(1, p.size * 0.4);
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045); ctx.stroke();
    } else if (p.type === 'ring') {
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, p.size), 0, U.TAU); ctx.stroke();
    } else if (p.type === 'flash') {
      // 加性发光：炮口焰 / 曝闪
      ctx.globalCompositeOperation = 'lighter';
      var fg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, p.size));
      fg.addColorStop(0, p.color);
      fg.addColorStop(0.4, p.color);
      fg.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, p.size), 0, U.TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, p.size), 0, U.TAU); ctx.fill();
    }
  }
  ctx.restore();
};
IT.Particles = Particles;

/* ---------------- 确定性噪声（海床 / 波光共用） ---------------- */
var NOISE_TABLE = (function () {
  var a = new Float32Array(256 * 256);
  for (var i = 0; i < a.length; i++) a[i] = Math.random();
  return a;
})();
IT.hash2 = function (ix, iy) {
  return NOISE_TABLE[((iy & 255) << 8) | (ix & 255)];
};
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y) {
  var ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  var a = IT.hash2(ix, iy), b = IT.hash2(ix + 1, iy);
  var c = IT.hash2(ix, iy + 1), d = IT.hash2(ix + 1, iy + 1);
  var top = a + (b - a) * fx, bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}
function fbm(x, y, oct) {
  var sum = 0, amp = 0.5, f = 1, norm = 0;
  for (var o = 0; o < (oct || 4); o++) { sum += valueNoise(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return sum / norm;
}

/* ---------------- 海床 / 水深底图 ----------------
   一次性预渲染整张海域的水深场：深水暗蓝 → 浅水青绿，带等深线与沙脊纹。
   比平铺纹理更能让镜头移动时看出「这是一片有地貌的海」。 */
IT.makeSeabedMap = function (world, size) {
  size = size || 900;
  var c = document.createElement('canvas'); c.width = c.height = size;
  var g = c.getContext('2d');
  var img = g.createImageData(size, size), d = img.data;
  var levels = new Float32Array(size * size);
  var humps = [
    [0.34, 0.31, 0.15, 0.22], [0.62, 0.24, 0.12, 0.20],
    [0.71, 0.66, 0.16, 0.24], [0.28, 0.72, 0.13, 0.20],
    [0.48, 0.52, 0.20, 0.10]
  ];
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var idx = y * size + x, p = idx * 4;
      var nx = x / size, ny = y / size;
      var h = fbm(x / 62, y / 62, 4) * 0.74 + fbm(x / 19 + 37, y / 19 + 11, 3) * 0.26;
      // 中央交战区整体略浅，四周渐深
      var rr = Math.sqrt((nx - 0.5) * (nx - 0.5) + (ny - 0.5) * (ny - 0.5));
      h += 0.20 - rr * 0.50;
      for (var q = 0; q < humps.length; q++) {
        var hu = humps[q];
        var hd = Math.sqrt((nx - hu[0]) * (nx - hu[0]) + (ny - hu[1]) * (ny - hu[1]));
        if (hd < hu[2]) h += (1 - hd / hu[2]) * hu[3];
      }
      h = U.clamp(h, 0, 1);
      levels[idx] = h;

      var t = U.clamp((h - 0.24) / 0.68, 0, 1);
      var r = 4 + t * 11, gg = 18 + t * 40, b = 30 + t * 48;
      // 浅水区偏青绿，增加水色变化
      if (t > 0.55) { var sf = (t - 0.55) / 0.45; r += sf * 3; gg += sf * 8; b -= sf * 3; }
      // 细颗粒，避免大色块发平
      var grain = (IT.hash2(x * 7 + 13, y * 11 + 5) - 0.5) * 4;
      // 水下沙脊波纹（浅水区可见）
      if (h > 0.58) {
        var stripe = Math.sin(x * 0.62 + y * 0.24 + fbm(x / 8, y / 8, 2) * 9);
        if (stripe > 0.72) { r += 3; gg += 6; b += 5; }
      }
      // 等深线：与左 / 上邻居跨过层级时描一条细亮线（隔层绘制，避免满屏同心圈）
      var lv = Math.floor(h * 9);
      var contour = (x > 0 && Math.floor(levels[idx - 1] * 9) !== lv) ||
                    (y > 0 && Math.floor(levels[idx - size] * 9) !== lv);
      if (contour && lv % 2 === 0) { r += 3; gg += 9; b += 11; }
      d[p] = U.clamp(r + grain, 0, 255);
      d[p + 1] = U.clamp(gg + grain, 0, 255);
      d[p + 2] = U.clamp(b + grain, 0, 255);
      d[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
};

/* ---------------- 海面纹理 ----------------
   透明底 + 周期波纹场，叠在水深底图上。周期函数保证平铺无缝。 */
IT.makeSeaTexture = function (size) {
  size = size || 512;
  var c = document.createElement('canvas'); c.width = c.height = size;
  var g = c.getContext('2d');
  var img = g.createImageData(size, size), d = img.data;
  var TAU = U.TAU;
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var u = x / size, v = y / size, p = (y * size + x) * 4;
      // 多组不同方向、不同波长的涌浪（整数周期 → 无缝）
      var w1 = Math.sin(TAU * (u * 7 + v * 2) + Math.sin(TAU * (u * 2 - v * 3)) * 0.9);
      var w2 = Math.sin(TAU * (u * 3 - v * 9) + Math.sin(TAU * (u * 5 + v * 1)) * 0.7);
      var w3 = Math.sin(TAU * (u * 14 + v * 5)) * 0.5;
      var crest = Math.max(0, (w1 * 0.5 + w2 * 0.34 + w3 * 0.16));
      var hi = Math.pow(crest, 5) * 30;
      var lo = Math.pow(Math.max(0, -(w1 * 0.5 + w2 * 0.34 + w3 * 0.16)), 4) * 16;
      d[p] = 150; d[p + 1] = 214; d[p + 2] = 236;
      d[p + 3] = U.clamp(hi - 0, 0, 255) * 0.42;
      if (lo > 0) { d[p] = 0; d[p + 1] = 6; d[p + 2] = 16; d[p + 3] = lo * 0.55; }
    }
  }
  g.putImageData(img, 0, 0);
  // 短波纹弧线：x 方向做环绕复制，消除平铺接缝
  for (var i = 0; i < 140; i++) {
    var px = Math.random() * size, py = Math.random() * size;
    var w = U.rand(8, 34), h = U.rand(0.5, 1.4);
    var light = Math.random() > 0.42;
    g.strokeStyle = light ? 'rgba(168,224,242,' + U.rand(0.01, 0.028).toFixed(3) + ')'
                          : 'rgba(0,10,22,' + U.rand(0.015, 0.035).toFixed(3) + ')';
    g.lineWidth = h;
    for (var dx = -size; dx <= size; dx += size) {
      g.beginPath();
      g.moveTo(px + dx, py);
      g.quadraticCurveTo(px + dx + w * 0.5, py + U.rand(-2.2, 2.2), px + dx + w, py);
      g.stroke();
    }
  }
  return c;
};
IT.makeCurrentTexture = function (size) {
  size = size || 512;
  var c = document.createElement('canvas'); c.width = c.height = size;
  var g = c.getContext('2d');
  for (var i = 0; i < 80; i++) {
    var y = Math.random() * size, x = Math.random() * size, w = U.rand(70, 300);
    g.strokeStyle = 'rgba(150,220,242,' + U.rand(0.008, 0.024).toFixed(3) + ')';
    g.lineWidth = U.rand(1, 6);
    for (var dx = -size; dx <= size; dx += size) {
      g.beginPath(); g.moveTo(x + dx, y);
      g.bezierCurveTo(x + dx + w * 0.3, y - 12, x + dx + w * 0.7, y + 12, x + dx + w, y + 3);
      g.stroke();
    }
  }
  return c;
};

/* ---------------- 舰船矢量绘制（WoWs 风格精细俯视） ----------------
   分层：静态舰体（舰壳 / 甲板 / 塔式舰桥 / 烟囱 / 桅杆 / 副炮 / 小艇）
   按「舰型 × 阵营 × LOD」预渲染到离屏 canvas 缓存；
   主炮塔（跟随炮塔旋转 + 逐塔装填状态）、鱼雷发射管座（逐座装填状态）、
   起火与沉没态每帧实时绘制。全图档舰体不足 34px 时走简化剪影。
-------------------------------------------------------------------- */
function hullPath(ctx, L, B, sc) {
  sc = sc || 1;
  var l = L * sc, b = B * sc;
  ctx.beginPath();
  ctx.moveTo(0.50 * l, 0);
  ctx.bezierCurveTo(0.495 * l, -0.09 * b, 0.455 * l, -0.33 * b, 0.31 * l, -0.485 * b);
  ctx.bezierCurveTo(0.19 * l, -0.505 * b, -0.29 * l, -0.505 * b, -0.41 * l, -0.47 * b);
  ctx.bezierCurveTo(-0.475 * l, -0.455 * b, -0.50 * l, -0.39 * b, -0.50 * l, -0.28 * b);
  ctx.lineTo(-0.50 * l, 0.28 * b);
  ctx.bezierCurveTo(-0.50 * l, 0.39 * b, -0.475 * l, 0.455 * b, -0.41 * l, 0.47 * b);
  ctx.bezierCurveTo(-0.29 * l, 0.505 * b, 0.19 * l, 0.505 * b, 0.31 * l, 0.485 * b);
  ctx.bezierCurveTo(0.455 * l, 0.33 * b, 0.495 * l, 0.09 * b, 0.50 * l, 0);
  ctx.closePath();
}
// 圆角矩形路径
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function box(ctx, x, y, w, h, r, fill, stroke, lw) {
  roundRect(ctx, x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 0.8; ctx.stroke(); }
}
// 切角装甲炮塔俯视外形（x 正向为炮口）
function turretShape(ctx, tw, th) {
  var x0 = -tw * 0.5, x1 = tw * 0.5, y0 = -th * 0.5, y1 = th * 0.5;
  var c = Math.min(tw, th) * 0.20;
  ctx.beginPath();
  ctx.moveTo(x1, -th * 0.32);
  ctx.lineTo(x1 - c * 0.5, y0);
  ctx.lineTo(x0 + c, y0);
  ctx.lineTo(x0, -th * 0.34);
  ctx.lineTo(x0, th * 0.34);
  ctx.lineTo(x0 + c, y1);
  ctx.lineTo(x1 - c * 0.5, y1);
  ctx.lineTo(x1, th * 0.32);
  ctx.closePath();
}

/* 各舰外形差异（烟囱数 / 舰桥层数与位置 / 副炮 / 舰载机 / 深弹轨） */
var LOOKS = {
  mutsuki:   { fn: [0.00],            br: 0.15, layers: 2, sec: 2, plane: 0, boat: 1, depth: 1 },
  farragut:  { fn: [-0.01, -0.14],    br: 0.15, layers: 2, sec: 3, plane: 0, boat: 1, depth: 1 },
  lightning: { fn: [-0.04],           br: 0.16, layers: 3, sec: 3, plane: 0, boat: 1, depth: 1 },
  cleveland: { fn: [-0.05, -0.17],    br: 0.13, layers: 4, sec: 4, plane: 1, boat: 2, depth: 0 },
  myoko:     { fn: [-0.04, -0.16],    br: 0.12, layers: 4, sec: 4, plane: 1, boat: 2, depth: 0 },
  atago:     { fn: [-0.05, -0.17],    br: 0.11, layers: 5, sec: 4, plane: 1, boat: 2, depth: 0 },
  nagato:    { fn: [-0.09],           br: 0.10, layers: 6, sec: 5, plane: 1, boat: 2, depth: 0 },
  bismarck:  { fn: [-0.07],           br: 0.12, layers: 4, sec: 6, plane: 1, boat: 2, depth: 0 },
  york:      { fn: [-0.08],           br: 0.12, layers: 4, sec: 5, plane: 1, boat: 2, depth: 0 }
};
var DEFAULT_LOOK = { fn: [-0.06], br: 0.13, layers: 3, sec: 3, plane: 0, boat: 1, depth: 0 };
function shipLook(s) { return LOOKS[(s.def || {}).key] || DEFAULT_LOOK; }

/* 阵营 / 本舰 / 沉没配色：钢灰甲板 + 青蓝或橙红识别光边 */
function shipPal(s) {
  if (s.sunk) return {
    edge: '#6b7b82', hullDark: '#121c21', hull: '#1b272c', hullHi: '#2b383e',
    deck: '#2b383e', deckLo: '#1d2a30', deckHi: '#3a4a50', deckEdge: 'rgba(180,200,210,.18)',
    line: 'rgba(160,190,200,.10)', lineHi: 'rgba(180,210,220,.16)',
    super_: '#35444b', superHi: '#5a6c74', superEdge: 'rgba(190,210,220,.16)', glass: '#6a7d86',
    turret: '#37474e', turretHi: '#5d7078', turretLo: '#202c31', barrel: '#8c9da4', barrelDark: '#1b262b',
    funnel: '#2a373d', funnelDark: '#1b262b', funnelTop: '#0d1417', funnelEdge: 'rgba(190,210,220,.18)',
    band: '#5a6c74', metal: '#7b8d95', metalDark: '#263238', tube: '#3c4a50', tubeEdge: '#687981',
    ready: '#9fb4bc'
  };
  if (s.team === 0) {
    var pl = !!s.isPlayer;
    return {
      edge: pl ? '#63d9f5' : '#8ce0b4',
      hullDark: '#0c2532', hull: '#1c4052', hullHi: '#31647a',
      deck: pl ? '#345f70' : '#315862', deckLo: '#20404a', deckHi: '#4b7684',
      deckEdge: 'rgba(205,240,250,.25)', line: 'rgba(190,228,242,.16)', lineHi: 'rgba(205,240,250,.30)',
      super_: '#3c6d82', superHi: '#8fc0d0', superEdge: 'rgba(215,245,255,.32)', glass: '#a7dff0',
      turret: '#4d8296', turretHi: '#8ec2d2', turretLo: '#21465a', barrel: '#c4edfa', barrelDark: '#1a3645',
      funnel: '#275668', funnelDark: '#173947', funnelTop: '#0a1a22', funnelEdge: 'rgba(210,242,252,.28)',
      band: pl ? '#63d9f5' : '#8ce0b4', metal: '#9cc6d4', metalDark: '#1c3c4b',
      tube: '#3d6c7e', tubeEdge: '#8ec2d2', ready: pl ? '#9ff6ff' : '#a8ffd2'
    };
  }
  return {
    edge: '#ff8069', hullDark: '#2a1417', hull: '#4a2729', hullHi: '#75403c',
    deck: '#5e3735', deckLo: '#3c2224', deckHi: '#7c4c48', deckEdge: 'rgba(255,215,200,.24)',
    line: 'rgba(255,205,190,.14)', lineHi: 'rgba(255,220,205,.28)',
    super_: '#7a4642', superHi: '#d09a8c', superEdge: 'rgba(255,220,205,.30)', glass: '#f0bcae',
    turret: '#8a4f49', turretHi: '#d7a092', turretLo: '#4b2827', barrel: '#f6cabc', barrelDark: '#3b1f20',
    funnel: '#6a3634', funnelDark: '#3d2020', funnelTop: '#150c0e', funnelEdge: 'rgba(255,215,200,.26)',
    band: '#ff8069', metal: '#d6a99c', metalDark: '#3d2020', tube: '#7a423c', tubeEdge: '#d09a8c',
    ready: '#ffb59c'
  };
}

/* 静态舰体缓存：一次栅格化，之后每帧只 drawImage */
var SHIP_SPRITES = {};
function shipSprite(s, lod, C) {
  var d = s.def || {};
  var key = (d.key || d.kind || '?') + '|' + (s.isPlayer ? 'p' : (s.team === 0 ? 'a' : 'e'))
          + '|' + (s.sunk ? 's' : 'n') + '|' + lod;
  if (SHIP_SPRITES[key]) return SHIP_SPRITES[key];
  var L = s.len, B = s.beam, SS = lod === 2 ? 2.2 : 1.5;
  var ox = L * 0.62, oy = B * 1.05;
  var c = document.createElement('canvas');
  c.width = Math.ceil(ox * 2 * SS); c.height = Math.ceil(oy * 2 * SS);
  var g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2); g.scale(SS, SS);
  paintStatic(g, s, lod, C);
  var sp = { c: c, ox: ox, oy: oy };
  if (Object.keys(SHIP_SPRITES).length > 48) SHIP_SPRITES = {};
  SHIP_SPRITES[key] = sp;
  return sp;
}

// 副炮避开主炮塔，避免叠成一团
function nearTurret(s, px) {
  var L = s.len, B = s.beam, ts = s.turrets || [];
  for (var i = 0; i < ts.length; i++) if (Math.abs(px - ts[i].lx * L) < B * 0.28) return true;
  return false;
}

function paintStatic(g, s, lod, C) {
  var L = s.len, B = s.beam, d = s.def || {}, kind = d.kind || 'dd';
  var lk = shipLook(s), hi = (lod === 2);
  var lw = Math.max(0.7, B * 0.016);
  // 1 · 水下阴影
  g.save(); g.translate(-L * 0.012, B * 0.13);
  hullPath(g, L, B, 1.055); g.fillStyle = 'rgba(0,8,14,.46)'; g.fill(); g.restore();
  // 2 · 舰壳三层：外壳 / 舷侧高光 / 舷墙
  hullPath(g, L, B, 1);     g.fillStyle = C.hullDark; g.fill();
  hullPath(g, L, B, 0.955); g.fillStyle = C.hullHi;   g.fill();
  hullPath(g, L, B, 0.915); g.fillStyle = C.hull;     g.fill();
  // 3 · 甲板（沿舷向的光带渐变）
  hullPath(g, L, B, 0.86);
  var dg = g.createLinearGradient(0, -B * 0.45, 0, B * 0.45);
  dg.addColorStop(0, C.deckLo); dg.addColorStop(0.45, C.deck); dg.addColorStop(1, C.deckHi);
  g.fillStyle = dg; g.fill();
  g.lineWidth = lw * 1.2; g.strokeStyle = C.deckEdge; g.stroke();
  // 4 · 敌我识别光边
  hullPath(g, L, B, 1);
  g.lineWidth = Math.max(1.2, B * 0.042); g.strokeStyle = C.edge;
  g.shadowColor = C.edge; g.shadowBlur = hi ? 10 : 6; g.stroke(); g.shadowBlur = 0;
  // 5 · 甲板板缝 / 中线
  g.strokeStyle = C.line; g.lineWidth = lw;
  var step = hi ? L * 0.052 : L * 0.10;
  for (var x = -L * 0.44; x < L * 0.44; x += step) {
    g.beginPath(); g.moveTo(x, -B * 0.35); g.lineTo(x, B * 0.35); g.stroke();
  }
  g.strokeStyle = C.lineHi; g.lineWidth = lw * 1.3; g.setLineDash([L * 0.028, L * 0.022]);
  g.beginPath(); g.moveTo(-L * 0.46, 0); g.lineTo(L * 0.45, 0); g.stroke(); g.setLineDash([]);
  // 6 · 舰艏：锚链舱 / 锚孔 / 破浪线
  box(g, L * 0.34, -B * 0.115, L * 0.088, B * 0.23, B * 0.05, C.deckLo, C.metal, lw * 0.8);
  g.strokeStyle = C.metal; g.lineWidth = lw * 1.3;
  for (var a = -1; a <= 1; a += 2) {
    g.beginPath(); g.moveTo(L * 0.355, a * B * 0.065); g.lineTo(L * 0.425, a * B * 0.105); g.stroke();
    g.fillStyle = C.funnelTop; g.beginPath(); g.arc(L * 0.428, a * B * 0.108, B * 0.030, 0, U.TAU); g.fill();
  }
  if (hi) {
    g.strokeStyle = C.lineHi; g.lineWidth = lw;
    g.beginPath(); g.moveTo(L * 0.47, -B * 0.08); g.lineTo(L * 0.43, 0); g.lineTo(L * 0.47, B * 0.08); g.stroke();
  }
  // 7 · 舰艉：艉楼 / 深弹轨（驱逐舰）
  box(g, -L * 0.47, -B * 0.20, L * 0.09, B * 0.40, B * 0.05, C.super_, C.superEdge, lw);
  if (hi && lk.depth) {
    for (var dr = -1; dr <= 1; dr += 2)
      box(g, -L * 0.455, dr * B * 0.22 - B * 0.025, L * 0.07, B * 0.05, B * 0.02, C.metalDark, null, 0);
  }
  // 8 · 塔式舰桥：逐层收窄 + 罗经舰桥玻璃 + 测距仪翼 + 主桅横桁
  var bx = L * lk.br, bw = L * (kind === 'dd' ? 0.105 : 0.125), bh = B * (kind === 'dd' ? 0.34 : 0.44);
  for (var i = 0; i < lk.layers; i++) {
    var f = 1 - i * 0.125, w = bw * f, h = bh * f;
    box(g, bx - w / 2 - i * L * 0.004, -h / 2, w, h, Math.max(1, B * 0.045 * f),
        i === lk.layers - 1 ? C.superHi : C.super_, C.superEdge, lw);
  }
  box(g, bx + bw * 0.30, -bh * 0.33, bw * 0.20, bh * 0.66, B * 0.02, C.glass, null, 0);
  if (hi) {
    for (var wg = -1; wg <= 1; wg += 2)
      box(g, bx - bw * 0.12, wg * B * 0.26 - B * 0.035, bw * 0.5, B * 0.07, B * 0.02, C.superHi, null, 0);
    g.strokeStyle = C.metal; g.lineWidth = lw * 1.6;
    g.beginPath(); g.moveTo(bx - L * 0.01, 0); g.lineTo(bx - L * 0.085, 0); g.stroke();
    g.lineWidth = lw * 1.2;
    for (var mt = 0; mt < 2; mt++) {
      var mx = bx - L * (0.03 + mt * 0.035), span = B * (0.30 - mt * 0.08);
      g.beginPath(); g.moveTo(mx, -span); g.lineTo(mx, span); g.stroke();
    }
    box(g, bx - L * 0.09, -B * 0.045, L * 0.035, B * 0.09, B * 0.015, C.metalDark, C.metal, lw);
    g.fillStyle = C.glass; g.beginPath(); g.arc(bx, 0, Math.max(1, B * 0.035), 0, U.TAU); g.fill();
  }
  // 9 · 烟囱：外套 + 帽沿 + 黑色烟口 + 阵营识别环带
  for (var fi = 0; fi < lk.fn.length; fi++) {
    var fx = L * lk.fn[fi], fw = L * 0.048, fh = B * 0.30;
    box(g, fx - fw / 2, -fh / 2, fw, fh, B * 0.05, C.funnelDark, C.funnelEdge, lw);
    box(g, fx - fw * 0.40, -fh * 0.40, fw * 0.80, fh * 0.80, B * 0.04, C.funnel, null, 0);
    box(g, fx - fw * 0.31, -fh * 0.31, fw * 0.62, fh * 0.62, B * 0.03, C.funnelTop, null, 0);
    g.fillStyle = C.band; g.globalAlpha = 0.72;
    g.fillRect(fx - fw / 2, -fh * 0.055, fw, fh * 0.11); g.globalAlpha = 1;
  }
  // 10 · 后部射击指挥所
  box(g, -L * 0.30, -B * 0.13, L * 0.075, B * 0.26, B * 0.04, C.super_, C.superEdge, lw);
  if (hi) {
    g.strokeStyle = C.metal; g.lineWidth = lw * 1.3;
    g.beginPath(); g.moveTo(-L * 0.265, -B * 0.22); g.lineTo(-L * 0.265, B * 0.22); g.stroke();
  }
  // 11 · 弹射器 + 水上飞机（巡洋 / 战列）
  if (hi && lk.plane) {
    box(g, -L * 0.40, -B * 0.09, L * 0.16, B * 0.18, B * 0.02, C.metalDark, C.metal, lw);
    g.save(); g.translate(-L * 0.32, 0);
    g.fillStyle = C.metal;
    g.beginPath();                       // 机身（尖头朝舰艏）
    g.moveTo(L * 0.052, 0); g.lineTo(L * 0.022, -B * 0.025);
    g.lineTo(-L * 0.045, -B * 0.025); g.lineTo(-L * 0.045, B * 0.025);
    g.lineTo(L * 0.022, B * 0.025); g.closePath(); g.fill();
    for (var pw = -1; pw <= 1; pw += 2) {   // 后掠主翼
      g.beginPath();
      g.moveTo(L * 0.012, pw * B * 0.022); g.lineTo(-L * 0.004, pw * B * 0.135);
      g.lineTo(-L * 0.026, pw * B * 0.135); g.lineTo(-L * 0.018, pw * B * 0.022);
      g.closePath(); g.fill();
    }
    box(g, -L * 0.042, -B * 0.062, L * 0.017, B * 0.124, B * 0.008, C.metal, null, 0);
    g.restore();
  }
  // 12 · 救生艇 / 舷侧小器具
  if (hi) {
    for (var bt = 0; bt < lk.boat; bt++) for (var bs = -1; bs <= 1; bs += 2)
      box(g, L * (0.01 - bt * 0.09), bs * B * 0.34 - (bs < 0 ? B * 0.07 : 0),
          L * 0.075, B * 0.07, B * 0.03, C.metalDark, C.metal, lw);
  }
  // 13 · 舷侧副炮 / 高炮
  var n = lk.sec;
  for (var sd = -1; sd <= 1; sd += 2) for (var si = 0; si < n; si++) {
    var px = L * (0.31 - si * (0.58 / Math.max(1, n - 1)));
    if (nearTurret(s, px)) continue;
    var py = sd * B * 0.35, rr = Math.max(1.4, B * 0.048);
    g.fillStyle = C.turretLo; g.strokeStyle = C.turretHi; g.lineWidth = lw;
    g.beginPath(); g.arc(px, py, rr, 0, U.TAU); g.fill(); g.stroke();
    g.strokeStyle = C.barrel; g.lineWidth = Math.max(0.8, B * 0.022);
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, py + sd * rr * 2.1); g.stroke();
  }
  // 14 · 舷窗（战术档）
  if (hi) {
    g.fillStyle = C.glass; g.globalAlpha = 0.5;
    for (var pk = -1; pk <= 1; pk += 2) for (var pi = 0; pi < 9; pi++) {
      g.beginPath(); g.arc(-L * 0.38 + pi * L * 0.085, pk * B * 0.435,
                           Math.max(0.7, B * 0.017), 0, U.TAU); g.fill();
    }
    g.globalAlpha = 1;
  }
}

// 全图档简化剪影（线宽按屏幕像素补偿，避免细线消失）
function paintLow(ctx, s, C, z, k) {
  var L = s.len, B = s.beam;
  hullPath(ctx, L, B, 1); ctx.fillStyle = C.hull; ctx.fill();
  ctx.lineWidth = 1.5 / (z * k); ctx.strokeStyle = C.edge;
  ctx.shadowColor = C.edge; ctx.shadowBlur = 5; ctx.stroke(); ctx.shadowBlur = 0;
  hullPath(ctx, L, B, 0.80); ctx.fillStyle = C.deck; ctx.fill();
  ctx.fillStyle = C.superHi; ctx.fillRect(L * 0.06, -B * 0.20, L * 0.12, B * 0.40);
  var ts = s.turrets || [];
  for (var i = 0; i < ts.length; i++) {
    ctx.fillStyle = C.turretHi;
    ctx.fillRect(ts[i].lx * L - L * 0.045, -B * 0.22, L * 0.09, B * 0.44);
  }
}

// 主炮塔：随 turrets[i].ang 旋转，联装炮管 + 装甲顶盖 + 逐塔装填灯
function paintTurrets(ctx, s, lod, C) {
  var L = s.len, B = s.beam, d = s.def || {}, kind = d.kind || 'dd';
  var ts = s.turrets || [], reloads = s.turretReloads || [];
  var r = B * (kind === 'bb' ? 0.215 : (kind === 'ca' ? 0.195 : 0.17));
  for (var i = 0; i < ts.length; i++) {
    var tu = ts[i], n = tu.barrels || 2;
    ctx.save(); ctx.translate(tu.lx * L, 0); ctx.rotate(tu.ang || 0);
    if (lod === 0) {
      ctx.fillStyle = C.turretHi; ctx.fillRect(-L * 0.045, -B * 0.22, L * 0.09, B * 0.44);
      ctx.fillStyle = C.barrel;   ctx.fillRect(L * 0.045, -B * 0.035, L * 0.075, B * 0.07);
      ctx.restore(); continue;
    }
    var tw = r * (1.45 + n * 0.16), th = r * (1.55 + n * 0.30);
    ctx.save(); ctx.translate(-r * 0.09, r * 0.16);
    ctx.fillStyle = 'rgba(3,12,18,.55)';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(tw, th) * 0.55, 0, U.TAU); ctx.fill(); ctx.restore();
    var bl = r * (kind === 'bb' ? 2.35 : 2.05);
    var gap = Math.min(r * 0.44, th / (n + 0.6)), y0 = -(n - 1) / 2 * gap;
    var bx0 = tw * 0.38, bx1 = tw * 0.5 + bl;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = C.barrelDark; ctx.lineWidth = Math.max(1.1, r * 0.25);
    for (var b = 0; b < n; b++) {
      ctx.beginPath(); ctx.moveTo(bx0, y0 + b * gap); ctx.lineTo(bx1, y0 + b * gap); ctx.stroke();
    }
    ctx.strokeStyle = C.barrel; ctx.lineWidth = Math.max(0.7, r * 0.12);
    for (var b2 = 0; b2 < n; b2++) {
      ctx.beginPath(); ctx.moveTo(bx0, y0 + b2 * gap); ctx.lineTo(bx1, y0 + b2 * gap); ctx.stroke();
    }
    ctx.fillStyle = C.barrelDark;
    for (var b3 = 0; b3 < n; b3++)
      ctx.fillRect(bx1 - r * 0.16, y0 + b3 * gap - r * 0.145, r * 0.22, r * 0.29);
    // 炮口焰（刚开火的那一座塔）
    if (lod === 2 && s.muzzle > 0 && s.turretReloadMax > 0 && reloads[i] > s.turretReloadMax * 0.88) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,220,150,.85)';
      for (var b4 = 0; b4 < n; b4++) {
        ctx.beginPath(); ctx.arc(bx1 + r * 0.16, y0 + b4 * gap, r * 0.24, 0, U.TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    turretShape(ctx, tw, th);
    ctx.fillStyle = C.turret; ctx.fill();
    ctx.lineWidth = Math.max(0.9, B * 0.022); ctx.strokeStyle = C.turretHi; ctx.stroke();
    ctx.save(); ctx.scale(0.70, 0.70); turretShape(ctx, tw, th);
    ctx.fillStyle = C.turretHi; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1; ctx.restore();
    ctx.strokeStyle = C.turretLo; ctx.lineWidth = Math.max(0.8, B * 0.018);
    ctx.beginPath(); ctx.moveTo(-tw * 0.42, 0); ctx.lineTo(tw * 0.40, 0); ctx.stroke();
    if (lod === 2) {
      for (var er = -1; er <= 1; er += 2)
        box(ctx, -tw * 0.18, er * th * 0.5 - r * 0.10, tw * 0.34, r * 0.20, r * 0.06,
            C.turretLo, C.turretHi, 0.7);
      ctx.fillStyle = C.turretLo;
      ctx.beginPath(); ctx.arc(-tw * 0.28, 0, Math.max(1, r * 0.10), 0, U.TAU); ctx.fill();
    }
    var ready = !(reloads[i] > 0);
    ctx.fillStyle = ready ? C.ready : 'rgba(255,158,80,.75)';
    ctx.beginPath(); ctx.arc(tw * 0.22, 0, Math.max(1.1, r * 0.11), 0, U.TAU); ctx.fill();
    ctx.restore();
  }
}

// 鱼雷发射管座：左右舷交替布置，联装管束 + 逐座就绪灯
function paintTorpMounts(ctx, s, lod, C) {
  var d = s.def || {}, n = d.torpSalvos || 0, tubes = d.torpMount || 3;
  if (!n) return;
  var L = s.len, B = s.beam, dd = (d.kind === 'dd'), reloads = s.torpMountReloads || [];
  for (var i = 0; i < n; i++) {
    var mx = dd ? L * (0.06 - i * 0.16) : L * (-0.03 - Math.floor(i / 2) * 0.18);
    var side = (i % 2 === 0) ? -1 : 1;
    var my = dd ? side * B * 0.13 : side * B * 0.27;
    var ready = !(reloads[i] > 0);
    ctx.save(); ctx.translate(mx, my); ctx.rotate(side * (dd ? 0.06 : 0.18));
    if (lod === 0) {
      ctx.fillStyle = ready ? C.tubeEdge : C.turretLo;
      ctx.fillRect(-L * 0.05, -B * 0.13, L * 0.10, B * 0.26);
      ctx.restore(); continue;
    }
    var mw = L * (dd ? 0.115 : 0.135), mh = B * 0.30;
    box(ctx, -mw / 2, -mh / 2, mw, mh, B * 0.05, C.metalDark, C.tubeEdge, Math.max(0.8, B * 0.02));
    ctx.fillStyle = C.turretLo;
    ctx.beginPath(); ctx.arc(0, 0, mh * 0.34, 0, U.TAU); ctx.fill();
    var tw = mw * 0.80, g2 = mh * 0.60 / tubes, tubeW = g2 * 0.66;
    for (var b = 0; b < tubes; b++) {
      var ty = -(tubes - 1) / 2 * g2 + b * g2;
      box(ctx, -tw / 2, ty - tubeW / 2, tw, tubeW, tubeW * 0.45, C.tube, C.tubeEdge, 0.7);
      ctx.fillStyle = ready ? C.ready : C.funnelTop;
      ctx.fillRect(tw / 2 - tubeW * 0.55, ty - tubeW * 0.36, tubeW * 0.55, tubeW * 0.72);
    }
    ctx.restore();
  }
}

// 起火：舰体橙色辉光 + 沿甲板跳动的火团
function paintFire(ctx, s, t, C) {
  var L = s.len, B = s.beam;
  var stacks = Math.max(1, s.fireStacks || 1);
  ctx.globalCompositeOperation = 'lighter';
  var fg = ctx.createRadialGradient(0, 0, 0, 0, 0, L * 0.62);
  fg.addColorStop(0, 'rgba(255,120,40,' + (0.14 + stacks * 0.06).toFixed(2) + ')');
  fg.addColorStop(0.55, 'rgba(255,90,30,.09)');
  fg.addColorStop(1, 'rgba(255,90,30,0)');
  ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, 0, L * 0.62, 0, U.TAU); ctx.fill();
  for (var f = 0; f < 7; f++) {
    var fa = f * 1.05 + t * 1.6, fr = L * (0.08 + (f % 3) * 0.14);
    var fx2 = Math.cos(fa) * fr, fy2 = Math.sin(fa) * B * 0.38;
    var rr2 = (3 + Math.abs(Math.sin(t * 9 + f * 2.1)) * 3.6) * (0.8 + stacks * 0.2);
    ctx.fillStyle = f % 2 ? 'rgba(255,150,50,.6)' : 'rgba(255,228,145,.65)';
    ctx.beginPath(); ctx.arc(fx2, fy2, rr2, 0, U.TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

IT.drawShip = function (ctx, s, t, z, minPx) {
  z = z || 1;
  var L = s.len, B = s.beam;
  // 全图视角下舰体只有几像素，按最小屏幕长度放大外形（血条单独按原缩放补偿）
  var k = minPx ? Math.max(1, minPx / Math.max(1, L * z)) : 1;
  var screenLen = L * z * k;
  var lod = screenLen < 34 ? 0 : (screenLen < 84 ? 1 : 2);
  var C = shipPal(s);
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.ang + (s.sunk ? s.sinkRoll : 0));
  if (k > 1) ctx.scale(k, k);
  ctx.globalAlpha = s.sunk ? U.clamp(0.75 - s.sinkTime * 0.09, 0.08, 0.75) : 1;
  ctx.shadowBlur = 0;
  if (lod === 0) paintLow(ctx, s, C, z, k);
  else {
    var sp = shipSprite(s, lod, C);
    ctx.drawImage(sp.c, -sp.ox, -sp.oy, sp.ox * 2, sp.oy * 2);
  }
  paintTurrets(ctx, s, lod, C);
  paintTorpMounts(ctx, s, lod, C);
  if (s.fire > 0 && !s.sunk) paintFire(ctx, s, t, C);
  ctx.restore();

  // 舰名 / 血条（屏幕朝向，不随舰体旋转；按镜头缩放补偿，保持恒定屏幕尺寸）
  if (!s.sunk) {
    // 全图档：隐去舰名、缩短血条，避免十几条标签在地图中央叠成一团
    var overview = lod === 0;
    var by = s.y - B * 0.5 - (overview ? 9 : 20) / z;
    var bw = Math.max(overview ? 12 : 48, L * z * 0.8);
    ctx.save();
    ctx.translate(s.x, by);
    ctx.scale(1 / z, 1 / z);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(2,12,20,.75)';
    ctx.fillRect(-bw / 2 - 1, -1, bw + 2, 5);
    ctx.fillStyle = C.edge;
    ctx.fillRect(-bw / 2, 0, bw * U.clamp(s.hp / s.maxHp, 0, 1), 3);
    if (!s.isPlayer && !overview) {
      ctx.font = '9px Consolas,monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = s.team === 0 ? 'rgba(165,235,200,.8)' : 'rgba(230,240,250,.75)';
      ctx.fillText(s.short + '  ' + Math.ceil(s.hp / s.maxHp * 100) + '%', 0, -5);
    }
    ctx.restore();
    if (s.isPlayer && overview) {   // 全图下用屏幕尺寸的圆环标出本舰
      ctx.save();
      ctx.strokeStyle = 'rgba(111,227,255,.9)'; ctx.lineWidth = 1.4 / z;
      ctx.beginPath(); ctx.arc(s.x, s.y, 10 / z, 0, U.TAU); ctx.stroke();
      ctx.restore();
    }
  }
};

IT.drawWake = function (ctx, s) {
  if (!s.wake || s.wake.length < 2) return;
  var ally = s.team === 0;
  ctx.save();
  ctx.lineCap = 'round';
  for (var i = 1; i < s.wake.length; i++) {
    var a = s.wake[i - 1], b = s.wake[i];
    var age = b.age;
    var alpha = U.clamp((1 - age / 3.4) * 0.42, 0, 0.42);
    if (alpha <= 0) continue;
    ctx.strokeStyle = ally ? 'rgba(190,235,250,' + alpha.toFixed(3) + ')' : 'rgba(235,215,205,' + (alpha * 0.7).toFixed(3) + ')';
    ctx.lineWidth = 3 + age * 5.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (var j = 0; j < s.wake.length; j++) {
    var p = s.wake[j];
    var al = U.clamp((1 - p.age / 3.4) * 0.4, 0, 0.4);
    if (al <= 0) continue;
    ctx.fillStyle = 'rgba(210,240,250,' + al.toFixed(3) + ')';
    var spread = p.age * 7;
    ctx.beginPath(); ctx.arc(p.x + p.nx * spread, p.y + p.ny * spread, 1.5 + p.age * 1.6, 0, U.TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x - p.nx * spread, p.y - p.ny * spread, 1.5 + p.age * 1.6, 0, U.TAU); ctx.fill();
  }
  ctx.restore();
};

})(window);

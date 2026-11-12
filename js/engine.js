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

/* ---------------- 海面纹理 ---------------- */
IT.makeSeaTexture = function (size) {
  size = size || 512;
  var c = document.createElement('canvas'); c.width = c.height = size;
  var g = c.getContext('2d');
  var grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#0b2d42'); grad.addColorStop(0.5, '#0a263a'); grad.addColorStop(1, '#082033');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  // 大量短波纹
  for (var i = 0; i < 900; i++) {
    var x = Math.random() * size, y = Math.random() * size;
    var w = U.rand(6, 42), h = U.rand(0.5, 1.6);
    var light = Math.random() > 0.55;
    g.strokeStyle = light ? 'rgba(126,205,231,' + U.rand(0.018, 0.075).toFixed(3) + ')'
                          : 'rgba(0,8,18,' + U.rand(0.025, 0.1).toFixed(3) + ')';
    g.lineWidth = h;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + w * 0.5, y + U.rand(-2, 2), x + w, y);
    g.stroke();
  }
  // 细噪点
  for (var j = 0; j < 1400; j++) {
    g.fillStyle = Math.random() > 0.5 ? 'rgba(180,225,240,.018)' : 'rgba(0,0,0,.03)';
    g.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
  return c;
};
IT.makeCurrentTexture = function (size) {
  size = size || 512;
  var c = document.createElement('canvas'); c.width = c.height = size;
  var g = c.getContext('2d');
  for (var i = 0; i < 70; i++) {
    var y = Math.random() * size, w = U.rand(60, 260);
    g.strokeStyle = 'rgba(140,215,240,' + U.rand(0.008, 0.028).toFixed(3) + ')';
    g.lineWidth = U.rand(1, 5);
    g.beginPath(); g.moveTo(Math.random() * size, y);
    g.bezierCurveTo(w * 0.3, y - 8, w * 0.7, y + 8, w, y + 2); g.stroke();
  }
  return c;
};

/* ---------------- 舰船矢量绘制 ---------------- */
var HULL = [
  [0.50, 0.00], [0.41, -0.27], [0.24, -0.44], [-0.16, -0.5],
  [-0.43, -0.44], [-0.5, -0.3], [-0.5, 0.3], [-0.43, 0.44],
  [-0.16, 0.5], [0.24, 0.44], [0.41, 0.27]
];

function hullPath(ctx, L, B, scale) {
  ctx.beginPath();
  for (var i = 0; i < HULL.length; i++) {
    var x = HULL[i][0] * L * scale, y = HULL[i][1] * B * scale;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

IT.drawShip = function (ctx, s, t, z) {
  z = z || 1;
  var L = s.len, B = s.beam;
  var ally = s.team === 0;
  // 本舰青蓝、友军青绿、敌舰橙红，多舰混战时一眼可分
  var main = s.isPlayer ? '#63d9f5' : (ally ? '#8ce0b4' : '#ff8069');
  var deck = s.sunk ? '#2b3940' : (s.isPlayer ? '#2c5568' : (ally ? '#274e4a' : '#5b3638'));
  var hull = s.sunk ? '#1a252b' : (ally ? '#163a4c' : '#432329');

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.ang + (s.sunk ? s.sinkRoll : 0));
  ctx.globalAlpha = s.sunk ? U.clamp(0.75 - s.sinkTime * 0.09, 0.08, 0.75) : 1;

  // 水下阴影
  ctx.save();
  ctx.translate(-3, 7);
  ctx.fillStyle = 'rgba(0,8,14,.42)';
  hullPath(ctx, L, B, 1.07); ctx.fill();
  ctx.restore();

  // 船体
  hullPath(ctx, L, B, 1);
  ctx.fillStyle = hull; ctx.fill();
  ctx.lineWidth = 2.4 / z; ctx.strokeStyle = main;
  ctx.shadowColor = main; ctx.shadowBlur = ally ? 14 : 10;
  ctx.stroke(); ctx.shadowBlur = 0;

  // 甲板
  hullPath(ctx, L, B, 0.86);
  ctx.fillStyle = deck; ctx.fill();
  ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(190,225,240,.22)'; ctx.stroke();

  // 中线 + 甲板纹理
  ctx.strokeStyle = 'rgba(190,225,240,.13)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-L * 0.46, 0); ctx.lineTo(L * 0.42, 0); ctx.stroke();
  for (var i = -3; i <= 3; i++) {
    var px = i * L * 0.11;
    ctx.beginPath(); ctx.moveTo(px, -B * 0.3); ctx.lineTo(px, B * 0.3); ctx.stroke();
  }

  // 舰桥 / 上层建筑
  ctx.fillStyle = ally ? '#3d6e82' : '#764043';
  ctx.strokeStyle = 'rgba(220,240,250,.3)'; ctx.lineWidth = 0.8;
  ctx.fillRect(L * 0.05, -B * 0.24, L * 0.14, B * 0.48); ctx.strokeRect(L * 0.05, -B * 0.24, L * 0.14, B * 0.48);
  ctx.fillStyle = ally ? '#8fc4d6' : '#d09288';
  ctx.fillRect(L * 0.1, -B * 0.13, L * 0.05, B * 0.26);
  // 烟囱
  ctx.fillStyle = ally ? '#224a5c' : '#3c2226';
  ctx.fillRect(-L * 0.2, -B * 0.12, L * 0.055, B * 0.24);
  ctx.fillRect(-L * 0.3, -B * 0.09, L * 0.045, B * 0.18);
  // 舰艉
  ctx.fillStyle = ally ? '#35657a' : '#63373a';
  ctx.fillRect(-L * 0.46, -B * 0.2, L * 0.055, B * 0.4);

  // 炮塔
  for (var k = 0; k < s.turrets.length; k++) {
    var tu = s.turrets[k];
    ctx.save();
    ctx.translate(tu.lx * L, 0);
    ctx.rotate(tu.ang);
    var r = Math.max(3.2, B * 0.17);
    ctx.fillStyle = ally ? '#4a7e92' : '#8a4b48';
    ctx.strokeStyle = main; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, U.TAU); ctx.fill(); ctx.stroke();
    // 多联装炮管（1~4 管），BB 主炮管更长
    var n = tu.barrels || 2;
    var gap = n >= 4 ? r * 0.34 : r * 0.42;
    var y0 = -(n - 1) / 2 * gap;
    var bl = r * ((s.def && s.def.kind === 'bb') ? 3.0 : 2.5);
    ctx.strokeStyle = ally ? '#b9e9f8' : '#f2b7a8';
    ctx.lineWidth = Math.max(1.1, r * 0.19);
    for (var b = 0; b < n; b++) {
      ctx.beginPath(); ctx.moveTo(r * 0.2, y0 + b * gap); ctx.lineTo(bl, y0 + b * gap); ctx.stroke();
    }
    ctx.restore();
  }

  // 起火时的火光
  if (s.fire > 0 && !s.sunk) {
    var fx = L * 0.1;
    ctx.globalCompositeOperation = 'lighter';
    for (var f = 0; f < 3; f++) {
      var yy = Math.sin(t * 9 + f * 2.1) * B * 0.16;
      ctx.fillStyle = 'rgba(255,' + (120 + f * 40) + ',40,.5)';
      ctx.beginPath(); ctx.arc(fx + f * 5, yy, 3 + Math.sin(t * 12 + f) * 1.5, 0, U.TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  // 舰名 / 血条（屏幕朝向，不随舰体旋转；按镜头缩放补偿，保持恒定屏幕尺寸）
  if (!s.sunk) {
    var by = s.y - B * 0.5 - 20 / z;
    var bw = Math.max(48, L * z * 0.8);
    ctx.save();
    ctx.translate(s.x, by);
    ctx.scale(1 / z, 1 / z);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(2,12,20,.75)';
    ctx.fillRect(-bw / 2 - 1, -1, bw + 2, 5);
    ctx.fillStyle = main;
    ctx.fillRect(-bw / 2, 0, bw * U.clamp(s.hp / s.maxHp, 0, 1), 3);
    if (!s.isPlayer) {
      ctx.font = '9px Consolas,monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = ally ? 'rgba(165,235,200,.8)' : 'rgba(230,240,250,.75)';
      ctx.fillText(s.short + '  ' + Math.ceil(s.hp / s.maxHp * 100) + '%', 0, -5);
    }
    ctx.restore();
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

/* =========================================================
   IRON TIDE · game.js
   海战玩法：操舰 / 炮击 / 鱼雷 / AI / HUD / 主循环
   ========================================================= */
(function () {
'use strict';

var U = IT.util;
var $ = function (id) { return document.getElementById(id); };

/* ---------------- DOM ---------------- */
var canvas = $('sea'), ctx = canvas.getContext('2d');
var mapCv = $('minimap'), mctx = mapCv.getContext('2d');
var seaPattern, currentPattern;

/* ---------------- 参数 ---------------- */
var WORLD = 22000;
var SHELL_SPEED = 1500;             // 炮弹水平速度（世界单位/秒）：统一较高初速，使长射程炮弹飞行时间仍合理
var TORP_SPEED = 165;               // 鱼雷基础航速（实际被每舰 torpSpeed 覆盖）
// 世界尺度：1 km = 187 世界单位 → 与真实射程一致（睦月 8.1km = 1515u；转向半径 550m = 102.9u）
var KM2U = 187;
var M_PER_U = 1 / KM2U;             // 世界单位 → 公里（用于 HUD 距离显示）
var TORP_K = 165 / 60;              // 鱼雷：60 节 ≈ 165 u/s
function K(km) { return Math.round(km * KM2U); }                  // km → 世界单位
function SP(knots) { return knots * 3.6 / 154; }                 // 节 → 速度倍率（极速档显示正确节数）
function TR(knots, rM) { return (knots * 3.6) / (rM * (KM2U / 1000)); } // 转向半径(米) → 角速率
function RR(sec) { return 1 / sec; }                             // 转舵时间(秒) → 转舵速率
function TS(knots) { return knots * TORP_K; }                    // 鱼雷节 → 世界单位/秒
var GEAR_SPEED = [-44, 0, 50, 84, 120, 154];  // gear -1..4 → 目标速度
var GEAR_NAME = ['倒车', '停车', '微速', '半速', '全速', '极速'];

/* ---------------- 战斗节奏 ----------------
   默认「慢节奏」：世界时间流速降到 40%，敌方火力更稀疏、预判更粗糙，本舰更耐打。
   按 T 或点右侧节奏按钮可随时切换；HUD 上的所有秒数都按真实时间换算显示。
   time        全局时间流速倍率（船体位移 / 转向 / 弹丸 / AI / 海面动画）
   enemyReload 敌方装填时长（游戏秒）；真实感知间隔 = base × enemyReload / time
   enemyDmg    敌方伤害 / enemySigma 敌方散布 / enemyLead 敌方预判误差
   torpSpeed   鱼雷航速倍率（慢档不再额外减速，避免双重降速让鱼雷失去战术意义）
   playerHp    本舰耐久 / playerDmg 本舰火力
   playerReload 本舰装填补偿：真实装填 = base × playerReload / time；
                慢档设为 time（0.2）→ 玩家按舰船“列出装填”真实间隔装填，节奏与世界一致不失衡
   aiTorpCd    敌方鱼雷间隔（按真实秒计时，不随流速拉长）
   注意：舵角 / 炮塔 / 车钟加速仍按真实时间响应，慢的是世界，不是玩家的操作。
------------------------------------------- */
var PACES = {
  slow: {
    label: '慢节奏', short: '慢', time: 0.2,
    enemyReload: 0.9, enemyDmg: 0.6, enemySigma: 1.7, enemyLead: 1.3,
    torpSpeed: 1, playerHp: 1, playerDmg: 1.1, playerReload: 0.2, aiTorpCd: 1.25
  },
  normal: {
    label: '标准', short: '标', time: 1,
    enemyReload: 1, enemyDmg: 1, enemySigma: 1.3, enemyLead: 1,
    torpSpeed: 1, playerHp: 1, playerDmg: 1, playerReload: 1, aiTorpCd: 1
  }
};
var P = function () { return PACES[G.pace]; };
// 真实秒 → 游戏秒：给「希望按真实时间计」的计时器使用（不受节奏流速拖长）
function paceSec(sec) { return sec * P().time; }

/* ---------------- 舰船数据（9 艘 · 全部完全体 · 简化机制）----------------
   数值换算：
     · 射程 / 转向半径：1 km = 187 世界单位（KM2U）→ 真实射程 8.1km = 1515u
     · 航速：speedScale = 节 × 3.6 / 154（极速档在 HUD 显示正确节数）
     · 转向半径(米) → 角速率：TR(节, 半径米)
     · 转舵时间(秒) → 转舵速率：RR(秒)
     · 鱼雷节 → 世界单位/秒：TS(节)  （60 节 ≈ 165 u/s）
     · 炮弹初速：vel = m/s × 1.875（统一较高初速，长射程飞行时间仍合理）
   机制：不做雷达 / 水听 / 维修；炮弹为实体投射物，带飞行时间 + 下坠（弧线）；
        要害命中 ×2；HE / AP 双弹种可切换。
------------------------------------------------------------- */
var VS = 1500 / 800;   // 初速换算：800 m/s ≈ 1500 世界单位/秒
var PLAYER_SHIPS = [
  /* ===== 驱逐舰 ===== */
  {
    key: 'mutsuki', name: '睦月', romaji: 'MUTSUKI', tag: 'DD · 驱逐舰', short: 'DD 睦月',
    desc: '高机动 · 鱼雷突击', kind: 'dd', len: 150, beam: 26,
    maxHp: 11300, knots: 37.5, speedScale: SP(37.5), turnR: 550, maxTurn: TR(37.5, 550),
    rudderShift: 2.1, rudderRate: RR(2.1), accel: 31,
    turrets: [{ lx: -0.34, barrels: 1 }, { lx: 0.34, barrels: 1 }],
    reload: 5.5, he: 1700, ap: 2000, sigma: 14, range: K(8.1), vel: Math.round(900 * VS),
    torpTubes: 6, torpDmg: 14600, torpReload: 65, torpSpeed: TS(63), torpRange: K(8),
    specials: { smoke: true }, prefer: 700,
    gunLabel: '120mm ×2 · 900m/s', torpLabel: '610mm 3联装 ×2'
  },
  {
    key: 'farragut', name: '法拉格特', romaji: 'FARRAGUT', tag: 'DD · 驱逐舰', short: 'DD 法拉格特',
    desc: '高射速 · 鱼雷突击', kind: 'dd', len: 152, beam: 27,
    maxHp: 10700, knots: 35, speedScale: SP(35), turnR: 520, maxTurn: TR(35, 520),
    rudderShift: 2.4, rudderRate: RR(2.4), accel: 30,
    turrets: [{ lx: -0.4, barrels: 1 }, { lx: -0.13, barrels: 1 }, { lx: 0.13, barrels: 1 }, { lx: 0.4, barrels: 1 }],
    reload: 4.5, he: 1800, ap: 2100, sigma: 14, range: K(7.6), vel: Math.round(800 * VS),
    torpTubes: 6, torpDmg: 11200, torpReload: 52, torpSpeed: TS(56), torpRange: K(5.5),
    specials: { smoke: true }, prefer: 700,
    gunLabel: '127mm ×4 · 800m/s', torpLabel: '533mm 3联装 ×2'
  },
  {
    key: 'lightning', name: '闪电', romaji: 'LIGHTNING', tag: 'DD · 驱逐舰', short: 'DD 闪电',
    desc: '高机动 · 引擎增压', kind: 'dd', len: 158, beam: 27,
    maxHp: 13200, knots: 36, speedScale: SP(36), turnR: 590, maxTurn: TR(36, 590),
    rudderShift: 3.8, rudderRate: RR(3.8), accel: 30,
    turrets: [{ lx: -0.4, barrels: 1 }, { lx: -0.13, barrels: 1 }, { lx: 0.13, barrels: 1 }, { lx: 0.4, barrels: 1 }],
    reload: 5, he: 1900, ap: 2200, sigma: 14, range: K(8.4), vel: Math.round(900 * VS),
    torpTubes: 8, torpDmg: 12800, torpReload: 60, torpSpeed: TS(60), torpRange: K(9),
    specials: { smoke: true, boost: true }, prefer: 700,
    gunLabel: '120mm ×4 · 900m/s', torpLabel: '533mm 4联装 ×2'
  },
  /* ===== 巡洋舰 ===== */
  {
    key: 'cleveland', name: '克利夫兰', romaji: 'CLEVELAND', tag: 'CL · 轻巡洋舰', short: 'CL 克利夫兰',
    desc: '高射速 · 中距压制', kind: 'ca', len: 205, beam: 38,
    maxHp: 35200, knots: 32.5, speedScale: SP(32.5), turnR: 660, maxTurn: TR(32.5, 660),
    rudderShift: 7.2, rudderRate: RR(7.2), accel: 18,
    turrets: [{ lx: -0.36, barrels: 3 }, { lx: -0.12, barrels: 3 }, { lx: 0.12, barrels: 3 }, { lx: 0.36, barrels: 3 }],
    reload: 6.5, he: 2200, ap: 3200, sigma: 18, range: K(14.2), vel: Math.round(812 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: {}, prefer: 1100,
    gunLabel: '152mm ×12 · 812m/s', torpLabel: '未装备'
  },
  {
    key: 'myoko', name: '妙高', romaji: 'MYŌKŌ', tag: 'CA · 重巡洋舰', short: 'CA 妙高',
    desc: '重炮 · 鱼雷重袭', kind: 'ca', len: 215, beam: 40,
    maxHp: 39600, knots: 33.5, speedScale: SP(33.5), turnR: 680, maxTurn: TR(33.5, 680),
    rudderShift: 8.6, rudderRate: RR(8.6), accel: 16,
    turrets: [{ lx: -0.42, barrels: 2 }, { lx: -0.21, barrels: 2 }, { lx: 0, barrels: 2 }, { lx: 0.21, barrels: 2 }, { lx: 0.42, barrels: 2 }],
    reload: 12, he: 3300, ap: 4700, sigma: 18, range: K(15.2), vel: Math.round(840 * VS),
    torpTubes: 8, torpDmg: 15100, torpReload: 70, torpSpeed: TS(62), torpRange: K(10),
    specials: {}, prefer: 1150,
    gunLabel: '203mm ×10 · 840m/s', torpLabel: '610mm 4联装 ×2'
  },
  {
    key: 'atago', name: '爱宕', romaji: 'ATAGO', tag: 'CA · 重巡洋舰', short: 'CA 爱宕',
    desc: '重炮 · 烟雾掩护', kind: 'ca', len: 213, beam: 40,
    maxHp: 40100, knots: 34.5, speedScale: SP(34.5), turnR: 700, maxTurn: TR(34.5, 700),
    rudderShift: 9, rudderRate: RR(9), accel: 16,
    turrets: [{ lx: -0.42, barrels: 2 }, { lx: -0.21, barrels: 2 }, { lx: 0, barrels: 2 }, { lx: 0.21, barrels: 2 }, { lx: 0.42, barrels: 2 }],
    reload: 11.5, he: 3400, ap: 4800, sigma: 18, range: K(15.8), vel: Math.round(840 * VS),
    torpTubes: 16, torpDmg: 17233, torpReload: 101, torpSpeed: TS(62), torpRange: K(10),
    specials: { smoke: true }, prefer: 1150,
    gunLabel: '203mm ×10 · 840m/s', torpLabel: '610mm 4联装 ×4'
  },
  /* ===== 战列舰 ===== */
  {
    key: 'nagato', name: '长门', romaji: 'NAGATO', tag: 'BB · 战列舰', short: 'BB 长门',
    desc: '巨炮 · 超远射程', kind: 'bb', len: 250, beam: 50,
    maxHp: 65000, knots: 25, speedScale: SP(25), turnR: 770, maxTurn: TR(25, 770),
    rudderShift: 13.7, rudderRate: RR(13.7), accel: 12,
    turrets: [{ lx: -0.4, barrels: 2 }, { lx: -0.13, barrels: 2 }, { lx: 0.13, barrels: 2 }, { lx: 0.4, barrels: 2 }],
    reload: 29, he: 6500, ap: 12600, sigma: 24, range: K(20.5), vel: Math.round(806 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: {}, prefer: 1400,
    gunLabel: '410mm ×8 · 806m/s', torpLabel: '未装备'
  },
  {
    key: 'bismarck', name: '俾斯麦', romaji: 'BISMARCK', tag: 'BB · 战列舰', short: 'BB 俾斯麦',
    desc: '重炮 · 自动副炮', kind: 'bb', len: 268, beam: 52,
    maxHp: 69000, knots: 30, speedScale: SP(30), turnR: 740, maxTurn: TR(30, 740),
    rudderShift: 12.2, rudderRate: RR(12.2), accel: 13,
    turrets: [{ lx: -0.4, barrels: 2 }, { lx: -0.13, barrels: 2 }, { lx: 0.13, barrels: 2 }, { lx: 0.4, barrels: 2 }],
    reload: 24, he: 5400, ap: 11300, sigma: 24, range: K(20), vel: Math.round(820 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: { secondary: true, secRange: K(3.5), secDmg: 520, secReload: 0.9 }, prefer: 1400,
    gunLabel: '380mm ×8 · 820m/s', torpLabel: '未装备'
  },
  {
    key: 'york', name: '约克公爵', romaji: 'YORK', tag: 'BB · 战列舰', short: 'BB 约克公爵',
    desc: '重炮 · 高均质防护', kind: 'bb', len: 255, beam: 50,
    maxHp: 60500, knots: 28, speedScale: SP(28), turnR: 750, maxTurn: TR(28, 750),
    rudderShift: 13, rudderRate: RR(13), accel: 12,
    turrets: [{ lx: -0.42, barrels: 4 }, { lx: 0, barrels: 2 }, { lx: 0.42, barrels: 4 }],
    reload: 22.5, he: 5100, ap: 11000, sigma: 24, range: K(19.2), vel: Math.round(757 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: {}, prefer: 1400,
    gunLabel: '356mm ×10 · 757m/s', torpLabel: '未装备'
  }
];
var SHIP_KEYS = PLAYER_SHIPS.map(function (s) { return s.key; });
var KIND_KEYS = { dd: [], ca: [], bb: [] };
PLAYER_SHIPS.forEach(function (s) { KIND_KEYS[s.kind].push(s.key); });
function shipDef(key) {
  for (var i = 0; i < PLAYER_SHIPS.length; i++) if (PLAYER_SHIPS[i].key === key) return PLAYER_SHIPS[i];
  return PLAYER_SHIPS[0];
}
function playerDef(key) { return shipDef(key); }

/* ---------------- 全局状态 ---------------- */
var G = {
  state: 'menu',            // menu | play | over
  paused: false,
  pace: 'slow',             // slow | normal
  fleet: { ship: 'mutsuki', allies: 5, enemies: 6 },   // 默认编成 友:敌 = 6:6（本舰 + 5 友军 vs 6 敌舰）
  spawnSeq: 0, nameSeq: 0,
  time: 0, realTime: 0, visTime: 0, endTimer: -1, win: false,
  ships: [], shells: [], torps: [], floats: [], reefs: [], clouds: [], smokes: [],
  particles: new IT.Particles(),
  sound: new IT.Sound(),
  voice: new IT.Voice(),
  commander: '大肥鱼',
  cam: { x: WORLD / 2, y: WORLD / 2 },
  zoom: 1, baseZoom: 1, userZoom: 1, w: 0, h: 0, dpr: 1,
  shake: 0, hitFlash: 0, tipCd: 0,
  mouse: { sx: 0, sy: 0, wx: 0, wy: 0, has: false },
  keys: {}, heldFire: false, heldTorp: false, assist: false,
  stats: { shots: 0, hits: 0, damage: 0, kills: 0 },
  toastTimer: 0
};
window.G = G;   // 暴露为全局，供 engine.js 的 Sound/Voice 访问
// 调试/自动化测试钩子（零依赖，无副作用）
window.__game = { WORLD: WORLD, losBlocked: losBlocked, terrainHard: terrainHard, terrainAny: terrainAny, bigExplosion: bigExplosion, addShake: addShake, Shell: Shell, Torpedo: Torpedo };

/* ---------------- 实体 ---------------- */
function Ship(type, x, y, ang, team, isPlayer) {
  var d = shipDef(type);   // 统一数据源：9 艘完全体舰船（玩家 / 友军 / 敌舰共用）
  this.type = type; this.def = d; this.team = team; this.isPlayer = !!isPlayer;
  this.name = d.name; this.short = d.short;
  this.len = d.len; this.beam = d.beam;
  this.maxHp = isPlayer ? Math.round(d.maxHp * P().playerHp)
             : (team === 0 ? Math.round(d.maxHp * 1.15) : d.maxHp);
  this.hp = this.maxHp;
  this.x = x; this.y = y; this.ang = ang;
  this.speed = 0; this.gear = isPlayer ? 1 : 3;
  this.rudder = 0; this.rudderTarget = 0;
  this.rudderRate = d.rudderRate || 2.6;
  this.vx = 0; this.vy = 0;
  this.ammo = 'he';               // 当前弹种：he / ap
  // AI 舰开局留出接敌缓冲；按真实秒计时，慢档下不会被拉成十几秒空场
  this.reload = isPlayer ? 0 : paceSec(U.rand(8, 13) * (team === 1 ? P().enemyReload : 1));
  this.torpReload = 0;
  this.reloadMax = Math.max(this.reload, 1); this.torpReloadMax = 1;
  this.fire = 0; this.flood = 0;
  this.sunk = false; this.sinkTime = 0; this.sinkRoll = 0;
  this.wake = []; this.wakeTick = 0;
  this.turrets = d.turrets.map(function (p) { return { lx: p.lx, barrels: p.barrels, ang: 0, target: 0 }; });
  // 特技状态（冷却按真实秒计）
  this.smokeCd = 0; this.smokeTime = 0;
  this.boostCd = 0; this.boostTime = 0;
  this.secReload = 0;             // 自动副炮（俾斯麦）
  this.ai = {
    orbit: Math.random() > 0.5 ? 1 : -1,
    think: 0, desiredAng: ang, nextTurn: 0,
    torpCd: paceSec(U.rand(15, 23) * P().aiTorpCd),
    smokeAt: U.rand(0.3, 0.55)    // 血量低于该比例时 AI 自动施放烟雾
  };
  this.muzzle = 0;
  this.groundCd = 0;             // 触礁保护冷却（真实秒）
}
Ship.prototype.turretWorld = function (i) {
  var t = this.turrets[i];
  var c = Math.cos(this.ang), s = Math.sin(this.ang);
  var lx = t.lx * this.len;
  return { x: this.x + lx * c, y: this.y + lx * s, ang: this.ang + t.ang };
};
Ship.prototype.setGear = function (g) {
  g = U.clamp(g, -1, 4);
  if (g !== this.gear) {
    var up = g > this.gear;
    this.gear = g;
    if (this.team === 0) {
      G.sound.ui(up);
      if (G.voice) {
        if (g === 4) G.voice.say('speed_full', 200);
        else if (g === 0) G.voice.say('speed_stop', 200);
        else G.voice.say(up ? 'speed_up' : 'speed_down');
      }
    }
  }
  syncThrottle();
};
Ship.prototype.update = function (dt) {
  if (this.sunk) {
    this.sinkTime += dt;
    this.sinkRoll += dt * 0.22;
    this.x += Math.cos(this.ang) * this.speed * dt * 0.2;
    this.y += Math.sin(this.ang) * this.speed * dt * 0.2;
    this.speed *= Math.pow(0.35, dt);
    if (this.sinkTime < 4 && Math.random() < dt * 12) {
      G.particles.add({ x: this.x + U.rand(-this.len * 0.3, this.len * 0.3), y: this.y,
        vx: U.rand(-12, 12), vy: U.rand(-28, -8), life: U.rand(1.2, 2.4), size: U.rand(5, 12),
        color: U.pick(['#4a5358', '#6b7075', '#2c353a']), type: 'smoke', grow: 7, drag: 0.97, alpha: 0.5 });
    }
    return;
  }
  // 状态伤害
  if (this.fire > 0) {
    this.fire -= dt;
    this.hp -= this.maxHp * 0.0055 * dt;
    if (Math.random() < dt * 8) G.particles.add({
      x: this.x + U.rand(-10, 10), y: this.y + U.rand(-6, 6), vx: U.rand(-8, 8), vy: U.rand(-30, -12),
      life: U.rand(0.4, 0.9), size: U.rand(2, 5), color: U.pick(['#ff9a3c', '#ffd070', '#ff6a30']), grow: 3, alpha: 0.8
    });
  }
  if (this.flood > 0) { this.flood -= dt; this.hp -= this.maxHp * 0.007 * dt; }
  if (this.hp <= 0) { sinkShip(this); return; }

  // 舵 / 速度
  // 舵角与炮塔按真实时间响应，慢节奏下操作依旧跟手；船体位移与转向仍按缩放后的时间
  var rdt = dt / P().time;
  this.rudder = U.approach(this.rudder, this.rudderTarget, rdt * this.rudderRate);
  var targetSpeed = GEAR_SPEED[this.gear + 1] * this.def.speedScale
                    * (this.boostTime > 0 ? 1.22 : 1);   // 引擎增压期间极速提升
  // 车钟按真实时间加速，避免慢节奏下升档显得迟钝；实际位移仍按缩放时间
  this.speed = U.approach(this.speed, targetSpeed, this.def.accel * rdt * (targetSpeed === 0 ? 1.5 : 1));
  var speedFactor = U.clamp(Math.abs(this.speed) / 70, 0.35, 1);  // 低速也保留可感知的舵效
  var turn = this.rudder * this.def.maxTurn * speedFactor * (this.speed < -1 ? -1 : 1);
  this.ang = U.norm(this.ang + turn * dt);

  var px = this.x, py = this.y;
  this.x += Math.cos(this.ang) * this.speed * dt;
  this.y += Math.sin(this.ang) * this.speed * dt;
  // 地形：浅滩拖底减速；礁石/岛屿硬碰撞（推离 + 搁浅掉血）
  var ter = terrainAny(this.x, this.y);
  if (ter) {
    if (ter.tier === 0) {
      this.speed *= Math.max(0, 1 - 2.6 * dt);
      if (this.isPlayer && G.tipCd <= 0) { toast('进入浅滩 · 航速受限'); G.tipCd = 8; }
    } else {
      var pa = Math.atan2(this.y - ter.y, this.x - ter.x);
      var need = ter.r * 0.9 + this.beam * 0.42;
      this.x = ter.x + Math.cos(pa) * need;
      this.y = ter.y + Math.sin(pa) * need;
      if (this.groundCd <= 0 && Math.abs(this.speed) > 26) {
        this.groundCd = 3;
        var gDmg = Math.round(Math.abs(this.speed) * 0.4 * (ter.tier === 2 ? 1.6 : 1));
        this.hp -= gDmg;
        G.floats.push({ x: this.x, y: this.y - 18, text: '触礁 -' + U.fmt(gDmg), life: 1.2,
          color: '#ffc46b', crit: true, vy: -20 });
        splash(this.x, this.y, 1.2);
        this.speed *= 0.22;   // 搁浅急停
        if (this.isPlayer) { toast('触礁！舰体受损'); G.shake = Math.min(G.shake + 5, 18); }
      }
      this.speed *= Math.max(0, 1 - 6 * dt);
      if (this.hp <= 0) { sinkShip(this); return; }
    }
  }
  if (this.groundCd > 0) this.groundCd = Math.max(0, this.groundCd - rdt);
  // 边界
  var m = 60;
  if (this.x < m || this.x > WORLD - m || this.y < m || this.y > WORLD - m) {
    this.x = U.clamp(this.x, m, WORLD - m); this.y = U.clamp(this.y, m, WORLD - m);
    this.speed *= 0.6;
    if (this.team === 0 && G.tipCd <= 0) { toast('接近作战海域边界'); G.tipCd = 6; }
  }
  this.vx = (this.x - px) / Math.max(dt, 0.0001);
  this.vy = (this.y - py) / Math.max(dt, 0.0001);

  // 尾迹
  this.wakeTick += dt;
  if (this.wakeTick > 0.055 && Math.abs(this.speed) > 12) {
    this.wakeTick = 0;
    var nx = -Math.sin(this.ang), ny = Math.cos(this.ang);
    this.wake.push({ x: this.x - Math.cos(this.ang) * this.len * 0.48,
                     y: this.y - Math.sin(this.ang) * this.len * 0.48, nx: nx, ny: ny, age: 0 });
    if (this.wake.length > 48) this.wake.shift();
  }
  for (var i = this.wake.length - 1; i >= 0; i--) {
    this.wake[i].age += dt;
    if (this.wake[i].age > 3.4) this.wake.splice(i, 1);
  }

  // 炮塔 / 装填
  var wasReloading = this.reload > 0;
  this.reload = Math.max(0, this.reload - dt);
  this.torpReload = Math.max(0, this.torpReload - dt);
  this.muzzle = Math.max(0, this.muzzle - dt);
  // 特技计时（真实秒）
  if (this.smokeCd > 0) this.smokeCd = Math.max(0, this.smokeCd - rdt);
  if (this.smokeTime > 0) this.smokeTime = Math.max(0, this.smokeTime - rdt);
  if (this.boostCd > 0) this.boostCd = Math.max(0, this.boostCd - rdt);
  if (this.boostTime > 0) this.boostTime = Math.max(0, this.boostTime - rdt);
  if (this.secReload > 0) this.secReload = Math.max(0, this.secReload - rdt);
  // 烟幕生成：拉烟期间舰尾持续吐烟
  if (this.smokeTime > 0) {
    this.smokeTick = (this.smokeTick || 0) - rdt;
    if (this.smokeTick <= 0) { spawnSmokePuffs(this, 1); this.smokeTick = 0.55; }
  }
  if (this.isPlayer && wasReloading && this.reload <= 0) { if (G.voice) G.voice.say('reload_done'); }
  for (var k = 0; k < this.turrets.length; k++) {
    var t = this.turrets[k];
    t.ang = U.norm(t.ang + U.clamp(U.angDiff(t.ang, t.target), -2.4 * rdt, 2.4 * rdt));
  }
};

function Shell(sx, sy, tx, ty, dur, dmg, owner, aiOwned, he) {
  this.sx = sx; this.sy = sy; this.tx = tx; this.ty = ty;
  this.x = sx; this.y = sy; this.px = sx; this.py = sy;
  this.t = 0; this.dur = dur; this.dmg = dmg; this.owner = owner; this.aiOwned = !!aiOwned;
  this.he = !!he;               // HE 有起火几率，AP 无
  this.dist = U.dist(sx, sy, tx, ty);
  this.arc = this.dist * 0.13 + 16;
}
Shell.prototype.update = function (dt) {
  this.px = this.x; this.py = this.y;
  this.t += dt;
  var p = U.clamp(this.t / this.dur, 0, 1);
  this.x = U.lerp(this.sx, this.tx, p);
  this.y = U.lerp(this.sy, this.ty, p);
  if (this.t >= this.dur) { shellImpact(this); return false; }
  return true;
};
Shell.prototype.drawY = function () {
  var p = U.clamp(this.t / this.dur, 0, 1);
  return this.y - Math.sin(p * Math.PI) * this.arc;
};

function Torpedo(x, y, ang, owner, dmg, range, speed, aiOwned) {
  this.x = x; this.y = y; this.ang = ang; this.owner = owner; this.aiOwned = !!aiOwned;
  this.dmg = dmg;
  this.speed = (speed || TORP_SPEED) * P().torpSpeed;
  this.life = range / this.speed; this.maxLife = this.life;
  this.trail = []; this.tick = 0; this.dead = false;
}
Torpedo.prototype.update = function (dt) {
  this.x += Math.cos(this.ang) * this.speed * dt;
  this.y += Math.sin(this.ang) * this.speed * dt;
  this.life -= dt;
  this.tick += dt;
  // 触礁：鱼雷在障碍上引爆
  if (terrainHard(this.x, this.y)) {
    splash(this.x, this.y, 1.2);
    return false;
  }
  if (this.tick > 0.06) {
    this.tick = 0;
    this.trail.push({ x: this.x, y: this.y, a: 1 });
    if (this.trail.length > 48) this.trail.shift();
    if (Math.random() < 0.7) G.particles.add({
      x: this.x, y: this.y, vx: U.rand(-8, 8), vy: U.rand(-8, 8), life: U.rand(0.4, 1.0),
      size: U.rand(1, 2.6), color: 'rgba(205,240,250,.75)', drag: 0.9
    });
  }
  for (var i = 0; i < this.trail.length; i++) this.trail[i].a -= dt * 0.22;
  if (this.life <= 0 || this.x < 0 || this.y < 0 || this.x > WORLD || this.y > WORLD) return false;
  // 命中判定
  for (var j = 0; j < G.ships.length; j++) {
    var s = G.ships[j];
    if (s.sunk || s.team === this.owner) continue;
    var l = U.toLocal(this.x, this.y, s.x, s.y, s.ang);
    if (Math.abs(l.x) < s.len * 0.53 && Math.abs(l.y) < s.beam * 0.5 + 7) {
      applyDamage(s, this.dmg, 'torp', this.owner, false, this.aiOwned);
      bigExplosion(this.x, this.y, true);
      return false;
    }
  }
  return true;
};

/* ---------------- 战斗逻辑 ---------------- */
function shellDmg(s) { return s.ammo === 'ap' ? s.def.ap : s.def.he; }

function fireMain(s, aimX, aimY) {
  if (s.sunk || s.reload > 0) return false;
  var dx = aimX - s.x, dy = aimY - s.y;
  var d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  var a = Math.atan2(dy, dx);
  var eff = Math.min(d, s.def.range);
  var tx = s.x + Math.cos(a) * eff, ty = s.y + Math.sin(a) * eff;
  var flight = eff / s.def.vel;
  var sigma = s.def.sigma + eff * 0.008;
  if (s.team === 1) sigma *= P().enemySigma;        // 敌方精度更低，留出机动规避空间
  else if (!s.isPlayer) sigma *= 1.25;              // 友军 AI 精度略低于玩家
  var barrels = 0, he = s.ammo !== 'ap', dmg = shellDmg(s);
  for (var i = 0; i < s.turrets.length; i++) {
    var tw = s.turretWorld(i), n = s.turrets[i].barrels;
    barrels += n;
    for (var b = 0; b < n; b++) {
      var ox = tx + U.gauss() * sigma + U.rand(-sigma * 0.25, sigma * 0.25);
      var oy = ty + U.gauss() * sigma * 0.8;
      var sx = tw.x + Math.cos(tw.ang) * 8;
      var sy = tw.y + Math.sin(tw.ang) * 8;
      G.shells.push(new Shell(sx, sy, ox, oy, flight + U.rand(-0.035, 0.035),
                              dmg, s.team, !s.isPlayer, he));
      G.particles.burst(sx, sy, { count: 5, angle: tw.ang, speedMin: 30, speedMax: 120,
        lifeMin: 0.15, lifeMax: 0.4, sizeMin: 2, sizeMax: 5,
        colors: ['#fff0c0', '#ffc266', '#ff8a3c'], type: 'line', spread: 3 });
    }
    // 炮口焰：大口径更亮更大
    G.particles.add({ x: tw.x + Math.cos(tw.ang) * 10, y: tw.y + Math.sin(tw.ang) * 10,
      vx: 0, vy: 0, life: s.def.kind === 'bb' ? 0.22 : 0.14, size: s.def.kind === 'bb' ? 16 : 9,
      color: '#ffe9b0', type: 'flash', grow: s.def.kind === 'bb' ? 60 : 34, alpha: 0.9 });
  }
  s.reloadMax = s.def.reload * (s.team === 1 ? P().enemyReload : (s.isPlayer ? P().playerReload : 1));
  s.reload = s.reloadMax;
  s.muzzle = 0.16;
  G.sound.gun(s.team === 0 ? 1 : 0.55, s.def.kind);
  if (s.isPlayer) {
    G.stats.shots += barrels;
    addShake(s.def.kind === 'bb' ? 3.4 : (s.def.kind === 'ca' ? 1.8 : 0.9));   // 开炮后坐按口径
    if (G.voice) G.voice.say('fire_main');
  } else if (s.team === 1 && U.dist(s.x, s.y, G.player.x, G.player.y) < 1200) {
    if (G.voice) G.voice.say('alarm', 4000);
    if (G.voice) G.voice.say('enemy_spotted', 5000);
  }
  return true;
}

// 俾斯麦的简化自动副炮：对射程内目标自动倾泻小口径炮弹
function fireSecondary(s, tgt) {
  var sp = s.def.specials, d = U.dist(s.x, s.y, tgt.x, tgt.y);
  var flight = d / s.def.vel;
  for (var i = 0; i < 4; i++) {
    var sigma = 34 + d * 0.01;
    var ax = tgt.x + tgt.vx * flight * 0.7 + U.gauss() * sigma;
    var ay = tgt.y + tgt.vy * flight * 0.7 + U.gauss() * sigma;
    G.shells.push(new Shell(s.x + U.rand(-s.len * 0.25, s.len * 0.25), s.y + U.rand(-s.beam * 0.3, s.beam * 0.3),
      ax, ay, flight + U.rand(-0.05, 0.05), sp.secDmg, s.team, !s.isPlayer, true));
  }
  G.particles.burst(s.x, s.y, { count: 10, speedMin: 20, speedMax: 90, lifeMin: 0.12, lifeMax: 0.3,
    sizeMin: 1.5, sizeMax: 3.5, colors: ['#ffe9b0', '#ffc266'], type: 'line', spread: 6 });
  s.secReload = 1 / sp.secReload;   // secReload = 每秒轮次
  G.sound.gun(s.team === 0 ? 0.32 : 0.22, 'dd');
}

function fireTorpedoes(s, aimAng) {
  if (!s.def.torpDmg || s.sunk || s.torpReload > 0) return false;
  var base = aimAng;
  for (var i = -1; i <= 1; i++) {
    var a = base + i * 0.055;
    var ox = s.x + Math.cos(s.ang) * s.len * 0.1 + Math.cos(a) * 6;
    var oy = s.y + Math.sin(s.ang) * s.len * 0.1 + Math.sin(a) * 6;
    G.torps.push(new Torpedo(ox, oy, a, s.team, s.def.torpDmg, s.def.torpRange, s.def.torpSpeed, !s.isPlayer));
  }
  s.torpReloadMax = s.def.torpReload * (s.team === 1 ? P().enemyReload : (s.isPlayer ? P().playerReload : 1));
  s.torpReload = s.torpReloadMax;
  G.sound.torpedo();
  if (s.isPlayer) { toast('鱼雷发射 · 3 枚'); if (G.voice) G.voice.say('torpedo_fire'); }
  return true;
}

function shellImpact(sh) {
  // 落点在礁石/岛屿上 → 炸在地形上，对舰无伤害（高弹道可飞越障碍，但落点被拦截）
  var ter = terrainHard(sh.tx, sh.ty);
  if (ter) {
    bigExplosion(sh.tx, sh.ty, false, false);
    G.sound.explosion(false);
    return;
  }
  var hit = null, crit = false;
  for (var i = 0; i < G.ships.length; i++) {
    var s = G.ships[i];
    if (s.sunk || s.team === sh.owner) continue;
    var l = U.toLocal(sh.tx, sh.ty, s.x, s.y, s.ang);
    if (Math.abs(l.x) < s.len * 0.54 && Math.abs(l.y) < s.beam * 0.5 + 7) {
      hit = s;
      crit = Math.abs(l.x) < s.len * 0.21 && Math.abs(l.y) < s.beam * 0.55;
      break;
    }
  }
  if (hit) {
    var dmg = sh.dmg * (crit ? 2 : 1);   // 要害（核心区）命中 ×2
    applyDamage(hit, dmg, 'shell', sh.owner, crit, sh.aiOwned, sh.he);
    G.particles.burst(sh.tx, sh.ty, { count: crit ? 22 : 13, speedMin: 30, speedMax: 150,
      lifeMin: 0.3, lifeMax: 0.8, sizeMin: 2, sizeMax: 6,
      colors: crit ? ['#fff3c0', '#ff9b3c', '#ff5a2c'] : ['#ffd9a0', '#ff8a4c', '#e8f3f5'] });
    G.sound.explosion(crit);
    G.sound.hit(crit);
    if (sh.owner === 0 && !sh.aiOwned) {
      G.stats.hits++;
      if (G.voice) G.voice.say('enemy_hit', 900);
    }
    bigExplosion(sh.tx, sh.ty, false, crit);
  } else {
    // 近失弹 → 水柱
    splash(sh.tx, sh.ty, 1);
    G.sound.splash();
  }
}

// 距离衰减的镜头震动：远处的爆炸/沉没不再晃屏
function addShake(v, x, y) {
  if (x == null || !G.player) { G.shake = Math.min(G.shake + v, 18); return; }
  var d = U.dist(G.player.x, G.player.y, x, y);
  if (d > 2100) return;
  var f = d < 500 ? 1 : 1 - (d - 500) / 1600;
  G.shake = Math.min(G.shake + v * f, 18);
}

function bigExplosion(x, y, large, crit) {
  var n = large ? 34 : (crit ? 20 : 12);  G.particles.burst(x, y, { count: n, speedMin: 20, speedMax: large ? 210 : 130,
    lifeMin: 0.4, lifeMax: 1.3, sizeMin: 2, sizeMax: large ? 11 : 7,
    colors: ['#fff0b0', '#ff9a3c', '#ff5522', '#ffe6c0'], grow: 3 });
  // 爆闪光球（加性发光）
  G.particles.add({ x: x, y: y, vx: 0, vy: 0, life: large ? 0.34 : 0.24,
    size: large ? 30 : (crit ? 20 : 12), color: '#ffedbe', type: 'flash',
    grow: large ? 130 : (crit ? 70 : 42), alpha: 0.95 });
  for (var i = 0; i < (large ? 4 : 2); i++) {
    G.particles.add({ x: x + U.rand(-10, 10), y: y + U.rand(-10, 10), vx: U.rand(-18, 18), vy: U.rand(-40, -12),
      life: U.rand(1.1, 2.2), size: U.rand(6, 14), color: '#3c464b', type: 'smoke', grow: 13, drag: 0.97, alpha: 0.55 });
  }
  G.particles.add({ x: x, y: y, vx: 0, vy: 0, life: 0.55, size: 6, color: large ? '#ffd08a' : '#ffb877',
    type: 'ring', grow: large ? 130 : 70 });
  addShake(large ? 6 : (crit ? 3.4 : 1.5), x, y);
}

function splash(x, y, scale) {
  G.particles.burst(x, y, { count: 9 * scale, angle: -Math.PI / 2, speedMin: 60, speedMax: 190,
    lifeMin: 0.4, lifeMax: 0.9, sizeMin: 1.5, sizeMax: 4.5,
    colors: ['#dff4fa', '#a9dbe8', '#ffffff'], grav: 260, drag: 0.985, type: 'line' });
  G.particles.add({ x: x, y: y, vx: 0, vy: 0, life: 0.7, size: 4, color: 'rgba(190,230,245,.6)', type: 'ring', grow: 55 });
}

function applyDamage(s, dmg, type, source, crit, aiOwned, he) {
  if (s.sunk) return;
  // 玩家享受节奏补偿加成，敌方被削弱，友军 AI 用基础伤害；只统计玩家造成的伤害
  var mul = source === 1 ? P().enemyDmg : (aiOwned ? 1 : P().playerDmg);
  var actual = Math.round(dmg * mul);
  s.hp -= actual;
  if (source === 0 && !aiOwned) G.stats.damage += actual;
  G.floats.push({ x: s.x + U.rand(-14, 14), y: s.y - 16, text: '-' + U.fmt(actual), life: 1.15,
    color: crit ? '#ffd45e' : (s.team === 0 ? '#ff7a6a' : '#c9f4ff'), crit: !!crit, vy: -22 });
  if (type === 'shell' && he && Math.random() < 0.1) s.fire = Math.max(s.fire, 7);
  if (type === 'torp') { s.flood = Math.max(s.flood, 11); s.fire = Math.max(s.fire, 5); }
  if (s.isPlayer) {
    G.shake = Math.min(G.shake + 5.5, 18);
    G.hitFlash = 0.75;
    if (G.voice) G.voice.say('alarm', 4000);
    if (G.voice) {
      if (s.hp / s.maxHp < 0.3) G.voice.say('player_critical', 6000);
      else G.voice.say('player_hit', 1200);
    }
  }
  if (s.hp <= 0) sinkShip(s, source);
}

function sinkShip(s, source) {
  if (s.sunk) return;
  s.sunk = true; s.hp = 0; s.sinkTime = 0;
  s.rudderTarget = 0; s.speed *= 0.55;
  bigExplosion(s.x, s.y, true);
  G.sound.sink();
  addShake(9, s.x, s.y);
  if (s.team === 1) {
    G.stats.kills++;
    toast('敌舰「' + s.name + '」已被击沉');
    feed('击沉 <span>' + s.short + '</span>');
    if (G.voice) G.voice.say('enemy_sunk');
  } else if (s.isPlayer) {
    G.win = false;
    if (G.voice) G.voice.say('ship_sink');
    endBattle(false);
  } else {
    toast('友舰「' + s.name + '」已沉没');
    feed('损失 <span style="color:#ff8a75">' + s.short + '</span>');
  }
  if (G.ships.filter(function (x) { return x.team === 1 && !x.sunk; }).length === 0 && G.player && !G.player.sunk) {
    G.win = true;
    endBattle(true);
  }
}

function endBattle(win) {
  if (G.state === 'over') return;
  G.state = 'over';
  G.endTimer = 2.8;   // 真实秒：留时间看完沉没动画
  G.win = win;
  toast(win ? '战斗胜利 · 敌方舰队全灭' : '本舰沉没');
  if (G.voice) {
    if (win) G.voice.say('victory');
    else setTimeout(function () { if (G.voice) G.voice.say('defeat'); }, 1200);
  }
}

/* ---------------- 舰艇 AI（敌我通用） ---------------- */
// 找最近的敌对舰：敌方 AI 会优先攻击靠近的友军，从而替本舰分担火力
function findTarget(s) {
  var best = null, bd = Infinity;
  for (var i = 0; i < G.ships.length; i++) {
    var o = G.ships[i];
    if (o.sunk || o.team === s.team) continue;
    var d = U.dist(s.x, s.y, o.x, o.y);
    if (o.smokeTime > 0 && d > 420) continue;   // 烟幕遮蔽：远距无法锁定烟中目标
    if (d < bd && !losBlocked(s.x, s.y, o.x, o.y)) { bd = d; best = o; }   // 岛屿遮蔽视线
  }
  return best;
}

/* ---------------- 战术特技 ---------------- */
var SMOKE_CD = 90, SMOKE_DUR = 15, BOOST_CD = 90, BOOST_DUR = 20;   // 真实秒
function spawnSmokePuffs(s, n) {
  for (var i = 0; i < n; i++) {
    if (G.smokes.length > 240) G.smokes.shift();   // 性能封顶
    G.smokes.push({
      x: s.x - Math.cos(s.ang) * i * 26 + U.rand(-12, 12),
      y: s.y - Math.sin(s.ang) * i * 26 + U.rand(-12, 12),
      r: U.rand(55, 82), life: SMOKE_DUR + 6, maxLife: SMOKE_DUR + 6
    });
  }
}
function deploySmoke(s) {
  if (!s.def || !s.def.specials.smoke || s.smokeCd > 0 || s.sunk) return false;
  s.smokeCd = SMOKE_CD; s.smokeTime = SMOKE_DUR; s.smokeTick = 0;
  spawnSmokePuffs(s, 5);
  if (s.isPlayer) { toast('烟幕施放 · 敌方远距无法锁定'); G.sound.ui(true); }
  return true;
}
function deployBoost(s) {
  if (!s.def || !s.def.specials.boost || s.boostCd > 0 || s.sunk) return false;
  s.boostCd = BOOST_CD; s.boostTime = BOOST_DUR;
  if (s.isPlayer) {
    toast('引擎增压 · 极速提升 20 秒');
    G.sound.ui(true);
    G.particles.burst(s.x, s.y, { count: 18, angle: s.ang + Math.PI, speedMin: 60, speedMax: 220,
      lifeMin: 0.3, lifeMax: 0.8, sizeMin: 2, sizeMax: 4, colors: ['#bfefff', '#7fe6ff', '#e8fbff'], type: 'line', spread: 2 });
  }
  return true;
}
function updateAI(s, dt) {
  var p = findTarget(s);
  if (!p) { s.rudderTarget = 0; return; }
  var dx = p.x - s.x, dy = p.y - s.y;
  var d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  var toP = Math.atan2(dy, dx);
  var pref = s.def.prefer || 1000;
  var desired;
  if (d > pref + 260) desired = toP;
  else if (d < pref - 320) desired = toP + Math.PI;
  else desired = toP + (Math.PI / 2) * s.ai.orbit;   // 侧舷对敌
  // 地形规避优先于战术机动：前方有礁石/岛屿时沿切向绕行
  var avoid = null, avBest = Infinity;
  for (var q = 0; q < G.reefs.length; q++) {
    var rr = G.reefs[q];
    if (rr.tier === 0) continue;
    var dd = U.dist(s.x, s.y, rr.x, rr.y) - rr.r * 0.9;
    if (dd < 430) {
      var toR = Math.atan2(rr.y - s.y, rr.x - s.x);
      if (Math.abs(U.angDiff(s.ang, toR)) < 1.25 && dd < avBest) { avBest = dd; avoid = rr; }
    }
  }
  if (avoid) {
    var away = Math.atan2(s.y - avoid.y, s.x - avoid.x);
    desired = away + (U.angDiff(away, s.ang) > 0 ? 0.85 : -0.85);
    if (s.gear > 2 && avBest < 160) s.gear = 2;    // 紧急时减速
  }
  s.ai.desiredAng = desired;
  var diff = U.angDiff(s.ang, desired);
  s.rudderTarget = U.clamp(diff * 1.8, -1, 1);
  // 车钟
  if (s.gear < 2) s.gear = 3;
  if (d < pref - 500 && s.gear > 3) s.gear = 2;
  if (d > pref + 500 && s.gear < 4) s.gear = 4;

  // 弹种：近距用 AP 打核心，远距撒 HE 点火
  s.ammo = d < s.def.range * 0.45 ? 'ap' : 'he';

  // 炮塔指向目标
  var rel = U.norm(toP - s.ang);
  for (var i = 0; i < s.turrets.length; i++) s.turrets[i].target = rel;

  // 主炮开火
  if (s.reload <= 0 && d < s.def.range && Math.abs(U.angDiff(s.turrets[0].ang, rel)) < 0.55) {
    var flight = d / s.def.vel;
    var err = (s.def.kind === 'bb' ? 145 : (s.def.kind === 'ca' ? 110 : 85))
              * (s.team === 1 ? P().enemyLead : 1.15);
    var ax = p.x + p.vx * flight + U.gauss() * err;
    var ay = p.y + p.vy * flight + U.gauss() * err;
    fireMain(s, ax, ay);
  }
  // 自动副炮（俾斯麦）：射程内持续输出
  if (s.def.specials.secondary && d < s.def.specials.secRange && s.secReload <= 0) {
    fireSecondary(s, p);
  }
  // 鱼雷
  s.ai.torpCd -= dt;
  if (s.def.torpDmg && s.torpReload <= 0 && s.ai.torpCd <= 0 &&
      d < s.def.torpRange * 0.7 && d > 260 && Math.abs(diff) < 1.2) {
    var tf = d / (s.def.torpSpeed * P().torpSpeed);
    var tAng = Math.atan2(p.y + p.vy * tf - s.y, p.x + p.vx * tf - s.x);
    fireTorpedoes(s, tAng);
    s.ai.torpCd = paceSec(U.rand(13, 20) * (s.team === 1 ? P().aiTorpCd : 1));
    if (s.team === 1) toast('警告 · 敌方鱼雷发射');
  }
  // AI 烟雾：残血时拉烟撤退
  if (s.def.specials.smoke && s.smokeCd <= 0 && s.hp / s.maxHp < s.ai.smokeAt) {
    deploySmoke(s);
  }
}

/* ---------------- 输入 ---------------- */
function screenToWorld(sx, sy) {
  return { x: (sx - G.w / 2) / G.zoom + G.cam.x, y: (sy - G.h / 2) / G.zoom + G.cam.y };
}
function worldToScreen(wx, wy) {
  return { x: (wx - G.cam.x) * G.zoom + G.w / 2, y: (wy - G.cam.y) * G.zoom + G.h / 2 };
}
function aimAngle() {
  return Math.atan2(G.mouse.wy - G.player.y, G.mouse.wx - G.player.x);
}
// 舵令语音节流：同一方向不重复播报，且任意舵令之间至少间隔 2.5s，避免频繁刷屏
var _lastRudderDir = 0, _lastRudderSpeakT = 0;
// 根据当前按住的方向键同步舵角（A/D 与左右方向键）
function syncRudder() {
  if (!G.player) return;
  var left = !!(G.keys['a'] || G.keys['arrowleft']);
  var right = !!(G.keys['d'] || G.keys['arrowright']);
  var t = left === right ? 0 : (left ? -1 : 1);
  if (t !== G.player.rudderTarget) {
    G.player.rudderTarget = t;
    var now = performance.now();
    // 仅在转向方向真正改变、且与上次舵令间隔足够时才播报
    if (G.voice && t !== _lastRudderDir && now - _lastRudderSpeakT > 2500) {
      if (t < 0) G.voice.say('rudder_left');
      else if (t > 0) G.voice.say('rudder_right');
      else G.voice.say('rudder_center');
      _lastRudderDir = t;
      _lastRudderSpeakT = now;
    }
  }
}
function playerFire() {
  if (G.state !== 'play' || G.paused) return;
  if (G.assist && !nearestTarget(true)) {
    if (G.tipCd <= 0) { toast('目标超出射程 · 请接敌'); G.tipCd = 3; }
    return;
  }
  fireMain(G.player, G.mouse.wx, G.mouse.wy);
}
function playerTorp() { if (G.state === 'play' && !G.paused) fireTorpedoes(G.player, aimAngle()); }
// 弹种切换 HE ↔ AP
function playerAmmo() {
  if (G.state !== 'play' || !G.player || G.paused) return;
  var p = G.player;
  p.ammo = p.ammo === 'ap' ? 'he' : 'ap';
  var ap = p.ammo === 'ap';
  toast(ap ? 'AP 穿甲弹 · 要害命中 ×2' : 'HE 高爆弹 · 命中可起火');
  G.sound.ui(true);
  syncAmmoUI();
}
function syncAmmoUI() {
  var p = G.player;
  if (!p) return;
  var b = $('btnAmmo');
  if (!b) return;
  var ap = p.ammo === 'ap';
  b.textContent = ap ? 'AP' : 'HE';
  b.classList.toggle('ammo-ap', ap);
  b.title = '当前弹种：' + (ap ? 'AP 穿甲弹（要害×2）' : 'HE 高爆弹（可起火）') + '，点击或按 R 切换';
}

function bindInput() {
  window.addEventListener('keydown', function (e) {
    var k = e.key.toLowerCase();
    G.keys[k] = true;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(k) >= 0) e.preventDefault();
    if (k === 't' && !e.repeat) { togglePace(); return; }
    if (k === 'c' && !e.repeat && G.state === 'play') {
      if ($('overlayFleet').classList.contains('hidden')) openFleet(); else closeFleet();
      return;
    }
    if (G.state !== 'play') return;
    if (e.repeat) return;
    if (k === 'a' || k === 'arrowleft' || k === 'd' || k === 'arrowright') syncRudder();
    else if (k === 'w' || k === 'arrowup') G.player.setGear(G.player.gear + 1);
    else if (k === 's' || k === 'arrowdown') G.player.setGear(G.player.gear - 1);
    else if (k === 'q') { G.player.rudderTarget = 0; }
    else if (k === 'e') { G.player.setGear(1); }
    else if (k === ' ' ) playerFire();
    else if (k === 'f') playerTorp();
    else if (k === 'r') playerAmmo();
    else if (k === 'z') { if (G.player) deploySmoke(G.player); }
    else if (k === 'b') { if (G.player) deployBoost(G.player); }
    else if (k === 'x') toggleAssist();
    else if (k === 'm') toggleSound();
    else if (k === 'v' && !e.repeat) { toggleVoice(); return; }
    else if (k === 'p' || k === 'escape') {
      if (!$('overlayFleet').classList.contains('hidden')) closeFleet(); else togglePause();
    }
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key.toLowerCase();
    G.keys[k] = false;
    if (k === 'a' || k === 'arrowleft' || k === 'd' || k === 'arrowright') syncRudder();
  });
  window.addEventListener('blur', function () { G.keys = {}; if (G.player) G.player.rudderTarget = 0; G.heldFire = false; });

  canvas.addEventListener('mousemove', function (e) {
    var r = canvas.getBoundingClientRect();
    G.mouse.sx = e.clientX - r.left; G.mouse.sy = e.clientY - r.top; G.mouse.has = true;
  });
  canvas.addEventListener('mousedown', function (e) {
    if (e.button === 0) playerFire();
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    G.userZoom = U.clamp(G.userZoom * (e.deltaY > 0 ? 0.9 : 1.11), 0.55, 1.6);
    G.zoom = U.clamp(G.baseZoom * G.userZoom, 0.32, 1.25);
  }, { passive: false });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // 触控：拖动画面移动准星，轻点开火
  var tapStart = null;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;
    var r = canvas.getBoundingClientRect();
    G.mouse.sx = e.clientX - r.left; G.mouse.sy = e.clientY - r.top; G.mouse.has = true;
    tapStart = { t: performance.now(), x: e.clientX, y: e.clientY, moved: 0 };
  });
  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse' || !tapStart) return;
    var r = canvas.getBoundingClientRect();
    G.mouse.sx = e.clientX - r.left; G.mouse.sy = e.clientY - r.top;
    tapStart.moved = Math.max(tapStart.moved, U.dist(tapStart.x, tapStart.y, e.clientX, e.clientY));
  });
  canvas.addEventListener('pointerup', function (e) {
    if (e.pointerType === 'mouse' || !tapStart) return;
    if (performance.now() - tapStart.t < 260 && tapStart.moved < 14) playerFire();
    tapStart = null;
  });

  // 车钟按钮
  Array.prototype.forEach.call(document.querySelectorAll('#throttle button'), function (b) {
    b.addEventListener('click', function () { if (G.player) G.player.setGear(parseInt(b.dataset.gear, 10)); });
  });
  // HUD 侧按钮
  $('btnSound').addEventListener('click', toggleSound);
  $('btnVoice').addEventListener('click', toggleVoice);
  $('btnAmmo').addEventListener('click', playerAmmo);
  $('btnSmoke').addEventListener('click', function () { if (G.player) deploySmoke(G.player); });
  $('btnBoost').addEventListener('click', function () { if (G.player) deployBoost(G.player); });
  $('btnPace').addEventListener('click', togglePace);
  $('btnAssist').addEventListener('click', toggleAssist);
  $('btnPause').addEventListener('click', togglePause);
  $('btnHelp').addEventListener('click', function () { showPause(true); });
  $('btnResume').addEventListener('click', hidePause);
  $('btnFleet').addEventListener('click', openFleet);
  $('btnFleetClose').addEventListener('click', closeFleet);
  $('btnBackFleet').addEventListener('click', backToMenu);
  // 流程
  $('btnStart').addEventListener('click', startGame);
  $('btnRestart').addEventListener('click', startGame);

  // 编成面板：开始界面与战斗浮层共用一套控件
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ship],[data-fleet]') : null;
    if (!el) return;
    var ship = el.getAttribute('data-ship');
    if (ship) selectShip(ship);
    else changeFleet(el.getAttribute('data-fleet'), parseInt(el.getAttribute('data-delta'), 10));
  });

  // 移动端控件
  var pad = $('rudderPad'), knob = $('rudderKnob');
  var padActive = false;
  function padMove(e) {
    if (!padActive) return;
    var r = pad.getBoundingClientRect();
    var dx = e.clientX - (r.left + r.width / 2);
    var v = U.clamp(dx / 42, -1, 1);
    if (G.player) G.player.rudderTarget = v;
    knob.style.transform = 'translate(' + (v * 34) + 'px,0)';
  }
  pad.addEventListener('pointerdown', function (e) { padActive = true; pad.setPointerCapture(e.pointerId); padMove(e); });
  pad.addEventListener('pointermove', padMove);
  function padEnd() { padActive = false; if (G.player) G.player.rudderTarget = 0; knob.style.transform = ''; }
  pad.addEventListener('pointerup', padEnd);
  pad.addEventListener('pointercancel', padEnd);

  $('gearUp').addEventListener('pointerdown', function () { if (G.player) G.player.setGear(G.player.gear + 1); });
  $('gearDown').addEventListener('pointerdown', function () { if (G.player) G.player.setGear(G.player.gear - 1); });
  var fb = $('btnFireTouch');
  fb.addEventListener('pointerdown', function () { G.heldFire = true; playerFire(); });
  fb.addEventListener('pointerup', function () { G.heldFire = false; });
  fb.addEventListener('pointercancel', function () { G.heldFire = false; });
  $('btnTorpTouch').addEventListener('pointerdown', playerTorp);
  // 阻止触控控件冒泡到 canvas
  $('touch').addEventListener('pointerdown', function (e) { e.stopPropagation(); });
}

function setPace(v) {
  var prev = P().playerHp;
  G.pace = v === 'normal' ? 'normal' : 'slow';
  var cfg = P();
  var b = $('btnPace');
  b.textContent = cfg.short;
  b.title = '战斗节奏：' + cfg.label + '（时间流速 ' + Math.round(cfg.time * 100) + '% · 点击切换 / T）';
  b.classList.toggle('pace-on', G.pace === 'slow');
  $('paceTag').textContent = cfg.label;
  if (G.player) {
    // 战斗中切换时把舰体耐久等比换算，血条不会突变
    var ratio = cfg.playerHp / prev;
    G.player.maxHp = Math.round(playerDef(G.fleet.ship).maxHp * cfg.playerHp);
    G.player.hp = U.clamp(G.player.hp * ratio, 1, G.player.maxHp);
  }
}
function togglePace() {
  setPace(G.pace === 'slow' ? 'normal' : 'slow');
  toast('战斗节奏 · ' + P().label + '（时间流速 ' + Math.round(P().time * 100) + '%）');
  G.sound.ui(G.pace === 'slow');
}
function setAssist(v) {
  G.assist = v;
  var b = $('btnAssist');
  var label = window.matchMedia('(pointer: coarse)').matches ? '辅助' : '火控辅助';
  b.classList.toggle('on', v);
  b.innerHTML = label + ' ' + (v ? 'ON' : 'OFF') + ' <kbd>X</kbd>';
}
function toggleAssist() {
  setAssist(!G.assist);
  toast(G.assist ? '火控辅助开启 · 自动解算提前量' : '火控辅助关闭 · 手动瞄准');
  G.sound.ui(G.assist);
}
function toggleSound() {
  G.sound.init();
  var on = G.sound.toggle();
  $('btnSound').textContent = on ? '♪' : '✕';
  $('btnSound').classList.toggle('off', !on);
}
function toggleVoice() {
  if (!G.voice) return;
  G.voice.init();
  var on = G.voice.toggle();
  $('btnVoice').textContent = on ? '🔊' : '🔇';
  $('btnVoice').classList.toggle('off', !on);
}
function togglePause() { if (G.paused) hidePause(); else showPause(false); }
function showPause(help) {
  if (G.state !== 'play') return;
  $('overlayFleet').classList.add('hidden');
  G.paused = true;
  $('pauseTitle').textContent = help ? '操作说明' : '已暂停';
  $('pauseBody').innerHTML = help
    ? '<div><kbd>W</kbd><kbd>S</kbd> 升降车钟档位（倒车 / 停车 / Ⅰ~Ⅳ）</div>' +
      '<div><kbd>A</kbd><kbd>D</kbd> 按住左右转舵，<kbd>Q</kbd> 舵回中，<kbd>E</kbd> 紧急停车</div>' +
      '<div><kbd>鼠标</kbd> 瞄准，<kbd>左键</kbd> / <kbd>空格</kbd> 主炮齐射，<kbd>F</kbd> 鱼雷</div>' +
      '<div><kbd>R</kbd> 切换 HE / AP 弹种，<kbd>Z</kbd> 烟幕，<kbd>B</kbd> 引擎增压（闪电）</div>' +
      '<div><kbd>X</kbd> 火控辅助，<kbd>C</kbd> 舰队编成，<kbd>T</kbd> 战斗节奏，<kbd>M</kbd> 音效，<kbd>V</kbd> 语音，<kbd>P</kbd> 暂停</div>' +
      '<div><kbd>C</kbd> 打开的编成面板可随时更换本舰、增减友军与敌舰数量，关闭后立即生效</div>' +
      '<div style="margin-top:10px;color:#7dffa8">炮弹需要飞行时间，瞄准绿色提前量标记；红色虚线圈是敌方炮弹落点，慢节奏（20% 流速）下有充分时间机动规避。AP 弹命中核心区（要害）伤害 ×2，HE 弹可点燃敌舰。</div>' +
      '<div style="color:#8fd8ea">礁石与岛屿会阻挡航线与炮弹、遮蔽视线——躲到岛后可脱离敌方锁定；浅滩会拖慢航速，高速触礁会损伤舰体。</div>'
    : '<div style="text-align:center;color:#7fa5b5">海面暂时归于平静。</div>';
  $('overlayPause').classList.remove('hidden');
}
function hidePause() { G.paused = false; $('overlayPause').classList.add('hidden'); }

function toast(text) {
  var el = $('toast');
  el.textContent = text; el.classList.add('show');
  G.toastTimer = 1.8;
}
function feed(html) {
  var d = document.createElement('div');
  d.innerHTML = html;
  $('killFeed').appendChild(d);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 4000);
}

/* ---------------- 海上景物 ---------------- */
// 障碍物三档高低差：0 浅滩（近乎平坦的沙洲）/ 1 礁石（低）/ 2 岛屿（高，带植被顶）
var SCENERY_COLORS = [
  ['#123036', '#7ba79b'],   // 浅滩：暗沙 → 浅沙
  ['#0e2129', '#6b838a'],   // 礁石：岩壁 → 岩顶
  ['#1c2f26', '#4f6c46']    // 岛屿：崖壁 → 植被
];
function lerpColor(a, b, f) {
  var pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  var pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  return 'rgb(' + Math.round(pa[0] + (pb[0] - pa[0]) * f) + ',' +
    Math.round(pa[1] + (pb[1] - pa[1]) * f) + ',' + Math.round(pa[2] + (pb[2] - pa[2]) * f) + ')';
}
function makeScenery() {
  var cx = WORLD / 2, cy = WORLD / 2, reefs = [], clouds = [];
  for (var i = 0; i < 36; i++) {
    var a = Math.random() * U.TAU, d = U.rand(760, 8800);   // 障碍铺满整个交战海域
    var tier = i % 3;                                   // 均匀分布三档
    var R = tier === 2 ? U.rand(80, 150) : (tier === 1 ? U.rand(40, 78) : U.rand(62, 120));
    var rocks = [];
    var nR = tier === 2 ? U.randInt(1, 2) : U.randInt(2, 4);
    for (var j = 0; j < nR; j++) {
      var pts = [], m = U.randInt(9, 13), rr = R * (tier === 2 ? U.rand(0.5, 0.85) : U.rand(0.25, 0.62));
      for (var k = 0; k < m; k++) {
        var ang = k / m * U.TAU;
        pts.push([Math.cos(ang) * rr * U.rand(0.55, 1.45), Math.sin(ang) * rr * U.rand(0.55, 1.45)]);
      }
      rocks.push({ x: U.rand(-R * 0.55, R * 0.55), y: U.rand(-R * 0.55, R * 0.55),
        pts: pts,
        h: tier === 2 ? U.rand(46, 78) : (tier === 1 ? U.rand(16, 30) : U.rand(3, 8)) });
    }
    reefs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: R, tier: tier,
      rocks: rocks, ph: Math.random() * 6 });
  }
  for (var c = 0; c < 9; c++) {
    clouds.push({ x: cx + U.rand(-6400, 6400), y: cy + U.rand(-6400, 6400),
                  r: U.rand(320, 760), vx: U.rand(3, 9), vy: U.rand(-3, 3) });
  }
  return { reefs: reefs, clouds: clouds };
}
/* ---------------- 地形交互 ----------------
   浅滩(tier 0)：拖底减速，可通过；
   礁石(tier 1)/岛屿(tier 2)：硬碰撞——舰船搁浅掉血并被推离、
   炮弹落点被拦截（高弹道可飞越，但落点在障碍上则无效）、
   鱼雷触礁引爆；岛屿(tier 2)额外阻断视线（AI 无法锁定岛后目标）。
--------------------------------------------- */
function terrainHard(x, y) {          // 礁石/岛屿
  for (var i = 0; i < G.reefs.length; i++) {
    var r = G.reefs[i];
    if (r.tier === 0) continue;
    if (U.dist(x, y, r.x, r.y) < r.r * 0.9) return r;
  }
  return null;
}
function terrainAny(x, y) {           // 含浅滩
  for (var i = 0; i < G.reefs.length; i++) {
    var r = G.reefs[i];
    if (U.dist(x, y, r.x, r.y) < r.r * 0.9) return r;
  }
  return null;
}
// 岛屿视线遮挡：线段是否穿过 tier 2 岛体
function losBlocked(x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  for (var i = 0; i < G.reefs.length; i++) {
    var r = G.reefs[i];
    if (r.tier < 2) continue;
    var t = L2 > 0 ? U.clamp(((r.x - x1) * dx + (r.y - y1) * dy) / L2, 0, 1) : 0;
    if (U.dist(x1 + dx * t, y1 + dy * t, r.x, r.y) < r.r * 0.78) return true;
  }
  return false;
}
// 单块岩石 / 岛体的伪 3D 挤出：底为深色阴影层，逐层向左上抬升、颜色渐亮，顶层带高光描边
function drawRockBody(k, tier) {
  var pal = SCENERY_COLORS[tier] || SCENERY_COLORS[1];
  var h = k.h, off = h * 0.42;
  var slices = 7;
  ctx.save();
  ctx.translate(k.x, k.y);
  // 落影（光从左上来，影子抛向右下）
  ctx.save();
  ctx.translate(off * 1.1, off * 1.4);
  ctx.beginPath();
  k.pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,8,14,.5)'; ctx.fill();
  ctx.restore();
  // 逐层挤出
  for (var s = 0; s <= slices; s++) {
    var f = s / slices;
    var ox = (1 - f) * off, oy = (1 - f) * off * 1.25;
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.beginPath();
    k.pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.closePath();
    ctx.fillStyle = lerpColor(pal[0], pal[1], f); ctx.fill();
    if (s === slices) {   // 顶面：冷色高光描边（受光边缘）
      ctx.strokeStyle = tier === 2 ? 'rgba(180,225,190,.4)' : 'rgba(190,232,242,.42)';
      ctx.lineWidth = 1.3 / G.zoom; ctx.stroke();
      // 顶面左上受光小块
      ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

/* ---------------- 舰队编成 ---------------- */
function fleetAlive(team) {
  var n = 0;
  G.ships.forEach(function (s) { if (!s.isPlayer && s.team === team && !s.sunk) n++; });
  return n;
}
// 舰种均衡：统计本队现存各舰种数量（含玩家），返回最少的舰种（并列随机）。
// 增量刷舰时依次调用，6 艘即自然配平为 2 DD + 2 CA + 2 BB。
function balanceKind(team) {
  var alive = { dd: 0, ca: 0, bb: 0 };
  G.ships.forEach(function (s) {
    if (s.sunk || s.team !== team) return;
    if (alive[s.def.kind] !== undefined) alive[s.def.kind]++;
  });
  var min = Math.min(alive.dd, alive.ca, alive.bb);
  var cands = ['dd', 'ca', 'bb'].filter(function (k) { return alive[k] === min; });
  return U.pick(cands);
}
// 生成一艘 AI 舰：开局用固定阵型，战斗中增援用随机方位；舰种按均衡配比选取
function spawnFleetShip(team, index, initial) {
  var p = G.player, a, dist;
  if (initial) {
    if (team === 0) {
      a = -Math.PI / 2 + (index - (G.fleet.allies - 1) / 2) * 0.62;
      dist = 330 + index * 70;
    } else {
      a = -0.5 + index * U.TAU / Math.max(1, G.fleet.enemies);
      dist = 1850 + (index % 3) * 380;   // 大地图：敌舰队在 ~10-14 km 外展开
    }
  } else {
    a = Math.random() * U.TAU;
    dist = team === 0 ? U.rand(280, 500) : U.rand(1500, 2600);
  }
  var x = p.x + Math.cos(a) * dist, y = p.y + Math.sin(a) * dist;
  // 出生点避开礁石/岛屿
  var ter = terrainHard(x, y);
  if (ter) {
    var ta = Math.atan2(y - ter.y, x - ter.x);
    x = ter.x + Math.cos(ta) * (ter.r * 0.9 + 260);
    y = ter.y + Math.sin(ta) * (ter.r * 0.9 + 260);
  }
  // 舰种走均衡配比，再从同舰种池（如 DD: 睦月/法拉格特/闪电）随机抽具体舰
  var pool = KIND_KEYS[balanceKind(team)] || SHIP_KEYS;
  var type = U.pick(pool);
  var ang = team === 0 ? -Math.PI / 2 : a + Math.PI;
  var s = new Ship(type, x, y, ang, team, false);
  // 同名舰体加阵营与序号，多舰混战时不会混淆「我方的赤潮」和「敌方的赤潮」
  s.short = (team === 0 ? '友' : '敌') + (++G.nameSeq) + ' ' + s.short;
  G.ships.push(s);
  return s;
}
function removeFleetShip(team) {
  for (var i = G.ships.length - 1; i >= 0; i--) {
    var s = G.ships[i];
    if (s.isPlayer || s.team !== team || s.sunk) continue;
    G.ships.splice(i, 1);
    splash(s.x, s.y, 1);
    return true;
  }
  return false;
}
function changeFleet(kind, delta) {
  var team = kind === 'allies' ? 0 : 1;
  var min = team === 0 ? 0 : 1, max = team === 0 ? 7 : 8;
  var nv = U.clamp(G.fleet[kind] + delta, min, max);
  if (nv === G.fleet[kind]) return;
  G.fleet[kind] = nv;
  var alive = fleetAlive(team), need = nv - alive;
  if (need > 0) { for (var i = 0; i < need; i++) spawnFleetShip(team, alive + i, false); }
  else if (need < 0) { for (var j = 0; j < -need; j++) removeFleetShip(team); }
  syncFleetUI();
  updateHUD(true);
  toast((team === 0 ? '友军' : '敌舰') + (delta > 0 ? '增援抵达 · ' : '撤离战场 · ') + nv + ' 艘');
  G.sound.ui(delta > 0);
}
function selectShip(key) {
  if (G.fleet.ship === key) return;
  G.fleet.ship = key;
  if (G.state === 'play' && G.player && !G.player.sunk) {
    // 战斗中换乘：保留位置、车钟、状态与血量比例
    var old = G.player, np = new Ship(key, old.x, old.y, old.ang, 0, true);
    np.hp = Math.max(1, Math.round(np.maxHp * U.clamp(old.hp / old.maxHp, 0, 1)));
    np.gear = old.gear; np.speed = old.speed; np.vx = old.vx; np.vy = old.vy;
    np.rudder = old.rudder; np.rudderTarget = old.rudderTarget;
    np.fire = old.fire; np.flood = old.flood;
    np.ammo = old.ammo;
    G.ships[G.ships.indexOf(old)] = np;
    G.player = np;
    syncThrottle(); syncShipCard(); updateHUD(true);
    toast('已换乘「' + np.name + '」 · ' + playerDef(key).tag);
  } else {
    reset();
  }
  syncFleetUI();
  G.sound.ui(true);
}

/* ---------------- 初始化 ---------------- */
function reset() {
  G.ships = []; G.shells = []; G.torps = []; G.floats = []; G.smokes = [];
  var sc = makeScenery(); G.reefs = sc.reefs; G.clouds = sc.clouds;
  G.particles = new IT.Particles();
  G.time = 0; G.realTime = 0; G.endTimer = -1; G.shake = 0; G.hitFlash = 0;
  G.stats = { shots: 0, hits: 0, damage: 0, kills: 0 };
  G.cam.x = WORLD / 2; G.cam.y = WORLD / 2;
  G.win = false;
  var cx = WORLD / 2, cy = WORLD / 2;
  G.spawnSeq = 0; G.nameSeq = 0;
  G.player = new Ship(G.fleet.ship, cx, cy, -Math.PI / 2, 0, true);
  G.ships.push(G.player);
  for (var i = 0; i < G.fleet.allies; i++) spawnFleetShip(0, i, true);
  for (var j = 0; j < G.fleet.enemies; j++) spawnFleetShip(1, j, true);
  G.mouse.wx = cx; G.mouse.wy = cy - 500;
  if (!G.mouse.has) { G.mouse.sx = G.w / 2; G.mouse.sy = G.h / 2 - 160; }
  syncThrottle();
  syncShipCard();
  syncFleetUI();
  $('killFeed').innerHTML = '';
  updateHUD(true);
}
function startGame() {
  $('commanderName').textContent = G.commander;
  G.sound.init();
  if (G.voice) G.voice.init();
  reset();
  syncRudder();   // 起航时若已按住方向键，立即接续舵角
  G.state = 'play'; G.paused = false;
  $('overlayStart').classList.add('hidden');
  $('overlayResult').classList.add('hidden');
  $('overlayPause').classList.add('hidden');
  $('overlayFleet').classList.add('hidden');
  toast('战斗开始 · 击沉敌方舰队');
  if (G.voice) setTimeout(function () { G.voice.say('battle_start'); }, 450);
}

function resize() {
  G.w = window.innerWidth; G.h = window.innerHeight;
  G.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(G.w * G.dpr); canvas.height = Math.floor(G.h * G.dpr);
  canvas.style.width = G.w + 'px'; canvas.style.height = G.h + 'px';
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  // 拉远镜头，让交战距离内的敌舰与提前量标记都落在可瞄准范围内
  G.baseZoom = U.clamp(Math.min(G.w / (coarse ? 1600 : 1900), G.h / (coarse ? 1050 : 1100)),
                       coarse ? 0.36 : 0.5, coarse ? 0.7 : 0.9);
  G.zoom = U.clamp(G.baseZoom * G.userZoom, 0.32, 1.25);
}

/* ---------------- HUD / 编成面板 ---------------- */
function fleetMarkup() {
  var ships = PLAYER_SHIPS.map(function (v) {
    var stat = 'HP ' + U.fmt(v.maxHp) + ' · ' + v.knots + '节 · 射程 ' +
      (v.range / KM2U).toFixed(1) + 'km';
    var sp = [];
    if (v.specials.smoke) sp.push('烟雾');
    if (v.specials.boost) sp.push('增压');
    if (v.specials.secondary) sp.push('副炮');
    if (sp.length) stat += ' · ' + sp.join('/');
    return '<button class="fleet-ship" data-ship="' + v.key + '">' +
             '<b>' + v.tag.split(' · ')[0] + ' ' + v.name + '</b><small>' + v.desc + '</small>' +
             '<em>' + stat + '</em></button>';
  }).join('');
  var step = function (kind, label) {
    return '<div class="fleet-row"><span class="fleet-label">' + label + '</span>' +
      '<button class="fleet-step" data-fleet="' + kind + '" data-delta="-1">−</button>' +
      '<b class="fleet-num" data-num="' + kind + '">0</b>' +
      '<button class="fleet-step" data-fleet="' + kind + '" data-delta="1">＋</button></div>';
  };
  return '<div class="fleet-block">' +
    '<div class="fleet-title">舰队编成 <em>FLEET SETUP</em></div>' +
    '<div class="fleet-ships">' + ships + '</div>' +
    '<div class="fleet-steps">' + step('allies', '友军舰艇') + step('enemies', '敌方舰艇') + '</div>' +
    '<div class="fleet-note" data-fleet-note></div></div>';
}
function syncFleetUI() {
  var v = playerDef(G.fleet.ship);
  Array.prototype.forEach.call(document.querySelectorAll('[data-ship]'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-ship') === G.fleet.ship);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-num]'), function (b) {
    b.textContent = G.fleet[b.getAttribute('data-num')];
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-fleet-note]'), function (e) {
    e.textContent = '本舰 ' + v.tag + ' · 友军 ' + fleetAlive(0) + ' 艘 · 敌舰 ' + fleetAlive(1) + ' 艘';
  });
}
function syncShipCard() {
  var v = playerDef(G.fleet.ship);
  $('shipTag').textContent = v.tag;
  $('shipName').innerHTML = v.name + ' <em>' + v.romaji + '</em>';
  $('gunLabel').textContent = v.gunLabel;
  $('torpLabel').textContent = v.torpLabel;
  if (G.player) syncAmmoUI();
}
function openFleet() {
  if (G.state !== 'play') return;
  G.paused = true;
  $('overlayPause').classList.add('hidden');
  syncFleetUI();
  $('overlayFleet').classList.remove('hidden');
}
function closeFleet() {
  $('overlayFleet').classList.add('hidden');
  G.paused = false;
}
function backToMenu() {
  G.state = 'menu'; G.paused = false;
  $('overlayResult').classList.add('hidden');
  $('overlayFleet').classList.add('hidden');
  $('overlayPause').classList.add('hidden');
  G.mouse.has = false;
  G.mouse.sx = G.w * 0.5; G.mouse.sy = G.h * 0.42;
  reset();
  $('overlayStart').classList.remove('hidden');
}
function syncThrottle() {
  if (!G.player) return;
  Array.prototype.forEach.call(document.querySelectorAll('#throttle button'), function (b) {
    b.classList.toggle('on', parseInt(b.dataset.gear, 10) === G.player.gear);
  });
}
var hudTick = 0;
function updateHUD(force) {
  var p = G.player;
  if (!p) return;
  var hpR = U.clamp(p.hp / p.maxHp, 0, 1);
  $('hpFill').style.width = (hpR * 100).toFixed(1) + '%';
  $('hpFill').parentNode.classList.toggle('low', hpR < 0.35);
  var gunR = 1 - U.clamp(p.reload / p.reloadMax, 0, 1);
  $('gunFill').style.width = (gunR * 100).toFixed(1) + '%';
  $('gunFill').parentNode.classList.toggle('ready', gunR >= 1);
  var tr = p.def.torpDmg ? 1 - U.clamp(p.torpReload / p.torpReloadMax, 0, 1) : 0;
  $('torpFill').style.width = (tr * 100).toFixed(1) + '%';
  $('torpFill').parentNode.classList.toggle('ready', !!p.def.torpDmg && tr >= 1);
  var rf = U.clamp(p.rudder, -1, 1);
  var ri = $('rudderFill');
  ri.style.left = (rf < 0 ? 50 + rf * 50 : 50) + '%';
  ri.style.width = Math.abs(rf * 50) + '%';
  var rudderLabel = Math.abs(rf) < 0.08 ? '正舵' : (rf < 0 ? '左舵 ' : '右舵 ') + Math.round(Math.abs(rf) * 100) + '%';
  var heading = ((Math.round(U.norm(p.ang + Math.PI / 2) / U.TAU * 360) % 360) + 360) % 360;
  var hd = ('00' + heading).slice(-3) + '°';
  $('rudderText').textContent = window.matchMedia('(pointer: coarse)').matches
    ? rudderLabel + ' · ' + hd
    : rudderLabel + '  ·  航向 ' + hd;
  $('btnFireTouch').classList.toggle('disabled', p.reload > 0);
  $('btnTorpTouch').classList.toggle('disabled', !p.def.torpDmg || p.torpReload > 0);

  hudTick -= 1;
  if (!force && hudTick > 0) return;
  hudTick = 6;
  var inv = 1 / P().time;   // 游戏秒 → 玩家感知的真实秒
  $('hpText').textContent = U.fmt(Math.max(0, p.hp)) + ' / ' + U.fmt(p.maxHp);
  $('hpPct').textContent = Math.ceil(hpR * 100) + '%';
  $('enemyLeft').textContent = fleetAlive(1);
  $('allyLeft').textContent = fleetAlive(0);
  $('kills').textContent = G.stats.kills;
  $('clock').textContent = U.clock(G.realTime);
  $('speedVal').textContent = Math.round(Math.abs(p.speed) / 3.6 * P().time);
  $('gunText').textContent = p.reload > 0 ? ('装填 ' + (p.reload * inv).toFixed(1) + 's') : '就绪 · 可齐射';
  $('torpText').textContent = !p.def.torpDmg ? '未装备'
    : (p.torpReload > 0 ? ('装填 ' + (p.torpReload * inv).toFixed(1) + 's') : '就绪 · 3 枚');
  var icons = '';
  if (p.fire > 0) icons += '<i class="fire">起火</i>';
  if (p.flood > 0) icons += '<i class="flood">进水</i>';
  $('statusIcons').innerHTML = icons;
  var md = U.dist(p.x, p.y, G.mouse.wx, G.mouse.wy);
  var mdM = Math.round(md / KM2U * 1000);   // 世界单位 → 米
  $('aimDist').textContent = md > p.def.range ? mdM + ' !' : mdM;
  $('aimTime').textContent = (Math.min(md, p.def.range) / p.def.vel * inv).toFixed(1);
  var ta = U.norm(Math.atan2(G.mouse.wy - p.y, G.mouse.wx - p.x) - p.ang);
  var aligned = Math.abs(U.angDiff(p.turrets[0].ang, ta)) < 0.3;
  $('turretState').textContent = aligned ? '就位' : '转向';
  $('turretState').style.color = aligned ? '' : '#ffc46b';
  syncAmmoUI();
  // 战术特技按钮：未装备则隐藏；冷却中显示剩余秒
  var bS = $('btnSmoke'), bB = $('btnBoost');
  if (bS) {
    var hasSmoke = !!p.def.specials.smoke;
    bS.style.display = hasSmoke ? '' : 'none';
    if (hasSmoke) {
      bS.textContent = p.smokeCd > 0 ? '烟雾 ' + Math.ceil(p.smokeCd) + 's' : '烟雾 Z';
      bS.classList.toggle('cooling', p.smokeCd > 0);
    }
  }
  if (bB) {
    var hasBoost = !!p.def.specials.boost;
    bB.style.display = hasBoost ? '' : 'none';
    if (hasBoost) {
      bB.textContent = p.boostCd > 0 ? '增压 ' + Math.ceil(p.boostCd) + 's' : '增压 B';
      bB.classList.toggle('cooling', p.boostCd > 0);
    }
  }
}

function showResult() {
  var s = G.stats;
  $('resultEyebrow').textContent = G.win ? 'VICTORY · BATTLE REPORT' : 'DEFEAT · BATTLE REPORT';
  $('resultTitle').textContent = G.win ? '战斗胜利' : '本舰沉没';
  $('resultTitle').style.color = G.win ? '#7dffa8' : '#ff8a75';
  $('resultDesc').textContent = G.win
    ? '敌方舰队已全部沉入海底，海域控制权归你所有。'
    : '舰体进水无法控制……下次记得用机动规避敌方齐射。';
  $('statDamage').textContent = U.fmt(s.damage);
  $('statHit').textContent = (s.shots ? Math.round(s.hits / s.shots * 100) : 0) + '%';
  $('statKills').textContent = s.kills + ' / ' + G.fleet.enemies;
  $('statTime').textContent = U.clock(G.realTime);
  $('overlayResult').classList.remove('hidden');
}

/* ---------------- 雷达 ---------------- */
function drawRadar() {
  var S = 240, C = S / 2, R = 104, scale = R / K(8);   // 雷达覆盖半径 ≈ 8 km
  mctx.clearRect(0, 0, S, S);
  mctx.save();
  mctx.translate(C, C);
  // 底盘
  mctx.fillStyle = 'rgba(3,20,30,.72)';
  mctx.beginPath(); mctx.arc(0, 0, R, 0, U.TAU); mctx.fill();
  mctx.strokeStyle = 'rgba(111,227,255,.2)'; mctx.lineWidth = 1;
  for (var i = 1; i <= 3; i++) { mctx.beginPath(); mctx.arc(0, 0, R * i / 3, 0, U.TAU); mctx.stroke(); }
  mctx.beginPath(); mctx.moveTo(-R, 0); mctx.lineTo(R, 0); mctx.moveTo(0, -R); mctx.lineTo(0, R); mctx.stroke();
  // 扫描扇
  var a = G.time * 0.75;
  var g = mctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, 'rgba(111,227,255,.16)'); g.addColorStop(1, 'rgba(111,227,255,0)');
  mctx.fillStyle = g;
  mctx.beginPath(); mctx.moveTo(0, 0); mctx.arc(0, 0, R, a - 0.5, a); mctx.closePath(); mctx.fill();
  mctx.strokeStyle = 'rgba(111,227,255,.45)';
  mctx.beginPath(); mctx.moveTo(0, 0); mctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); mctx.stroke();
  mctx.beginPath(); mctx.arc(0, 0, R, 0, U.TAU); mctx.strokeStyle = 'rgba(111,227,255,.4)'; mctx.stroke();

  var p = G.player;
  // 鱼雷
  G.torps.forEach(function (t) {
    var x = (t.x - p.x) * scale, y = (t.y - p.y) * scale;
    if (x * x + y * y > R * R) return;
    mctx.fillStyle = t.owner === 0 ? '#ffc46b' : '#ff6a55';
    mctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  });
  // 友军
  G.ships.forEach(function (s) {
    if (s.team !== 0 || s.isPlayer || s.sunk) return;
    var x = (s.x - p.x) * scale, y = (s.y - p.y) * scale;
    var d = Math.sqrt(x * x + y * y);
    if (d > R - 5) { x *= (R - 5) / d; y *= (R - 5) / d; }
    mctx.fillStyle = '#8ce0b4';
    mctx.beginPath(); mctx.arc(x, y, 2.8, 0, U.TAU); mctx.fill();
  });
  // 敌舰
  G.ships.forEach(function (s) {
    if (s.team === 0 || s.sunk) return;
    var x = (s.x - p.x) * scale, y = (s.y - p.y) * scale;
    var d = Math.sqrt(x * x + y * y);
    if (d > R - 5) { x *= (R - 5) / d; y *= (R - 5) / d; }
    mctx.fillStyle = '#ff6a55';
    mctx.beginPath(); mctx.arc(x, y, 3.4, 0, U.TAU); mctx.fill();
    mctx.strokeStyle = 'rgba(255,106,85,.45)'; mctx.lineWidth = 1;
    mctx.beginPath(); mctx.arc(x, y, 7, 0, U.TAU); mctx.stroke();
  });
  // 本舰
  mctx.save(); mctx.rotate(p.ang);
  mctx.fillStyle = '#6fe3ff'; mctx.strokeStyle = '#d8f8ff'; mctx.lineWidth = 1;
  mctx.beginPath(); mctx.moveTo(9, 0); mctx.lineTo(-6, -5.5); mctx.lineTo(-3, 0); mctx.lineTo(-6, 5.5);
  mctx.closePath(); mctx.fill(); mctx.stroke();
  mctx.restore();
  mctx.restore();
}

/* ---------------- 渲染 ---------------- */
function drawSea(view, t) {
  // 边界外深海
  ctx.fillStyle = '#051724';
  ctx.fillRect(view.x, view.y, view.w, view.h);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, WORLD, WORLD); ctx.clip();
  ctx.fillStyle = seaPattern;
  ctx.fillRect(view.x, view.y, view.w, view.h);
  // 洋流层（缓慢漂移）
  var ox = t * 9, oy = t * 3.5;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = currentPattern;
  ctx.fillRect(view.x - ox, view.y - oy, view.w, view.h);
  ctx.restore();
  // 战术网格
  ctx.strokeStyle = 'rgba(120,200,225,.028)'; ctx.lineWidth = 1 / G.zoom;
  var step = 500;
  var x0 = Math.floor(view.x / step) * step, y0 = Math.floor(view.y / step) * step;
  ctx.beginPath();
  for (var gx = x0; gx < view.x + view.w + step; gx += step) { ctx.moveTo(gx, view.y); ctx.lineTo(gx, view.y + view.h); }
  for (var gy = y0; gy < view.y + view.h + step; gy += step) { ctx.moveTo(view.x, gy); ctx.lineTo(view.x + view.w, gy); }
  ctx.stroke();
  // 边界线
  ctx.strokeStyle = 'rgba(111,227,255,.22)'; ctx.lineWidth = 3 / G.zoom;
  ctx.setLineDash([18 / G.zoom, 14 / G.zoom]);
  ctx.strokeRect(0, 0, WORLD, WORLD);
  ctx.setLineDash([]);
  ctx.restore();
  // 光带
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  var band = view.w * 0.22;
  for (var i = 0; i < 3; i++) {
    var lx = view.x + view.w * (0.22 + i * 0.3) + Math.sin(t * 0.12 + i) * view.w * 0.06;
    var grd = ctx.createLinearGradient(lx - band, 0, lx + band, 0);
    grd.addColorStop(0, 'rgba(90,180,220,0)');
    grd.addColorStop(0.5, 'rgba(90,180,220,.022)');
    grd.addColorStop(1, 'rgba(90,180,220,0)');
    ctx.fillStyle = grd; ctx.fillRect(lx - band, view.y, band * 2, view.h);
  }
  // 日光辉斑：固定于海面某处，随波闪动
  var gx = WORLD * 0.3 + Math.sin(t * 0.05) * 260, gy = WORLD * 0.24;
  var gr = 620 + Math.sin(t * 0.6) * 40;
  var gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
  gg.addColorStop(0, 'rgba(255,244,214,.085)');
  gg.addColorStop(0.35, 'rgba(255,240,200,.03)');
  gg.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = gg;
  ctx.beginPath(); ctx.ellipse(gx, gy, gr, gr * 0.7, 0.3, 0, U.TAU); ctx.fill();
  // 闪烁碎光
  for (var s = 0; s < 26; s++) {
    var sa = (s * 2.399 + t * 0.35) % U.TAU;
    var sd = gr * (0.25 + (s % 5) * 0.13);
    var sxp = gx + Math.cos(sa) * sd, syp = gy + Math.sin(sa) * sd * 0.7;
    var tw = Math.max(0, Math.sin(t * 3 + s * 1.7));
    if (tw > 0.2) {
      ctx.fillStyle = 'rgba(255,250,225,' + (tw * 0.16).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(sxp, syp, 10 + tw * 16, 2 + tw * 2.5, sa, 0, U.TAU); ctx.fill();
    }
  }
  ctx.restore();
  // 深浅水色斑（大尺度缓变，增加海面层次）
  ctx.save();
  var depthPatches = [[0.22, 0.3, 2600], [0.68, 0.22, 2100], [0.78, 0.72, 2400], [0.3, 0.78, 1900]];
  for (var dp = 0; dp < depthPatches.length; dp++) {
    var px = WORLD * depthPatches[dp][0], py = WORLD * depthPatches[dp][1], pr = depthPatches[dp][2];
    if (px + pr < view.x || px - pr > view.x + view.w || py + pr < view.y || py - pr > view.y + view.h) continue;
    var dg = ctx.createRadialGradient(px, py, 0, px, py, pr);
    dg.addColorStop(0, 'rgba(10,55,66,.14)'); dg.addColorStop(1, 'rgba(10,55,66,0)');
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.ellipse(px, py, pr, pr * 0.8, 0.6, 0, U.TAU); ctx.fill();
  }
  ctx.restore();
}

function drawScenery(view, t) {
  // 缓慢漂移的云影
  G.clouds.forEach(function (c) {
    var x = c.x + t * c.vx, y = c.y + t * c.vy;
    if (x + c.r < view.x || x - c.r > view.x + view.w || y + c.r < view.y || y - c.r > view.y + view.h) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, c.r);
    g.addColorStop(0, 'rgba(1,12,22,.17)'); g.addColorStop(1, 'rgba(1,12,22,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, c.r, c.r * 0.62, 0.4, 0, U.TAU); ctx.fill();
  });
  // 礁石 / 岛屿（纯装饰，不参与碰撞），按高低差立体渲染
  G.reefs.forEach(function (r) {
    if (r.x + r.r * 2 < view.x || r.x - r.r * 2 > view.x + view.w ||
        r.y + r.r * 2 < view.y || r.y - r.r * 2 > view.y + view.h) return;
    ctx.save();
    ctx.translate(r.x, r.y);
    // 浅滩水色：浅滩最亮、岛屿次之
    var g = ctx.createRadialGradient(0, 0, r.r * 0.2, 0, 0, r.r * 1.8);
    var tint = r.tier === 0 ? 'rgba(120,200,200,.14)' : (r.tier === 2 ? 'rgba(92,178,192,.1)' : 'rgba(92,178,192,.075)');
    g.addColorStop(0, tint); g.addColorStop(1, 'rgba(92,178,192,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r.r * 1.8, 0, U.TAU); ctx.fill();
    // 浪花环：两圈相位错开的脉动白环
    ctx.lineWidth = 1.4 / G.zoom;
    for (var w = 0; w < 2; w++) {
      var ph = t * 1.5 + r.ph + w * 2.2;
      var a = (0.07 + Math.sin(ph) * 0.045 + w * 0.03).toFixed(3);
      var rr = r.r * (1.42 - w * 0.3 + Math.sin(ph * 0.7) * 0.05);
      ctx.strokeStyle = 'rgba(198,236,244,' + a + ')';
      ctx.beginPath(); ctx.ellipse(0, 0, rr, rr * 0.72, 0.35, 0, U.TAU); ctx.stroke();
    }
    // 岛屿额外一圈近岸碎浪
    if (r.tier === 2) {
      ctx.strokeStyle = 'rgba(220,246,252,' + (0.1 + Math.sin(t * 2.1 + r.ph) * 0.05).toFixed(3) + ')';
      ctx.lineWidth = 2 / G.zoom;
      ctx.beginPath(); ctx.ellipse(0, 0, r.r * 1.06, r.r * 0.76, 0.35, 0, U.TAU); ctx.stroke();
    }
    ctx.restore();
    // 立体岩体（挤出层 + 落影）
    r.rocks.forEach(function (k) { drawRockBody(k, r.tier); });
  });
}

function drawWorld(t) {
  var view = {
    x: G.cam.x - G.w / (2 * G.zoom), y: G.cam.y - G.h / (2 * G.zoom),
    w: G.w / G.zoom, h: G.h / G.zoom
  };
  drawSea(view, t);
  drawScenery(view, t);
  // 尾迹
  for (var i = 0; i < G.ships.length; i++) IT.drawWake(ctx, G.ships[i]);
  // 鱼雷航迹
  G.torps.forEach(function (tp) {
    if (tp.trail.length > 1) {
      ctx.save(); ctx.lineCap = 'round';
      for (var k = 1; k < tp.trail.length; k++) {
        var a = tp.trail[k - 1], b = tp.trail[k];
        if (b.a <= 0) continue;
        ctx.strokeStyle = tp.owner === 0 ? 'rgba(210,245,255,' + (b.a * 0.5).toFixed(2) + ')'
                                         : 'rgba(255,190,150,' + (b.a * 0.5).toFixed(2) + ')';
        ctx.lineWidth = 1.6 + b.a * 1.6;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.save(); ctx.translate(tp.x, tp.y); ctx.rotate(tp.ang);
    ctx.fillStyle = tp.owner === 0 ? '#bfe9f5' : '#ffc2a8';
    ctx.fillRect(-7, -1.6, 14, 3.2);
    ctx.restore();
  });
  // 舰船
  for (var j = 0; j < G.ships.length; j++) IT.drawShip(ctx, G.ships[j], t, G.zoom);
  // 烟幕（覆盖舰船与鱼雷航迹，形成视觉遮蔽）
  G.smokes.forEach(function (p) {
    var a = U.clamp(p.life / p.maxLife, 0, 1);
    var fadeIn = U.clamp((p.maxLife - p.life) / 1.2, 0, 1);
    var g = ctx.createRadialGradient(p.x, p.y, p.r * 0.12, p.x, p.y, p.r);
    g.addColorStop(0, 'rgba(196,206,212,' + (0.62 * a * fadeIn).toFixed(3) + ')');
    g.addColorStop(0.6, 'rgba(170,182,190,' + (0.4 * a * fadeIn).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(150,162,172,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, U.TAU); ctx.fill();
  });
  // 粒子
  G.particles.draw(ctx);
  // 炮弹
  G.shells.forEach(function (sh) {
    var y = sh.drawY(), py = sh.py - Math.sin(Math.max(0, (sh.t - 0.016) / sh.dur) * Math.PI) * sh.arc;
    ctx.save();
    ctx.strokeStyle = sh.owner === 0 ? 'rgba(180,240,255,.55)' : 'rgba(255,190,140,.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(sh.px, py); ctx.lineTo(sh.x, y); ctx.stroke();
    ctx.fillStyle = sh.owner === 0 ? '#e8fbff' : '#ffd0a0';
    ctx.shadowColor = sh.owner === 0 ? '#7fe6ff' : '#ff8a55'; ctx.shadowBlur = 9;
    ctx.beginPath(); ctx.arc(sh.x, y, 2.1, 0, U.TAU); ctx.fill();
    ctx.restore();
    // 敌方落点预警
    if (sh.owner === 1 && sh.t / sh.dur > 0.2) {
      var pulse = 0.5 + Math.sin(t * 12) * 0.2, iz = 1 / G.zoom;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,90,70,' + pulse.toFixed(2) + ')';
      ctx.lineWidth = 1.6 * iz; ctx.setLineDash([5 * iz, 5 * iz]);
      ctx.beginPath(); ctx.arc(sh.tx, sh.ty, (15 + Math.sin(t * 8) * 2) * iz, 0, U.TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sh.tx - 5 * iz, sh.ty - 5 * iz); ctx.lineTo(sh.tx + 5 * iz, sh.ty + 5 * iz);
      ctx.moveTo(sh.tx + 5 * iz, sh.ty - 5 * iz); ctx.lineTo(sh.tx - 5 * iz, sh.ty + 5 * iz); ctx.stroke();
      ctx.restore();
    }
  });
  // 提前量标记（火控解算）
  // 手动瞄准时给出提前量与散布提示；辅助模式已有锁定环，避免画面过载
  if (G.player && !G.player.sunk && !G.assist) drawLeadMarks();
  if (G.state === 'play' && G.mouse.has && !G.assist) drawAimSpot(t);
  // 伤害飘字
  G.floats.forEach(function (f) {
    var iz = 1 / G.zoom;
    ctx.save();
    ctx.globalAlpha = U.clamp(f.life / 1.15, 0, 1);
    ctx.font = 'bold ' + (f.crit ? 15 : 12) * iz + 'px Consolas,monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = f.color;
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
    ctx.fillText(f.text, f.x, f.y);
    if (f.crit) {
      ctx.font = 9 * iz + 'px Consolas,monospace'; ctx.fillStyle = '#ffd45e';
      ctx.fillText('核心区', f.x, f.y - 14 * iz);
    }
    ctx.restore();
  });
}

// 火控解算：迭代求取炮弹与目标的相遇点
function leadPoint(s) {
  var p = G.player;
  var d = U.dist(p.x, p.y, s.x, s.y);
  var f = d / p.def.vel;
  var lx = s.x + s.vx * f, ly = s.y + s.vy * f;
  for (var it = 0; it < 2; it++) {
    f = U.dist(p.x, p.y, lx, ly) / p.def.vel;
    lx = s.x + s.vx * f; ly = s.y + s.vy * f;
  }
  return { x: lx, y: ly, d: d };
}
function nearestTarget(inRangeOnly) {
  var p = G.player, best = null, bd = Infinity;
  G.ships.forEach(function (s) {
    if (s.team === 0 || s.sunk) return;
    var d = U.dist(p.x, p.y, s.x, s.y);
    if (inRangeOnly && d > p.def.range) return;
    if (losBlocked(p.x, p.y, s.x, s.y)) return;   // 岛后目标不参与解算
    if (d < bd) { bd = d; best = s; }
  });
  return best;
}

function drawLeadMarks() {
  var p = G.player;
  G.ships.forEach(function (s) {
    if (s.team === 0 || s.sunk) return;
    var d = U.dist(p.x, p.y, s.x, s.y);
    if (d > p.def.range * 1.15) return;
    var lp = leadPoint(s);
    var lx = lp.x, ly = lp.y, iz = 1 / G.zoom;
    var sz = 10 * iz, gap = 3 * iz;
    ctx.save();
    ctx.strokeStyle = 'rgba(125,255,168,.85)'; ctx.lineWidth = 1.4 * iz;
    ctx.setLineDash([4 * iz, 3 * iz]);
    ctx.beginPath(); ctx.arc(lx, ly, 14 * iz, 0, U.TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(lx - sz, ly); ctx.lineTo(lx - gap, ly);
    ctx.moveTo(lx + gap, ly); ctx.lineTo(lx + sz, ly);
    ctx.moveTo(lx, ly - sz); ctx.lineTo(lx, ly - gap);
    ctx.moveTo(lx, ly + gap); ctx.lineTo(lx, ly + sz);
    ctx.stroke();
    ctx.fillStyle = 'rgba(125,255,168,.85)';
    ctx.font = 9 * iz + 'px Consolas,monospace'; ctx.textAlign = 'center';
    ctx.fillText('LEAD ' + Math.round(d / KM2U * 1000) + 'm', lx, ly - 20 * iz);
    ctx.restore();
  });
}

function drawAimSpot(t) {
  var p = G.player;
  var d = U.dist(p.x, p.y, G.mouse.wx, G.mouse.wy);
  var over = d > p.def.range;
  var a = Math.atan2(G.mouse.wy - p.y, G.mouse.wx - p.x);
  var eff = Math.min(d, p.def.range);
  var ax = p.x + Math.cos(a) * eff, ay = p.y + Math.sin(a) * eff;
  var sigma = (p.def.sigma + eff * 0.008) * 1.7;
  ctx.save();
  ctx.strokeStyle = over ? 'rgba(255,120,90,.55)' : 'rgba(150,225,245,.42)';
  ctx.lineWidth = 1.2; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.ellipse(ax, ay, sigma * 1.5, sigma, a, 0, U.TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(ax, ay, 3, 0, U.TAU); ctx.stroke();
  if (over) {
    ctx.fillStyle = 'rgba(255,140,110,.9)'; ctx.font = 11 / G.zoom + 'px Consolas,monospace'; ctx.textAlign = 'center';
    ctx.fillText('超出射程', ax, ay - sigma - 10 / G.zoom);
  }
  ctx.restore();
}

function drawCrosshair(t) {
  if (!G.mouse.has || G.state !== 'play') return;
  var x = G.mouse.sx, y = G.mouse.sy;
  var p = G.player;
  var d = U.dist(p.x, p.y, G.mouse.wx, G.mouse.wy);
  var ready = p.reload <= 0;
  var col = !ready ? 'rgba(150,175,185,.65)' : (d > p.def.range ? 'rgba(255,120,90,.9)' : 'rgba(150,235,255,.95)');
  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.arc(x, y, 17 + Math.sin(t * 3) * 1.2, 0, U.TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x - 24, y); ctx.lineTo(x - 8, y);
  ctx.moveTo(x + 8, y); ctx.lineTo(x + 24, y);
  ctx.moveTo(x, y - 24); ctx.lineTo(x, y - 8);
  ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 24);
  ctx.stroke();
  ctx.fillStyle = col; ctx.fillRect(x - 1, y - 1, 2, 2);
  ctx.font = '10px Consolas,monospace'; ctx.textAlign = 'left';
  ctx.fillText(Math.round(d / KM2U * 1000) + 'm', x + 27, y - 10);
  ctx.fillText((Math.min(d, p.def.range) / p.def.vel / P().time).toFixed(1) + 's', x + 27, y + 3);
  if (G.assist && nearestTarget(true)) {
    ctx.strokeStyle = 'rgba(125,255,168,.9)'; ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, 26, 0, U.TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(125,255,168,.95)'; ctx.font = '9px Consolas,monospace';
    ctx.fillText('AUTO LOCK', x + 27, y + 17);
  }
  ctx.restore();
}

function drawOffscreenMarkers() {
  if (G.state !== 'play' || !G.player) return;
  var pad = 44, cx = G.w / 2, cy = G.h / 2;
  G.ships.forEach(function (s) {
    if (s.team === 0 || s.sunk) return;
    var sc = worldToScreen(s.x, s.y);
    if (sc.x > pad && sc.x < G.w - pad && sc.y > pad && sc.y < G.h - pad) return;
    var a = Math.atan2(sc.y - cy, sc.x - cx);
    var rx = (G.w / 2 - pad) / Math.max(0.0001, Math.abs(Math.cos(a)));
    var ry = (G.h / 2 - pad) / Math.max(0.0001, Math.abs(Math.sin(a)));
    var r = Math.min(rx, ry);
    var ex = cx + Math.cos(a) * r, ey = cy + Math.sin(a) * r;
    ctx.save();
    var pulse = 0.55 + Math.sin(performance.now() * 0.008) * 0.25;
    ctx.fillStyle = 'rgba(255,90,70,' + (0.16 * pulse).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(ex, ey, 17, 0, U.TAU); ctx.fill();
    ctx.translate(ex, ey); ctx.rotate(a);
    ctx.fillStyle = 'rgba(255,120,95,.95)';
    ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -5.5); ctx.lineTo(-6, 5.5); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.font = '9px Consolas,monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,180,160,.75)';
    ctx.fillText(Math.round(U.dist(G.player.x, G.player.y, s.x, s.y) / KM2U * 1000) + 'm',
      U.clamp(ex - Math.cos(a) * 18, 34, G.w - 34), U.clamp(ey - Math.sin(a) * 18, 20, G.h - 20));
    ctx.restore();
  });
}

function drawScreenFx() {
  if (G.hitFlash > 0) {
    ctx.save();
    var a = G.hitFlash * 0.32;
    var g = ctx.createRadialGradient(G.w / 2, G.h / 2, Math.min(G.w, G.h) * 0.25,
                                     G.w / 2, G.h / 2, Math.max(G.w, G.h) * 0.72);
    g.addColorStop(0, 'rgba(255,60,40,0)'); g.addColorStop(1, 'rgba(255,50,30,' + a.toFixed(3) + ')');
    ctx.fillStyle = g; ctx.fillRect(0, 0, G.w, G.h);
    ctx.restore();
  }
  // 低血量警示
  if (G.player && G.player.hp / G.player.maxHp < 0.3 && G.state === 'play') {
    ctx.save();
    ctx.globalAlpha = 0.12 + Math.sin(performance.now() * 0.006) * 0.06;
    ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, G.w - 12, G.h - 12);
    ctx.restore();
  }
}

/* ---------------- 主循环 ---------------- */
var last = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  var realDt = Math.min((ts - last) / 1000 || 0, 0.05);
  last = ts;
  if (G.paused) { render(G.visTime); return; }
  // 世界与画面统一按节奏流速推进；HUD / 结算用真实时间计时
  G.visTime += realDt * P().time;
  if (G.state === 'play') G.realTime += realDt;
  update(realDt * P().time);
  render(G.visTime);
}

function update(dt) {
  // rdt = 真实时间步：UI 提示、结算延迟、镜头跟随不随慢动作一起被拖长
  var rdt = dt / P().time;
  G.time += dt;
  // 鼠标 → 世界
  var mw = screenToWorld(G.mouse.sx, G.mouse.sy);
  G.mouse.wx = mw.x; G.mouse.wy = mw.y;

  // 火控：玩家获得/失去有效射击解算时播报「目标锁定」
  if (G.state === 'play' && G.player && !G.player.sunk) {
    var inRange = nearestTarget(true);
    if (inRange && !G.hadTarget) {
      if (G.voice) G.voice.say('target_lock', 1500);
    }
    G.hadTarget = !!inRange;
    // 火控辅助：把准星自动吸附到最近目标的解算提前量（触屏 / 新手友好）
    if (G.assist) {
      var tgt = inRange || nearestTarget();
      if (tgt) {
        var lp = leadPoint(tgt);
        var sp = worldToScreen(lp.x, lp.y);
        G.mouse.wx = lp.x; G.mouse.wy = lp.y;
        G.mouse.sx = U.clamp(sp.x, 24, G.w - 24);
        G.mouse.sy = U.clamp(sp.y, 24, G.h - 24);
        G.mouse.has = true;
      }
    }
  }

  if (G.state === 'play') {
    // 玩家炮塔跟随准星
    if (G.player && !G.player.sunk) {
      var rel = U.norm(Math.atan2(G.mouse.wy - G.player.y, G.mouse.wx - G.player.x) - G.player.ang);
      G.player.turrets.forEach(function (t) { t.target = rel; });
    }
    // 按住开火
    if (G.heldFire && G.player.reload <= 0) playerFire();
    // 玩家自动副炮（俾斯麦）：与 AI 同逻辑，射程内自动持续输出
    var pl = G.player;
    if (pl && !pl.sunk && pl.def.specials.secondary && pl.secReload <= 0) {
      var secTgt = null, secD = Infinity;
      G.ships.forEach(function (o) {
        if (o.team !== 1 || o.sunk) return;   // 只瞄准敌舰
        var d = U.dist(pl.x, pl.y, o.x, o.y);
        if (o.smokeTime > 0 && d > 420) return;   // 烟幕遮蔽同 AI 规则
        if (d < secD) { secD = d; secTgt = o; }
      });
      if (secTgt && secD < pl.def.specials.secRange) fireSecondary(pl, secTgt);
    }
    G.ships.forEach(function (s) {
      if (!s.isPlayer && !s.sunk) updateAI(s, dt);
      s.update(dt);
    });
  } else if (G.state === 'over') {
    // 结算前继续播放沉没动画
    G.ships.forEach(function (s) { if (s.sunk) s.update(dt); });
  } else if (G.state === 'menu') {
    // 菜单背景：舰船缓慢漂泊
    G.ships.forEach(function (s) {
      if (s.sunk) return;
      s.x += Math.cos(s.ang) * 8 * dt; s.y += Math.sin(s.ang) * 8 * dt;
      s.wakeTick += dt;
      if (s.wakeTick > 0.09) {
        s.wakeTick = 0;
        s.wake.push({ x: s.x - Math.cos(s.ang) * s.len * 0.48, y: s.y - Math.sin(s.ang) * s.len * 0.48,
          nx: -Math.sin(s.ang), ny: Math.cos(s.ang), age: 0 });
        if (s.wake.length > 48) s.wake.shift();
      }
      for (var i = s.wake.length - 1; i >= 0; i--) { s.wake[i].age += dt * 0.6; if (s.wake[i].age > 3.4) s.wake.splice(i, 1); }
    });
  }

  // 弹丸
  for (var i = G.shells.length - 1; i >= 0; i--) if (!G.shells[i].update(dt)) G.shells.splice(i, 1);
  for (var j = G.torps.length - 1; j >= 0; j--) if (!G.torps[j].update(dt)) G.torps.splice(j, 1);
  G.particles.update(dt);
  // 烟幕团按真实秒消散
  for (var sm = G.smokes.length - 1; sm >= 0; sm--) {
    G.smokes[sm].life -= rdt;
    if (G.smokes[sm].life <= 0) G.smokes.splice(sm, 1);
  }
  for (var k = G.floats.length - 1; k >= 0; k--) {
    G.floats[k].life -= dt; G.floats[k].y += G.floats[k].vy * dt;
    if (G.floats[k].life <= 0) G.floats.splice(k, 1);
  }
  G.shake = Math.max(0, G.shake - (dt / P().time) * 30);   // 按真实时间衰减：慢节奏下不残留
  G.hitFlash = Math.max(0, G.hitFlash - dt * 1.7);
  G.tipCd = Math.max(0, G.tipCd - rdt);
  if (G.toastTimer > 0) {
    G.toastTimer -= rdt;
    if (G.toastTimer <= 0) $('toast').classList.remove('show');
  }
  // 相机
  if (G.player) {
    var la = G.mouse.has ? Math.atan2(G.mouse.wy - G.player.y, G.mouse.wx - G.player.x) : G.player.ang;
    var tx = G.player.x + Math.cos(la) * 110, ty = G.player.y + Math.sin(la) * 110;
    var k = 1 - Math.pow(0.002, rdt);
    G.cam.x = U.lerp(G.cam.x, tx, k); G.cam.y = U.lerp(G.cam.y, ty, k);
  }
  // 结算
  if (G.endTimer > 0) {
    G.endTimer -= rdt;
    if (G.endTimer <= 0) showResult();
  }
  updateHUD(false);
}

function render(t) {
  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  ctx.clearRect(0, 0, G.w, G.h);
  ctx.fillStyle = '#051724'; ctx.fillRect(0, 0, G.w, G.h);
  var sx = G.shake > 0 ? U.rand(-G.shake, G.shake) : 0;
  var sy = G.shake > 0 ? U.rand(-G.shake, G.shake) : 0;
  ctx.save();
  ctx.translate(G.w / 2 + sx, G.h / 2 + sy);
  ctx.scale(G.zoom, G.zoom);
  ctx.translate(-G.cam.x, -G.cam.y);
  drawWorld(t);
  ctx.restore();
  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  drawCrosshair(t);
  drawOffscreenMarkers();
  drawScreenFx();
  drawRadar();
}

/* ---------------- 启动 ---------------- */
function boot() {
  seaPattern = ctx.createPattern(IT.makeSeaTexture(512), 'repeat');
  currentPattern = ctx.createPattern(IT.makeCurrentTexture(512), 'repeat');
  resize();
  window.addEventListener('resize', resize);
  bindInput();
  $('fleetSetup').innerHTML = fleetMarkup();
  $('fleetLive').innerHTML = fleetMarkup();
  setAssist(window.matchMedia('(pointer: coarse)').matches);   // 触屏默认开启自动解算
  setPace(G.pace);                                            // 默认慢节奏
  reset();
  G.state = 'menu';
  // 菜单时的准星位置
  G.mouse.sx = G.w * 0.5; G.mouse.sy = G.h * 0.42; G.mouse.has = false;
  requestAnimationFrame(frame);
}
boot();

})();

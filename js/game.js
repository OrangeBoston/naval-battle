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
var seaPattern, seabedMap, seabedSize = 1200;

/* ---------------- 参数 ---------------- */
var WORLD = 14000;                  // 海域边长：约 75 km（对标双峰海峡 42×42km 的战场密度），岛群基本铺满、四周无大片空白
var SPAWN_DIAG = 4600;              // 对角出生：锚点偏离中心的 x/y 距离 → 双方相隔 2×4600×√2 ≈ 13000u（约 70 km），远超主炮射程
var SHELL_SPEED = 1500;             // 炮弹水平速度（世界单位/秒）：统一较高初速，使长射程炮弹飞行时间仍合理
var TORP_SPEED = 216;               // 鱼雷基础航速（实际被每舰 torpSpeed 覆盖）
// 世界尺度：1 km = 187 世界单位 → 与真实射程一致（睦月 8.1km = 1515u；转向半径 550m = 102.9u）
var KM2U = 187;
var M_PER_U = 1 / KM2U;             // 世界单位 → 公里（用于 HUD 距离显示）
var TORP_K = 3.6;                   // 鱼雷节 → 世界单位/秒：与战舰同一换算（1 节 = 3.6 u/s），避免鱼雷隐性变慢
function K(km) { return Math.round(km * KM2U); }                  // km → 世界单位
function SP(knots) { return knots * 3.6 / 154; }                 // 节 → 速度倍率（极速档显示正确节数）
function TR(knots, rM) { return (knots * 3.6) / (rM * (KM2U / 1000)); } // 转向半径(米) → 角速率
function RR(sec) { return 1 / sec; }                             // 转舵时间(秒) → 转舵速率
function TS(knots) { return knots * TORP_K; }                    // 鱼雷节 → 世界单位/秒
var GEAR_SPEED = [-44, 0, 50, 84, 120, 154];  // gear -1..4 → 目标速度
var GEAR_NAME = ['倒车', '停车', '微速', '半速', '全速', '极速'];

/* ---------------- 战斗节奏 ----------------
   默认「标准」= 基准 100%（世界绝对时标 0.2）；「快速」= 500%（流速 5 倍于标准）。
   战舰航速、炮弹/鱼雷装填、弹丸飞行全部随流速等比 ×5，敌我相对平衡不变；
   敌方火力在标准档更稀疏、预判更粗糙，本舰更耐打。HUD 上的所有秒数都按真实时间换算显示。
   time        全局时间流速倍率（船体位移 / 转向 / 弹丸 / AI / 海面动画）
   enemyReload 敌方装填时长（游戏秒）；真实感知间隔 = base × enemyReload / time
   enemyDmg    敌方伤害 / enemySigma 敌方散布 / enemyLead 敌方预判误差
   torpSpeed   鱼雷航速倍率（标准档不再额外减速，避免双重降速让鱼雷失去战术意义）
   playerHp    本舰耐久 / playerDmg 本舰火力
   playerReload 本舰装填补偿：真实装填 = base × playerReload / time；
                两档均设 0.2 → 标准（time=0.2）真实装填 = base（基准 100%），
                快速（time=1）真实装填 = base/5——世界 5 倍速，装填同步 ×500%，
                与战舰航速、AI 装填的倍率严格一致
   aiTorpCd    敌方鱼雷间隔（按真实秒计时，不随流速拉长）
   注意：舵角 / 炮塔 / 车钟加速仍按真实时间响应，慢的是世界，不是玩家的操作。
   内部键沿用 slow / normal，仅显示文字改为「标准 / 快速」。
------------------------------------------- */
var PACES = {
  slow: {                       // 默认档 · 显示「标准」· 基准 100%（真实流速 = 0.2×世界绝对时标）
    label: '标准', short: '标', time: 0.2,
    enemyReload: 0.9, enemyDmg: 0.6, enemySigma: 1.7, enemyLead: 1.3,
    torpSpeed: 1, playerHp: 1, playerDmg: 1.1, playerReload: 0.2, aiTorpCd: 1.25
  },
  normal: {                     // 加速档 · 显示「快速」· 500%（流速 5 倍于标准档）
    label: '快速', short: '快', time: 1,
    enemyReload: 1, enemyDmg: 1, enemySigma: 1.3, enemyLead: 1,
    torpSpeed: 1, playerHp: 1, playerDmg: 1, playerReload: 0.2, aiTorpCd: 1
  }
};
var P = function () { return PACES[G.pace]; };
// 真实秒 → 游戏秒：给「希望按真实时间计」的计时器使用（不受节奏流速拖长）
function paceSec(sec) { return sec * P().time; }
// 一组独立装填计时器里剩余最多的一个（游戏秒）——用于显示"全部就绪还要多久"
function minRemaining(arr) {
  var m = 0;
  for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/* ---------------- 舰船数据（9 艘 · 完全体 · 节奏差异化）----------------
   数值换算：
     · 射程 / 转向半径：1 km = 187 世界单位（KM2U）→ 真实射程 8.1km = 1515u
     · 航速：speedScale = 节 × 3.6 / 154（极速档在 HUD 显示正确节数）
     · 转向半径(米) → 角速率：TR(节, 半径米)
     · 转舵时间(秒) → 转舵速率：RR(秒)
     · 鱼雷节 → 世界单位/秒：TS(节)  （1 节 = 3.6 u/s，与战舰同一换算）
     · 炮弹初速：vel = m/s × 1.875（统一较高初速，长射程飞行时间仍合理）
     · 鱼雷发射管：torpTubes 总管数 → TORP_MOUNT 每座联装数 → torpSalvos 发射管座数；
       一次只打一座（左右舷交替），每座独立进 torpReload 长装填、互不影响
   ★ 节奏差异化：9 艘舰在「航速 / 加速 / 舵效 / 主炮装填 / 炮塔回转 /
     鱼雷装填与航速 / 交战距离 / 散布」上各有独立数值，装填秒数即玩家感知的真实秒。
     同一类里也刻意拉开梯度：DD 极速慢炮 ↔ 极速射速，CA 连射 ↔ 重炮慢射，
     BB 巨炮最慢 ↔ 高速速射。玩家 / 友军 / 敌舰共用这份数据（shipDef 唯一数据源）。
   ★ speedScale / maxTurn / rudderRate 由数组末尾统一派生，改原始数值不会漏改。
   机制：不做水听 / 维修；炮弹为实体投射物，带飞行时间 + 下坠（弧线）。
   ★ 弹种分工：AP 才能击穿核心区（×2），对轻甲驱逐舰易过穿（伤害 ×0.35）；
     HE 永不暴击但伤害稳定、每发有起火概率，点燃后持续掉血。
   ★ 隐蔽：每舰有独立被侦测距离（DD 最小、BB 最大），受开炮暴露、烟幕、
     岛礁遮蔽、起火与航速影响；未被发现的敌舰不会出现在视野 / 雷达 / 火控解算里。
------------------------------------------------------------- */
var VS = 1500 / 800;   // 初速换算：800 m/s ≈ 1500 世界单位/秒
// 各舰被侦测距离（km）：船体越大越显眼，同为 DD / CA / BB 也拉开梯度
var CONCEAL_KM = {
  mutsuki: 5.2, farragut: 5.6, lightning: 5.9,
  cleveland: 7.2, myoko: 8.6, atago: 8.2,
  nagato: 11.2, bismarck: 10.6, york: 10.0
};
var PLAYER_SHIPS = [
  /* ===== 驱逐舰：航速最快，主炮 / 鱼雷节奏分三档 ===== */
  {
    key: 'mutsuki', name: '睦月', romaji: 'MUTSUKI', tag: 'DD · 驱逐舰', short: 'DD 睦月',
    desc: '极速 · 远距重雷 · 慢炮', kind: 'dd', len: 150, beam: 26,
    maxHp: 11300, knots: 42, turnR: 540, rudderShift: 1.8, accel: 35, turretRate: 1.7,
    turrets: [{ lx: -0.34, barrels: 1 }, { lx: 0.34, barrels: 1 }],
    reload: 6.4, he: 1700, ap: 2000, sigma: 16, range: K(8.1), vel: Math.round(900 * VS),
    torpTubes: 6, torpDmg: 14600, torpReload: 76, torpSpeed: TS(67), torpRange: K(9.5),
    specials: { smoke: true }, prefer: 650,
    gunLabel: '120mm ×2 · 900m/s', torpLabel: '610mm 3联装 ×2'
  },
  {
    key: 'farragut', name: '法拉格特', romaji: 'FARRAGUT', tag: 'DD · 驱逐舰', short: 'DD 法拉格特',
    desc: '极速射速 · 近距快雷', kind: 'dd', len: 152, beam: 27,
    maxHp: 10700, knots: 46, turnR: 520, rudderShift: 2.2, accel: 31, turretRate: 3.2,
    turrets: [{ lx: -0.4, barrels: 1 }, { lx: -0.13, barrels: 1 }, { lx: 0.13, barrels: 1 }, { lx: 0.4, barrels: 1 }],
    reload: 3.4, he: 1800, ap: 2100, sigma: 12.5, range: K(7.6), vel: Math.round(800 * VS),
    torpTubes: 6, torpDmg: 11200, torpReload: 40, torpSpeed: TS(66), torpRange: K(5.5),
    specials: { smoke: true }, prefer: 620,
    gunLabel: '127mm ×4 · 800m/s', torpLabel: '533mm 3联装 ×2'
  },
  {
    key: 'lightning', name: '闪电', romaji: 'LIGHTNING', tag: 'DD · 驱逐舰', short: 'DD 闪电',
    desc: '机动均衡 · 引擎增压', kind: 'dd', len: 158, beam: 27,
    maxHp: 13200, knots: 44, turnR: 590, rudderShift: 3.8, accel: 30, turretRate: 2.5,
    turrets: [{ lx: -0.4, barrels: 1 }, { lx: -0.13, barrels: 1 }, { lx: 0.13, barrels: 1 }, { lx: 0.4, barrels: 1 }],
    reload: 4.9, he: 1900, ap: 2200, sigma: 13.5, range: K(8.4), vel: Math.round(900 * VS),
    torpTubes: 8, torpDmg: 12800, torpReload: 58, torpSpeed: TS(62), torpRange: K(8.5),
    specials: { smoke: true, boost: true }, prefer: 720,
    gunLabel: '120mm ×4 · 900m/s', torpLabel: '533mm 4联装 ×2'
  },
  /* ===== 巡洋舰：从机关炮到重炮慢射 ===== */
  {
    key: 'cleveland', name: '克利夫兰', romaji: 'CLEVELAND', tag: 'CL · 轻巡洋舰', short: 'CL 克利夫兰',
    desc: '超高射速 · 中距压制', kind: 'ca', len: 205, beam: 38,
    maxHp: 35200, knots: 33, turnR: 660, rudderShift: 6.8, accel: 21, turretRate: 2.2,
    turrets: [{ lx: -0.36, barrels: 3 }, { lx: -0.12, barrels: 3 }, { lx: 0.12, barrels: 3 }, { lx: 0.36, barrels: 3 }],
    reload: 5.2, he: 2200, ap: 3200, sigma: 15, range: K(14.2), vel: Math.round(812 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: {}, prefer: 1050,
    gunLabel: '152mm ×12 · 812m/s', torpLabel: '未装备'
  },
  {
    key: 'myoko', name: '妙高', romaji: 'MYŌKŌ', tag: 'CA · 重巡洋舰', short: 'CA 妙高',
    desc: '重炮慢射 · 远距重雷', kind: 'ca', len: 215, beam: 40,
    maxHp: 39600, knots: 35.5, turnR: 680, rudderShift: 8.4, accel: 16, turretRate: 1.25,
    turrets: [{ lx: -0.42, barrels: 2 }, { lx: -0.21, barrels: 2 }, { lx: 0, barrels: 2 }, { lx: 0.21, barrels: 2 }, { lx: 0.42, barrels: 2 }],
    reload: 13.5, he: 3300, ap: 4700, sigma: 19, range: K(15.2), vel: Math.round(840 * VS),
    torpTubes: 8, torpDmg: 15100, torpReload: 68, torpSpeed: TS(64), torpRange: K(10.5),
    specials: {}, prefer: 1200,
    gunLabel: '203mm ×10 · 840m/s', torpLabel: '610mm 4联装 ×2'
  },
  {
    key: 'atago', name: '爱宕', romaji: 'ATAGO', tag: 'CA · 重巡洋舰', short: 'CA 爱宕',
    desc: '重炮速射 · 一波重雷', kind: 'ca', len: 213, beam: 40,
    maxHp: 40100, knots: 38, turnR: 700, rudderShift: 9.2, accel: 17, turretRate: 1.5,
    turrets: [{ lx: -0.42, barrels: 2 }, { lx: -0.21, barrels: 2 }, { lx: 0, barrels: 2 }, { lx: 0.21, barrels: 2 }, { lx: 0.42, barrels: 2 }],
    reload: 10.5, he: 3400, ap: 4800, sigma: 17.5, range: K(15.8), vel: Math.round(840 * VS),
    torpTubes: 16, torpDmg: 17233, torpReload: 112, torpSpeed: TS(74), torpRange: K(9.5),
    specials: { smoke: true }, prefer: 1150,
    gunLabel: '203mm ×10 · 840m/s', torpLabel: '610mm 4联装 ×4'
  },
  /* ===== 战列舰：从最慢巨炮到高速速射 ===== */
  {
    key: 'nagato', name: '长门', romaji: 'NAGATO', tag: 'BB · 战列舰', short: 'BB 长门',
    desc: '巨炮 · 最慢节奏 · 超远射程', kind: 'bb', len: 250, beam: 50,
    maxHp: 65000, knots: 21, turnR: 770, rudderShift: 14.5, accel: 10, turretRate: 0.8,
    turrets: [{ lx: -0.4, barrels: 2 }, { lx: -0.13, barrels: 2 }, { lx: 0.13, barrels: 2 }, { lx: 0.4, barrels: 2 }],
    reload: 32, he: 6500, ap: 12600, sigma: 25, range: K(20.5), vel: Math.round(806 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: {}, prefer: 1500,
    gunLabel: '410mm ×8 · 806m/s', torpLabel: '未装备'
  },
  {
    key: 'bismarck', name: '俾斯麦', romaji: 'BISMARCK', tag: 'BB · 战列舰', short: 'BB 俾斯麦',
    desc: '高速战列 · 速射主炮 · 自动副炮', kind: 'bb', len: 268, beam: 52,
    maxHp: 69000, knots: 27.5, turnR: 740, rudderShift: 11.5, accel: 15, turretRate: 1.35,
    turrets: [{ lx: -0.4, barrels: 2 }, { lx: -0.13, barrels: 2 }, { lx: 0.13, barrels: 2 }, { lx: 0.4, barrels: 2 }],
    reload: 20.5, he: 5400, ap: 11300, sigma: 21.5, range: K(20), vel: Math.round(820 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: { secondary: true, secRange: K(3.5), secDmg: 520, secReload: 1.1 }, prefer: 1380,
    gunLabel: '380mm ×8 · 820m/s', torpLabel: '未装备'
  },
  {
    key: 'york', name: '约克公爵', romaji: 'YORK', tag: 'BB · 战列舰', short: 'BB 约克公爵',
    desc: '稳重齐射 · 高均质防护', kind: 'bb', len: 255, beam: 50,
    maxHp: 60500, knots: 24.5, turnR: 750, rudderShift: 13, accel: 12.5, turretRate: 1.0,
    turrets: [{ lx: -0.42, barrels: 4 }, { lx: 0, barrels: 2 }, { lx: 0.42, barrels: 4 }],
    reload: 26, he: 5100, ap: 11000, sigma: 23, range: K(19.2), vel: Math.round(757 * VS),
    torpTubes: 0, torpDmg: 0, torpReload: 0, torpSpeed: 0, torpRange: 0,
    specials: {}, prefer: 1450,
    gunLabel: '356mm ×10 · 757m/s', torpLabel: '未装备'
  }
];
// 每座鱼雷发射管的联装数：6 管 = 3 联装 ×2，8/16 管 = 4 联装 ×2/×4
var TORP_MOUNT = { 6: 3, 8: 4, 16: 4 };
// 派生字段：航速倍率 / 转向角速率 / 舵角响应 / 鱼雷齐射组数 / 隐蔽 / 起火率
PLAYER_SHIPS.forEach(function (d) {
  d.speedScale = SP(d.knots);
  d.maxTurn = TR(d.knots, d.turnR);
  d.rudderRate = RR(d.rudderShift);
  d.torpMount = d.torpDmg ? (TORP_MOUNT[d.torpTubes] || 3) : 0;   // 每组发射枚数
  d.torpSalvos = d.torpDmg ? Math.max(1, Math.round(d.torpTubes / d.torpMount)) : 0;  // 发射管座数（每座独立装填）
  d.torpKnots = d.torpDmg ? Math.round(d.torpSpeed / TORP_K) : 0; // 鱼雷节速（供卡片展示）
  d.concealKm = CONCEAL_KM[d.key] || 8;
  d.conceal = K(d.concealKm);
  d.fireChance = d.kind === 'dd' ? 0.30 : (d.kind === 'ca' ? 0.24 : 0.20);  // 每发 HE 的起火概率
});
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
  pace: 'slow',             // slow = 标准（基准 100%） | normal = 快速（500%，流速 5 倍）
  fleet: { ship: 'mutsuki', allies: 11, enemies: 12 },   // 默认编成 12v12（本舰 + 11 友军 vs 12 敌舰）
  spawnSeq: 0, nameSeq: 0,
  time: 0, realTime: 0, visTime: 0, endTimer: -1, win: false,
  ships: [], shells: [], torps: [], floats: [], reefs: [], clouds: [], smokes: [],
  spawnAnchor: [{ x: 0, y: 0 }, { x: 0, y: 0 }],   // 0=我方（西南）/ 1=敌方（东北），按双峰海峡原版对角出生
  detectTick: 0,                                     // 侦测解算节流（真实秒）
  particles: new IT.Particles(),
  sound: new IT.Sound(),
  voice: new IT.Voice(),
  commander: '大肥鱼',
  cam: { x: WORLD / 2, y: WORLD / 2 },
  zoom: 1, fitZoom: 0.04, tacticZoom: 0.8, maxZoom: 1.25, zoomLevel: 0, w: 0, h: 0, dpr: 1,
  nav: null,                               // 自动导航目的地（右键设置，抵达或手动操舵取消）
  spectate: null,                          // 本舰沉没后观战跟随的友舰（游戏继续，直到一方舰队全灭）
  shake: 0, hitFlash: 0, tipCd: 0,
  mouse: { sx: 0, sy: 0, wx: 0, wy: 0, has: false },
  keys: {}, heldFire: false, heldTorp: false, assist: false,
  stats: { shots: 0, hits: 0, damage: 0, kills: 0 },
  toastTimer: 0
};
window.G = G;   // 暴露为全局，供 engine.js 的 Sound/Voice 访问
// 音效听点 = 视角参照舰（本舰沉没后改为观战跟随的友舰）：按距离衰减并分左右声道
G.sound.setListener(function () {
  var v = viewRef();
  return v ? { x: v.x, y: v.y, ang: v.ang } : null;
});
// 调试/自动化测试钩子（零依赖，无副作用）
window.__game = { WORLD: WORLD, G: G, Ship: Ship, viewRef: viewRef, pickSpectateShip: pickSpectateShip, sinkShip: sinkShip, endBattle: endBattle, losBlocked: losBlocked, terrainHard: terrainHard, terrainAny: terrainAny, terrainBlockedLine: terrainBlockedLine, navPlanPath: navPlanPath, navLineClear: navLineClear, navMargin: navMargin, navRebuild: function () { navGrid = null; }, bigExplosion: bigExplosion, addShake: addShake, Shell: Shell, Torpedo: Torpedo, PACES: PACES, PLAYER_SHIPS: PLAYER_SHIPS, fireMain: fireMain, fireTorpedoes: fireTorpedoes, shellImpact: shellImpact, applyDamage: applyDamage, updateDetection: updateDetection, detectRange: detectRange, searchCentroid: searchCentroid, update: update, sound: G.sound };

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
  // 双方从西南/东北对角出发，本舰开局直接以最高车钟（极速 Ⅳ）随舰队接敌；
  // AI 舰起步 Ⅲ 档、由 updateAI 按距离自行调档，避免一开局全队同时飙到极速
  this.speed = 0; this.gear = isPlayer ? 4 : 3;
  this.rudder = 0; this.rudderTarget = 0;
  this.rudderRate = d.rudderRate || 2.6;
  this.vx = 0; this.vy = 0;
  this.ammo = 'he';               // 当前弹种：he / ap
  // 主炮按「炮塔」独立装填：turretReloads[i] = 每座剩余装填（游戏秒，0 = 就绪）
  // AI 舰开局留出接敌缓冲，各炮塔错开 → 出现自然的滚动射击
  this.turretReloads = [];
  for (var ti = 0; ti < d.turrets.length; ti++) {
    this.turretReloads.push(isPlayer ? 0 : paceSec(U.rand(8, 13) * (team === 1 ? P().enemyReload : 1)));
  }
  this.turretReloadMax = 1;
  // 鱼雷按「发射管座」独立装填：每座打完各自进长装填，互不影响
  this.torpMountReloads = [];
  if (d.torpDmg) { for (var tmi = 0; tmi < d.torpSalvos; tmi++) this.torpMountReloads.push(0); }
  this.torpReloadMax = 1;
  this.torpIdx = 0;                // 管座轮转序号：左右舷交替出管
  this.torpGap = 0;                // 座间发射短间隔（游戏秒：标准 0.75 真实秒 / 快速 0.15 真实秒）
  this.fire = 0; this.flood = 0; this.fireStacks = 0;  // 起火按真实秒计，最多 3 层
  // 隐蔽 / 侦测：spotted[0] = 已被我方（玩家一方）发现，spotted[1] = 已被敌方发现
  this.spotted = [false, false];
  this.concealNow = d.conceal; this.gunBloom = 0; this.inSmoke = false;
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
// 就绪炮塔数
Ship.prototype.gunReadyCount = function () {
  var n = 0;
  for (var i = 0; i < this.turretReloads.length; i++) if (this.turretReloads[i] <= 0) n++;
  return n;
};
// 下一座就绪炮塔（按舰艏 → 舰艉顺序），全在装填时返回 -1
Ship.prototype.firstReadyTurret = function () {
  for (var i = 0; i < this.turretReloads.length; i++) if (this.turretReloads[i] <= 0) return i;
  return -1;
};
// 就绪鱼雷管座数
Ship.prototype.torpReadyCount = function () {
  var n = 0;
  for (var i = 0; i < this.torpMountReloads.length; i++) if (this.torpMountReloads[i] <= 0) n++;
  return n;
};
Ship.prototype.setGear = function (g) {
  if (this.sunk) return;                 // 沉没舰不再响应车钟（观战时防止误触 / 语音播报）
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
  var rdt = dt / P().time;   // 真实时间步：状态伤害、开炮暴露、烟幕与操作响应都不随流速拖长
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
  // 状态伤害（按真实秒计：标准档下 15 秒就是 15 秒，不会拖成 75 秒）
  if (this.fire > 0) {
    this.fire = Math.max(0, this.fire - rdt);
    this.hp -= this.maxHp * 0.0045 * Math.max(1, this.fireStacks) * rdt;
    if (Math.random() < rdt * 22) G.particles.add({
      x: this.x + U.rand(-this.len * 0.3, this.len * 0.3), y: this.y + U.rand(-this.beam * 0.5, this.beam * 0.5),
      vx: U.rand(-14, 14), vy: U.rand(-46, -18), life: U.rand(0.5, 1.1), size: U.rand(3, 8),
      color: U.pick(['#ff9a3c', '#ffd070', '#ff6a30']), grow: 5, alpha: 0.85, type: 'flash'
    });
    if (Math.random() < rdt * 9) G.particles.add({
      x: this.x + U.rand(-this.len * 0.25, this.len * 0.25), y: this.y,
      vx: U.rand(-8, 8), vy: U.rand(-24, -8), life: U.rand(1.1, 2.0), size: U.rand(6, 13),
      color: '#3c4045', grow: 8, alpha: 0.5, type: 'smoke', drag: 0.97
    });
    if (this.fire <= 0) this.fireStacks = 0;
  }
  if (this.flood > 0) { this.flood = Math.max(0, this.flood - rdt); this.hp -= this.maxHp * 0.006 * rdt; }
  if (this.gunBloom > 0) this.gunBloom = Math.max(0, this.gunBloom - rdt);
  if (this.hp <= 0) { sinkShip(this); return; }

  // 舵 / 速度
  // 舵角与炮塔按真实时间响应，标准档下操作依旧跟手；船体位移与转向仍按缩放后的时间
  this.rudder = U.approach(this.rudder, this.rudderTarget, rdt * this.rudderRate);
  var targetSpeed = GEAR_SPEED[this.gear + 1] * this.def.speedScale
                    * (this.boostTime > 0 ? 1.22 : 1);   // 引擎增压期间极速提升
  // 车钟按真实时间加速，避免标准档下升档显得迟钝；实际位移仍按缩放时间
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

  // 炮塔 / 装填：每座炮塔、每座鱼雷发射管座独立倒计时（游戏秒）
  var gunReadyBefore = this.gunReadyCount(), gunTotal = this.turretReloads.length;
  for (var gi = 0; gi < gunTotal; gi++) {
    if (this.turretReloads[gi] > 0) this.turretReloads[gi] = Math.max(0, this.turretReloads[gi] - dt);
  }
  if (this.isPlayer && gunReadyBefore < gunTotal && this.gunReadyCount() === gunTotal) {
    if (G.voice) G.voice.say('reload_done');       // 全部炮塔就位 → 齐射可用
  }
  var torpReadyBefore = this.torpReadyCount(), torpTotal = this.torpMountReloads.length;
  for (var tri = 0; tri < torpTotal; tri++) {
    if (this.torpMountReloads[tri] > 0) this.torpMountReloads[tri] = Math.max(0, this.torpMountReloads[tri] - dt);
  }
  if (this.torpGap > 0) this.torpGap = Math.max(0, this.torpGap - dt);   // 座间发射间隔按游戏秒：随流速 5 倍加速
  if (this.isPlayer && this.def.torpDmg && torpReadyBefore < torpTotal && this.torpReadyCount() === torpTotal) {
    toast('鱼雷装填完毕 · ' + torpTotal + ' 座就位');   // 全部管座重新就位
  }
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
  // （reload_done 语音已按「全部炮塔就位」在装填块内触发）
  // 炮塔回转速度按舰型差异化（rad/s，真实时间）：DD 灵活、BB 笨重
  var tRate = this.def.turretRate || 2.4;
  for (var k = 0; k < this.turrets.length; k++) {
    var t = this.turrets[k];
    t.ang = U.norm(t.ang + U.clamp(U.angDiff(t.ang, t.target), -tRate * rdt, tRate * rdt));
  }
};

function Shell(sx, sy, tx, ty, dur, dmg, owner, aiOwned, he, fireChance) {
  this.sx = sx; this.sy = sy; this.tx = tx; this.ty = ty;
  this.x = sx; this.y = sy; this.px = sx; this.py = sy;
  this.t = 0; this.dur = dur; this.dmg = dmg; this.owner = owner; this.aiOwned = !!aiOwned;
  this.he = !!he;               // true = HE（橙黄，稳定伤害 + 起火），false = AP（青白，可击穿核心）
  this.fireChance = he ? (fireChance || 0.24) : 0;
  this.trail = [];              // 按弹种 / 阵营着色的飞行轨迹
  this.dist = U.dist(sx, sy, tx, ty);
  this.arc = this.dist * 0.13 + 16;
}
// 四色区分：我方 HE 琥珀 / 我方 AP 冰蓝 / 敌方 HE 橙红 / 敌方 AP 紫
function shellColor(sh) {
  if (sh.owner === 0) return { core: sh.he ? '#ffc35a' : '#a8edff',
                               glow: sh.he ? '#ff9b3c' : '#6fe3ff',
                               trail: sh.he ? '255,186,86' : '140,226,255' };
  return { core: sh.he ? '#ff9560' : '#e6bcff',
           glow: sh.he ? '#ff5a34' : '#c47aff',
           trail: sh.he ? '255,140,90' : '225,175,255' };
}
Shell.prototype.update = function (dt) {
  this.px = this.x; this.py = this.y;
  this.t += dt;
  var p = U.clamp(this.t / this.dur, 0, 1);
  this.x = U.lerp(this.sx, this.tx, p);
  this.y = U.lerp(this.sy, this.ty, p);
  this.trail.push({ x: this.x, y: this.drawY() });
  if (this.trail.length > 9) this.trail.shift();
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
    G.sound.splash({ x: this.x, y: this.y });
    return false;
  }
  if (this.tick > 0.06) {
    this.tick = 0;
    this.trail.push({ x: this.x, y: this.y, a: 1 });
    if (this.trail.length > 48) this.trail.shift();
    if (Math.random() < 0.7) G.particles.add({
      x: this.x, y: this.y, vx: U.rand(-8, 8), vy: U.rand(-8, 8), life: U.rand(0.4, 1.0),
      size: U.rand(1, 2.6),
      color: this.owner === 0 ? 'rgba(140,232,255,.8)' : 'rgba(255,120,90,.85)', drag: 0.9
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
      G.sound.explosion(true, { x: this.x, y: this.y });
      return false;
    }
  }
  return true;
};

/* ---------------- 战斗逻辑 ---------------- */
function shellDmg(s) { return s.ammo === 'ap' ? s.def.ap : s.def.he; }

function fireMain(s, aimX, aimY, salvo) {
  if (s.sunk) return false;
  // 每座炮塔独立装填：salvo=true 齐射全部就绪炮塔，否则按舰艏→舰艉只打第一座就绪的
  var list = [];
  if (salvo) {
    for (var si = 0; si < s.turretReloads.length; si++) if (s.turretReloads[si] <= 0) list.push(si);
  } else {
    var fi = s.firstReadyTurret();
    if (fi >= 0) list.push(fi);
  }
  if (!list.length) return false;
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
  var muzzleCol = he ? ['#fff0c0', '#ffc266', '#ff8a3c'] : ['#eafcff', '#9fe6ff', '#59c9f5'];
  for (var i = 0; i < list.length; i++) {
    var ti = list[i];
    var tw = s.turretWorld(ti), n = s.turrets[ti].barrels;
    barrels += n;
    for (var b = 0; b < n; b++) {
      var ox = tx + U.gauss() * sigma + U.rand(-sigma * 0.25, sigma * 0.25);
      var oy = ty + U.gauss() * sigma * 0.8;
      var sx = tw.x + Math.cos(tw.ang) * 8;
      var sy = tw.y + Math.sin(tw.ang) * 8;
      G.shells.push(new Shell(sx, sy, ox, oy, flight + U.rand(-0.035, 0.035),
                              dmg, s.team, !s.isPlayer, he, s.def.fireChance));
      G.particles.burst(sx, sy, { count: 5, angle: tw.ang, speedMin: 30, speedMax: 120,
        lifeMin: 0.15, lifeMax: 0.4, sizeMin: 2, sizeMax: 5,
        colors: muzzleCol, type: 'line', spread: 3 });
    }
    // 炮口焰：大口径更亮更大，颜色随弹种
    G.particles.add({ x: tw.x + Math.cos(tw.ang) * 10, y: tw.y + Math.sin(tw.ang) * 10,
      vx: 0, vy: 0, life: s.def.kind === 'bb' ? 0.22 : 0.14, size: s.def.kind === 'bb' ? 16 : 9,
      color: he ? '#ffe9b0' : '#d6f6ff', type: 'flash', grow: s.def.kind === 'bb' ? 60 : 34, alpha: 0.9 });
    // 该炮塔进独立装填
    s.turretReloadMax = s.def.reload * (s.team === 1 ? P().enemyReload : (s.isPlayer ? P().playerReload : 1));
    s.turretReloads[ti] = s.turretReloadMax;
  }
  s.muzzle = 0.16;
  s.gunBloom = Math.max(s.gunBloom, 20);   // 开炮后 20 真实秒内暴露位置（烟幕也藏不住）
  G.sound.gun(s.team === 0 ? 1 : 0.55, s.def.kind, s);
  if (s.isPlayer) {
    G.stats.shots += barrels;
    addShake((s.def.kind === 'bb' ? 3.4 : (s.def.kind === 'ca' ? 1.8 : 0.9)) * (salvo ? 1 : 0.45));   // 单炮塔后坐更轻
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
      ax, ay, flight + U.rand(-0.05, 0.05), sp.secDmg, s.team, !s.isPlayer, true, s.def.fireChance * 0.6));
  }
  G.particles.burst(s.x, s.y, { count: 10, speedMin: 20, speedMax: 90, lifeMin: 0.12, lifeMax: 0.3,
    sizeMin: 1.5, sizeMax: 3.5, colors: ['#ffe9b0', '#ffc266'], type: 'line', spread: 6 });
  s.secReload = 1 / sp.secReload;   // secReload = 每秒轮次
  G.sound.gun(s.team === 0 ? 0.32 : 0.22, 'dd', s);   // 副炮是小口径，传得近些
}

// 一次发射「一座」发射管：联装几枚就打几枚，左右舷交替出管。
// 还有余座时只进短间隔（可重新瞄准再打），全部打完才进整舰长装填。
function fireTorpedoes(s, aimAng) {
  if (!s.def.torpDmg || s.sunk || s.torpGap > 0) return false;
  var total = s.torpMountReloads.length;
  // 轮转选择下一座就绪的发射管座（左右舷交替出管），每座独立装填互不影响
  var mi = -1, readyBefore = s.torpReadyCount();
  for (var k = 1; k <= total; k++) {
    var cand = (s.torpIdx + k) % total;
    if (s.torpMountReloads[cand] <= 0) { mi = cand; break; }
  }
  if (mi < 0) return false;
  s.torpIdx = (mi + 1) % total;                   // 下次从下一座继续轮转
  var n = s.def.torpMount;
  var side = mi % 2 ? 1 : -1;                     // 左右舷交替
  var nx = -Math.sin(s.ang), ny = Math.cos(s.ang);
  for (var i = 0; i < n; i++) {
    var a = aimAng + (i - (n - 1) / 2) * 0.055;
    var ox = s.x + Math.cos(s.ang) * s.len * 0.1 + nx * side * s.beam * 0.32 + Math.cos(a) * 6;
    var oy = s.y + Math.sin(s.ang) * s.len * 0.1 + ny * side * s.beam * 0.32 + Math.sin(a) * 6;
    G.torps.push(new Torpedo(ox, oy, a, s.team, s.def.torpDmg, s.def.torpRange, s.def.torpSpeed, !s.isPlayer));
  }
  // 鱼雷发射不算开火：不设 gunBloom，不提升被侦测距离（与战舰世界原版一致）
  // 该管座进独立长装填；其余管座不受影响
  s.torpReloadMax = s.def.torpReload * (s.team === 1 ? P().enemyReload : (s.isPlayer ? P().playerReload : 1));
  s.torpMountReloads[mi] = s.torpReloadMax;
  s.torpGap = 0.15;                               // 座间发射间隔（游戏秒：标准 0.75 真实秒 / 快速 0.15 真实秒）
  G.sound.torpedo(s);
  if (s.isPlayer) {
    var readyAfter = s.torpReadyCount();
    toast('鱼雷发射 · ' + n + ' 枚 · 就绪 ' + readyAfter + '/' + total + ' 座');
    if (readyBefore === total && G.voice) G.voice.say('torpedo_fire');   // 满编首座发射时播报
    updateHUD(true);                                        // 管座就绪数立即刷新，不等节流
  }
  return true;
}

function shellImpact(sh) {
  var at = { x: sh.tx, y: sh.ty };
  // 落点在礁石/岛屿上 → 炸在地形上，对舰无伤害（高弹道可飞越障碍，但落点被拦截）
  var ter = terrainHard(sh.tx, sh.ty);
  if (ter) {
    bigExplosion(sh.tx, sh.ty, false, false);
    G.sound.explosion(false, at);
    return;
  }
  var hit = null, core = false;
  for (var i = 0; i < G.ships.length; i++) {
    var s = G.ships[i];
    if (s.sunk || s.team === sh.owner) continue;
    var l = U.toLocal(sh.tx, sh.ty, s.x, s.y, s.ang);
    if (Math.abs(l.x) < s.len * 0.54 && Math.abs(l.y) < s.beam * 0.5 + 7) {
      hit = s;
      core = Math.abs(l.x) < s.len * 0.21 && Math.abs(l.y) < s.beam * 0.55;
      break;
    }
  }
  if (hit) {
    // 弹种分工：AP 才能击穿核心区（×2），打轻甲驱逐舰容易过穿；
    //           HE 永不暴击、伤害稳定，但每发都有起火概率。
    var ap = !sh.he;
    var crit = ap && core;
    var overPen = ap && !core && hit.def.kind === 'dd';
    var dmg = sh.dmg * (crit ? 2 : (overPen ? 0.35 : 1));
    applyDamage(hit, dmg, 'shell', sh.owner, crit, sh.aiOwned, sh.he,
                { label: crit ? '核心区' : (overPen ? '过穿' : (sh.he && core ? 'HE 未击穿' : '')),
                  fireChance: sh.fireChance });
    var pal = sh.he ? ['#ffd9a0', '#ff8a4c', '#ffb24d'] : ['#eafcff', '#9fe6ff', '#ffd45e'];
    G.particles.burst(sh.tx, sh.ty, { count: crit ? 22 : 13, speedMin: 30, speedMax: 150,
      lifeMin: 0.3, lifeMax: 0.8, sizeMin: 2, sizeMax: 6,
      colors: crit ? ['#fff3c0', '#ff9b3c', '#ff5a2c'] : pal });
    G.sound.explosion(crit, at);
    G.sound.hit(crit, at);
    if (sh.owner === 0 && !sh.aiOwned) {
      G.stats.hits++;
      if (G.voice) G.voice.say('enemy_hit', 900);
    }
    bigExplosion(sh.tx, sh.ty, false, crit);
  } else {
    // 近失弹 → 水柱；落水声按「落点到本舰的距离」衰减，远处只剩闷响
    splash(sh.tx, sh.ty, 1);
    G.sound.splash(at);
  }
}

// 距离衰减的镜头震动：远处的爆炸/沉没不再晃屏
function addShake(v, x, y) {
  var ref = viewRef();
  if (x == null || !ref) { G.shake = Math.min(G.shake + v, 18); return; }
  var d = U.dist(ref.x, ref.y, x, y);
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

// 点燃：15 真实秒持续掉血，最多叠 3 层；有明显的火焰 / 浓烟 / 飘字 / 提示
function ignite(s, source) {
  if (s.sunk) return;
  s.fire = Math.max(s.fire, 15);
  s.fireStacks = Math.min(3, (s.fireStacks || 0) + 1);
  G.floats.push({ x: s.x + U.rand(-16, 16), y: s.y - 34, text: '起火！', life: 1.6,
    color: '#ff9b3c', crit: false, label: 'FIRE', vy: -16 });
  G.particles.burst(s.x, s.y, { count: 14, speedMin: 20, speedMax: 110, lifeMin: 0.4, lifeMax: 1.0,
    sizeMin: 3, sizeMax: 8, colors: ['#fff0b0', '#ff9a3c', '#ff5522'], grow: 4 });
  if (s.isPlayer) toast('本舰起火 · 持续损血');
  else if (source === 0 && s.team === 1) toast('敌舰「' + s.name + '」起火 · 持续伤害');
}
function applyDamage(s, dmg, type, source, crit, aiOwned, he, opts) {
  if (s.sunk) return;
  opts = opts || {};
  // 玩家享受节奏补偿加成，敌方被削弱，友军 AI 用基础伤害；只统计玩家造成的伤害
  var mul = source === 1 ? P().enemyDmg : (aiOwned ? 1 : P().playerDmg);
  var actual = Math.round(dmg * mul);
  s.hp -= actual;
  if (source === 0 && !aiOwned) G.stats.damage += actual;
  G.floats.push({ x: s.x + U.rand(-14, 14), y: s.y - 16, text: '-' + U.fmt(actual), life: 1.15,
    color: crit ? '#ffd45e' : (s.team === 0 ? '#ff7a6a' : '#c9f4ff'), crit: !!crit,
    label: opts.label != null ? opts.label : (crit ? '核心区' : ''), vy: -22 });
  // 只有 HE 能点火，概率取自发射舰的口径；AP 完全没有起火效果
  if (type === 'shell' && he && opts.fireChance && Math.random() < opts.fireChance) ignite(s, source);
  if (type === 'torp') { s.flood = Math.max(s.flood, 11); ignite(s, source); }
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
  G.sound.sink(s);
  addShake(9, s.x, s.y);
  if (s.team === 1) {
    G.stats.kills++;
    toast('敌舰「' + s.name + '」已被击沉');
    feed('击沉 <span>' + s.short + '</span>');
    if (G.voice) G.voice.say('enemy_sunk');
  } else if (s.isPlayer) {
    // 本舰沉没 ≠ 战斗结束：转入观战，友军 AI 继续作战，直到一方舰队全灭才结算
    if (G.voice) G.voice.say('ship_sink');
    G.nav = null; G.heldFire = false; G.heldTorp = false;
    G.spectate = pickSpectateShip();
    toast(G.spectate ? '本舰已沉没 · 观战继续 · 跟随友舰「' + G.spectate.name + '」' : '本舰已沉没 · 战斗继续');
    feed('本舰沉没 <span style="color:#ff8a75">转入观战</span>');
  } else {
    toast('友舰「' + s.name + '」已沉没');
    feed('损失 <span style="color:#ff8a75">' + s.short + '</span>');
  }
  // 胜负只看舰队全灭：本舰沉没不中断战斗，敌舰全灭仍然判胜
  var foes = 0, friends = 0;
  for (var si = 0; si < G.ships.length; si++) {
    var sh = G.ships[si];
    if (sh.sunk) continue;
    if (sh.team === 1) foes++; else friends++;
  }
  if (foes === 0) { G.win = true; endBattle(true); }
  else if (friends === 0) { G.win = false; endBattle(false); }
}

function endBattle(win) {
  if (G.state === 'over') return;
  G.state = 'over';
  G.endTimer = 2.8;   // 真实秒：留时间看完沉没动画
  G.win = win;
  var sunk = G.player && G.player.sunk;
  toast(win ? (sunk ? '友军清场 · 战斗胜利（本舰已沉没）' : '战斗胜利 · 敌方舰队全灭') : '我方舰队全灭');
  if (G.voice) {
    if (win) G.voice.say('victory');
    else setTimeout(function () { if (G.voice) G.voice.say('defeat'); }, 1200);
  }
}

/* ---------------- 隐蔽 / 侦测 ----------------
   每舰有独立的被侦测距离 conceal（DD 最小、BB 最大），并受以下因素修正：
     · 开炮暴露 gunBloom：开火后 20 真实秒内被侦测距离至少 12km（烟中也藏不住）
     · 烟幕 inSmoke：未开炮时缩到「保证发现距离」，且烟团会阻断观察视线
     · 岛礁：tier2 岛屿完全阻断视线；贴近礁石/岛屿时额外 −18%
     · 起火：被侦测距离 +1.5km；高速航行略微更易暴露
   spotted[0] = 已被我方（玩家一方）发现，spotted[1] = 已被敌方发现。
   只有「被发现」的目标才会进入 AI 锁定、火控解算、视野与雷达。
-------------------------------------------------- */
var ASSURED = K(2.2);            // 保证发现距离：再好的隐蔽，贴到 2.2km 内也会暴露
function inSmoke(s) {
  if (s.smokeTime > 0) return true;   // 正在拉烟，舰体本身就算在烟里
  for (var i = 0; i < G.smokes.length; i++) {
    var p = G.smokes[i];
    if (p.life > 0 && U.dist(s.x, s.y, p.x, p.y) < p.r * 0.95) return true;
  }
  return false;
}
function terrainCover(s) {
  for (var i = 0; i < G.reefs.length; i++) {
    var r = G.reefs[i];
    if (r.tier > 0 && U.dist(s.x, s.y, r.x, r.y) < r.r * 1.7) return true;
  }
  return false;
}
// 观察线是否穿过烟团（带包围盒预筛，避免每帧全量两两计算）
function smokeBlocked(x1, y1, x2, y2) {
  if (!G.smokes.length) return false;
  var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  var minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  var minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  for (var i = 0; i < G.smokes.length; i++) {
    var p = G.smokes[i];
    if (p.life <= 0 || p.x + p.r < minX || p.x - p.r > maxX ||
        p.y + p.r < minY || p.y - p.r > maxY) continue;
    var t = L2 > 0 ? U.clamp(((p.x - x1) * dx + (p.y - y1) * dy) / L2, 0, 1) : 0;
    if (U.dist(x1 + dx * t, y1 + dy * t, p.x, p.y) < p.r * 0.72) return true;
  }
  return false;
}
function detectRange(s) {
  var r = s.def.conceal;
  if (s.fire > 0) r += K(1.5);
  r *= 1 + U.clamp(Math.abs(s.speed) / 160, 0, 1) * 0.08;
  if (s.gunBloom > 0) return Math.max(r * 1.55, K(12));
  if (terrainCover(s)) r *= 0.82;
  if (s.inSmoke) r = Math.min(r, ASSURED + K(0.6));
  return r;
}
function updateDetection() {
  var ships = G.ships, i, j;
  for (i = 0; i < ships.length; i++) {
    var s = ships[i];
    s.spotted[0] = false; s.spotted[1] = false;
    s.inSmoke = inSmoke(s);
    s.concealNow = s.sunk ? 0 : detectRange(s);
  }
  for (j = 0; j < ships.length; j++) {
    var t = ships[j];
    if (t.sunk) continue;
    for (i = 0; i < ships.length; i++) {
      var o = ships[i];
      if (o.sunk || o.team === t.team || t.spotted[o.team]) continue;
      var d = U.dist(o.x, o.y, t.x, t.y);
      if (d > t.concealNow) continue;
      if (d > ASSURED && (losBlocked(o.x, o.y, t.x, t.y) || smokeBlocked(o.x, o.y, t.x, t.y))) continue;
      t.spotted[o.team] = true;
    }
  }
}
// 舰队侦察通报：未发现目标时 AI 朝敌舰队大致方位搜索前进，保证双方会接战
function searchCentroid(team) {
  var sx = 0, sy = 0, n = 0;
  for (var i = 0; i < G.ships.length; i++) {
    var s = G.ships[i];
    if (s.sunk || s.team === team) continue;
    sx += s.x; sy += s.y; n++;
  }
  return n ? { x: sx / n, y: sy / n, count: n } : null;
}
// 观战参照舰：本舰在世就跟随本舰；沉没后跟随一艘仍在战斗的友舰（优先离敌舰队最近的），
// 该舰再沉则自动换下一艘，镜头 / 雷达 / 震动 / 音效都以此舰为基准，战斗不中断
function pickSpectateShip() {
  var c = searchCentroid(0), best = null, bd = Infinity;
  for (var i = 0; i < G.ships.length; i++) {
    var s = G.ships[i];
    if (s.sunk || s.team !== 0 || s.isPlayer) continue;
    var d = c ? U.dist(s.x, s.y, c.x, c.y) : 0;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function viewRef() {
  if (G.player && !G.player.sunk) return G.player;
  if (G.spectate && !G.spectate.sunk) return G.spectate;
  G.spectate = pickSpectateShip();
  return G.spectate || G.player;
}
// 由相对位移给出八方位中文词（用于开局提示敌方所在方向）
function dirWord(dx, dy) {
  var a = Math.atan2(dx, -dy);   // 0=北, π/2=东
  var names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  var idx = Math.round(a / (U.TAU / 8));
  return names[((idx % 8) + 8) % 8];
}

/* ---------------- 舰艇 AI（敌我通用） ---------------- */
// 找最近的「已被本方发现」的敌对舰；岛后与烟中目标不参与锁定
function findTarget(s) {
  var best = null, bd = Infinity;
  for (var i = 0; i < G.ships.length; i++) {
    var o = G.ships[i];
    if (o.sunk || o.team === s.team || !o.spotted[s.team]) continue;
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
  // 未发现目标：按舰队侦察通报朝敌方大致方位搜索接敌（不会原地打转）
  var search = p ? null : searchCentroid(s.team);
  if (!p && !search) { s.rudderTarget = 0; return; }
  var tx = p ? p.x : search.x, ty = p ? p.y : search.y;
  var dx = tx - s.x, dy = ty - s.y;
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

  // 主炮开火（必须有已发现的目标，AI 不盲射）：齐射全部就绪炮塔
  if (p && s.gunReadyCount() > 0 && d < s.def.range && Math.abs(U.angDiff(s.turrets[0].ang, rel)) < 0.55) {
    var flight = d / s.def.vel;
    var err = (s.def.kind === 'bb' ? 145 : (s.def.kind === 'ca' ? 110 : 85))
              * (s.team === 1 ? P().enemyLead : 1.15);
    var ax = p.x + p.vx * flight + U.gauss() * err;
    var ay = p.y + p.vy * flight + U.gauss() * err;
    fireMain(s, ax, ay, true);
  }
  // 自动副炮（俾斯麦）：射程内持续输出
  if (p && s.def.specials.secondary && d < s.def.specials.secRange && s.secReload <= 0) {
    fireSecondary(s, p);
  }
  // 鱼雷：任一管座就绪即可发射（每座独立装填，打完的座自行装填）
  s.ai.torpCd -= dt;
  if (p && s.def.torpDmg && s.torpGap <= 0 && s.torpReadyCount() > 0 && s.ai.torpCd <= 0 &&
      d < s.def.torpRange * 0.7 && d > 260 && Math.abs(diff) < 1.2) {
    var tf = d / (s.def.torpSpeed * P().torpSpeed);
    var tAng = Math.atan2(p.y + p.vy * tf - s.y, p.x + p.vx * tf - s.x);
    var fullBattery = s.torpReadyCount() === s.torpMountReloads.length;
    if (fireTorpedoes(s, tAng)) {
      // 还有就绪管座 → 分批补射；全部进装填 → 恢复常规长间隔
      s.ai.torpCd = paceSec(s.torpReadyCount() > 0 ? U.rand(6, 9)
                                                   : U.rand(13, 20) * (s.team === 1 ? P().aiTorpCd : 1));
      if (s.team === 1 && fullBattery) toast('警告 · 敌方鱼雷发射');
    }
  }
  // AI 烟雾：残血且被盯上时拉烟撤退
  if (p && s.def.specials.smoke && s.smokeCd <= 0 && s.hp / s.maxHp < s.ai.smokeAt) {
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
// 本舰仍可操控（沉没后进入观战：视角 / 节奏 / 编成 / 暂停仍可用，操舰与武器输入全部禁用）
function playerActive() {
  return G.state === 'play' && !G.paused && !!G.player && !G.player.sunk;
}
// 舵令语音节流：同一方向不重复播报，且任意舵令之间至少间隔 2.5s，避免频繁刷屏
var _lastRudderDir = 0, _lastRudderSpeakT = 0;
// 根据当前按住的方向键同步舵角（A/D 与左右方向键）
function syncRudder() {
  if (!G.player || G.player.sunk) return;
  var left = !!(G.keys['a'] || G.keys['arrowleft']);
  var right = !!(G.keys['d'] || G.keys['arrowright']);
  var t = left === right ? 0 : (left ? -1 : 1);
  if (t !== 0 && G.nav) { G.nav = null; toast('已转为手动操舵 · 自动导航取消'); }   // 手动操舵优先于自动导航
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
// 玩家开火：salvo=true 齐射全部就绪炮塔；单击默认按舰艏→舰艉打第一座就绪的
function playerFire(salvo) {
  if (!playerActive()) return;
  if (G.assist && !nearestTarget(true)) {
    if (G.tipCd <= 0) { toast('目标超出射程 · 请接敌'); G.tipCd = 3; }
    return;
  }
  fireMain(G.player, G.mouse.wx, G.mouse.wy, salvo);
}
// 左键连击检测：320ms 内再次点击 = 全部主炮齐射，否则单击逐门发射
function clickFire() {
  var now = performance.now();
  var dbl = now - (G.lastGunClick || 0) < 320;
  G.lastGunClick = now;
  playerFire(dbl);
}
function playerTorp() { if (playerActive()) fireTorpedoes(G.player, aimAngle()); }
// 弹种切换 HE ↔ AP
function playerAmmo() {
  if (!playerActive()) return;
  var p = G.player;
  p.ammo = p.ammo === 'ap' ? 'he' : 'ap';
  var ap = p.ammo === 'ap';
  toast(ap ? 'AP 穿甲弹 · 核心区 ×2（对驱逐舰易过穿）' : 'HE 高爆弹 · 稳定伤害 + 高概率起火');
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
    if (k === 'g') { toggleView(); return; }
    // 本舰沉没 → 观战：仍可切视角、暂停、调音效 / 语音、改节奏（T）与编成（C，前面已处理）
    if (G.player && G.player.sunk) {
      if (k === 'p' || k === 'escape') {
        if (!$('overlayFleet').classList.contains('hidden')) closeFleet(); else togglePause();
      } else if (k === 'm') toggleSound();
      else if (k === 'v') toggleVoice();
      return;
    }
    if (k === 'a' || k === 'arrowleft' || k === 'd' || k === 'arrowright') syncRudder();
    else if (k === 'w' || k === 'arrowup') G.player.setGear(G.player.gear + 1);
    else if (k === 's' || k === 'arrowdown') G.player.setGear(G.player.gear - 1);
    else if (k === 'q') { G.player.rudderTarget = 0; }
    else if (k === 'e') { G.player.setGear(1); }
    else if (k === ' ' ) playerFire();
    else if (k === 'f') { G.heldTorp = true; playerTorp(); }
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
    if (k === 'f') G.heldTorp = false;
    if (k === 'a' || k === 'arrowleft' || k === 'd' || k === 'arrowright') syncRudder();
  });
  window.addEventListener('blur', function () { G.keys = {}; if (G.player) G.player.rudderTarget = 0; G.heldFire = false; G.heldTorp = false; });

  canvas.addEventListener('mousemove', function (e) {
    var r = canvas.getBoundingClientRect();
    G.mouse.sx = e.clientX - r.left; G.mouse.sy = e.clientY - r.top; G.mouse.has = true;
  });
  canvas.addEventListener('mousedown', function (e) {
    if (e.button === 0) { clickFire(); return; }
    if (e.button === 2) {
      // 右键：设置自动导航目的地（A* 避障寻路；再次右键可改点；手动操舵 / 抵达后取消）
      if (!playerActive()) return;
      var w = screenToWorld(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
      var dest = { x: U.clamp(w.x, 0, WORLD), y: U.clamp(w.y, 0, WORLD) };
      var path = navPlanPath(G.player.x, G.player.y, dest.x, dest.y);
      if (!path) {
        toast('目的地被岛群封死 · 无法导航');
        G.sound.ui(false);
        return;
      }
      G.nav = { x: dest.x, y: dest.y, path: path, wp: 0, min: null, replan: 2.5 };
      var via = path.length > 2 ? '（绕岛航线 ' + (path.length - 1) + ' 段）' : '（直线可达）';
      toast('自动导航 · 航向 ' + dirWord(dest.x - G.player.x, dest.y - G.player.y) + ' ' +
            (U.dist(G.player.x, G.player.y, dest.x, dest.y) / KM2U).toFixed(1) + ' km ' + via);
      G.sound.ui(true);
      return;
    }
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    // 向下滚 = 拉远，到 0 就是整张海图；向上滚 = 推进到战术细节
    G.zoomLevel = U.clamp(G.zoomLevel + (e.deltaY > 0 ? -0.075 : 0.075), 0, 1);
    applyZoom();
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
    if (performance.now() - tapStart.t < 260 && tapStart.moved < 14) clickFire();   // 双击连点 = 齐射
    tapStart = null;
  });

  // 车钟按钮
  Array.prototype.forEach.call(document.querySelectorAll('#throttle button'), function (b) {
    b.addEventListener('click', function () { if (G.player && !G.player.sunk) G.player.setGear(parseInt(b.dataset.gear, 10)); });
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
  $('btnView').addEventListener('click', toggleView);
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
  fb.addEventListener('pointerdown', function () { G.heldFire = true; clickFire(); });
  fb.addEventListener('pointerup', function () { G.heldFire = false; });
  fb.addEventListener('pointercancel', function () { G.heldFire = false; });
  var tb = $('btnTorpTouch');
  tb.addEventListener('pointerdown', function () { G.heldTorp = true; playerTorp(); });
  tb.addEventListener('pointerup', function () { G.heldTorp = false; });
  tb.addEventListener('pointercancel', function () { G.heldTorp = false; });
  // 阻止触控控件冒泡到 canvas
  $('touch').addEventListener('pointerdown', function (e) { e.stopPropagation(); });
}

// 节奏档的真实倍率：以标准档为基准 100%（快速档流速是其 5 倍 → 500%）
function pacePercent(pace) { return Math.round(PACES[pace].time / PACES.slow.time * 100); }
function setPace(v) {
  var prev = P().playerHp;
  G.pace = v === 'normal' ? 'normal' : 'slow';
  var cfg = P();
  var b = $('btnPace');
  var nextLabel = G.pace === 'slow' ? PACES.normal.label : PACES.slow.label;
  b.textContent = cfg.short;
  b.title = '战斗节奏：' + cfg.label + '（' + pacePercent(G.pace) + '% 流速）→ 点此切到' + nextLabel + ' / T';
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
  toast('战斗节奏 · ' + P().label + '（时间流速 ' + pacePercent(G.pace) + '%，航速与装填同步 ×' + (pacePercent(G.pace) / 100) + '）');
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
    ? '<div><kbd>W</kbd><kbd>S</kbd> 车钟（倒车 / 停车 / Ⅰ~Ⅳ，开局默认 Ⅳ 极速）· <kbd>A</kbd><kbd>D</kbd> 转舵 · <kbd>Q</kbd> 回中 · <kbd>E</kbd> 急停</div>' +
      '<div><kbd>鼠标</kbd> 瞄准 · <kbd>左键</kbd> 单击逐门 / <span style="color:#ffd27a">双击齐射</span> · <kbd>F</kbd> 鱼雷（逐座发射、每座独立装填，按住连发）</div>' +
      '<div><kbd>R</kbd> HE/AP · <kbd>Z</kbd> 烟幕 · <kbd>B</kbd> 增压 · <kbd>X</kbd> 辅助 · <kbd>C</kbd> 编成</div>' +
      '<div><kbd>T</kbd> 节奏 · <kbd>G</kbd> 视角（全图→广域→战术）· <kbd>滚轮</kbd> 连续缩放 · <kbd>右键</kbd> 自动导航 · <kbd>M</kbd> 音效 · <kbd>V</kbd> 语音 · <kbd>P</kbd> 暂停</div>' +
      '<div style="margin-top:7px;color:#ffc46b">AP 冰蓝：唯一能击穿核心区 ×2，打驱逐舰「过穿」只剩 35% 伤害；HE 琥珀：永不暴击但伤害稳定，每发有概率点燃（15 秒持续损血，最多 3 层）。敌方炮弹为橙红 / 紫。</div>' +
      '<div style="color:#8fd8ea">我方鱼雷与航迹青蓝、敌方橙红带警示环；武器栏与雷达下方都有四色图例。</div>' +
      '<div style="color:#9df5bd">隐蔽：每舰有独立被侦测距离（HUD「隐蔽」）。开炮暴露 20 秒，烟幕 / 岛后可缩小范围，起火 / 高速更显眼。未发现的敌舰不进视野、雷达与火控，只显示大致方位；绿色虚线圈是本舰隐蔽圈，变红即已被发现。</div>' +
      '<div style="color:#7dffa8">炮弹有飞行时间，压住绿色提前量标记开火；红色虚线圈是敌方落点预警。标准档 100% 流速，按 <kbd>T</kbd> 切 500% 快速档。</div>' +
      '<div style="color:#8fd8ea">复刻双峰海峡（Two Brothers）：双方各 12 舰在西南 / 东北对角出生，中央「兄弟岛」夹出一条可直穿的窄水道，东西两侧岛群是主战线；战列靠后外线、巡洋居中、驱逐走侧翼。相距约 70 km、超出所有主炮射程。12 艘战舰的航速、装填、炮塔转速、隐蔽各不相同。</div>' +
      '<div style="color:#8fd8ea">岛屿以等高线海图呈现：由岸到峰分层设色、数字为标高，最外虚线是水下等深线；礁石 / 岛屿阻挡航线、炮弹与视线，浅滩拖底；炮声与落水声按距离衰减并分左右声道。默认广域视野（全图 ×2.5），<kbd>G</kbd> 在全图 / 广域 / 战术间切换、<kbd>滚轮</kbd> 连续缩放，镜头始终跟随本舰，<kbd>右键</kbd> 设置自动导航。<b style="color:#ffc46b">本舰沉没后战斗不结束</b>：自动转入观战、镜头改跟随仍在作战的友舰，直到一方舰队全灭才结算。</div>'
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

/* ---------------- 海上景物：等高线海图 ----------------
   岛屿 / 礁石 / 浅滩统一用「地形图等高线」表现：
   一组确定性生成、平滑闭合的嵌套等值线，由岸到峰分层设色，
   配高程注记、坡面晕渲与拍岸碎浪；岸线半径 ≈ 实际硬碰撞 0.9r。
------------------------------------------------------------- */
// 分层设色：低饱和墨绿 / 青灰，贴合深色海军战术 HUD（数组长度 = 各档层数）
var CONTOUR_TINTS = [
  ['rgba(52,142,138,.055)', 'rgba(60,156,146,.075)', 'rgba(70,170,152,.09)', 'rgba(82,182,160,.11)'],
  ['#1b454e', '#23545a', '#2c6262', '#3b716d', '#4d8579'],
  ['#204a43', '#275847', '#30684d', '#3c7852', '#4c8858', '#629960', '#7eaa6f', '#a6bd84']
];
var CONTOUR_LINES = [
  ['rgba(146,224,208,.30)', 'rgba(156,230,212,.34)', 'rgba(168,234,214,.38)', 'rgba(180,238,216,.42)'],
  ['rgba(152,228,222,.58)', 'rgba(172,234,216,.54)', 'rgba(192,238,208,.52)', 'rgba(208,240,200,.52)', 'rgba(222,244,208,.58)'],
  ['rgba(178,240,216,.66)', 'rgba(192,238,208,.56)', 'rgba(206,240,200,.54)', 'rgba(218,242,192,.52)',
   'rgba(228,244,186,.52)', 'rgba(236,246,186,.54)', 'rgba(242,248,196,.56)', 'rgba(250,252,218,.72)']
];
// 生成一座礁体的嵌套等值线：低频谐波决定岛形，各层共用 → 自然同心不交叉；
// 每层再加独立高频起伏与山脊偏移，避免「一圈圈规整椭圆」的塑料感。
function genContours(R, tier, seed) {
  var rng = mulberry32((seed ^ 0x5f3759df) >>> 0);
  var n = tier === 2 ? 8 : (tier === 1 ? 5 : 4);
  var N = tier === 2 ? 84 : 64;
  var harm = [];
  for (var h = 0; h < 6; h++) {
    harm.push({ k: 2 + h, amp: (0.062 / (1 + h * 0.8)) * (0.7 + rng() * 0.6), ph: rng() * U.TAU });
  }
  // 不再整体压成椭圆：碰撞判定是 r*0.9 的正圆，岸线也保持近圆，
  // 形状的不规则完全交给谐波，避免「明明没碰到岛却搁浅」
  var squash = 0.97 + rng() * 0.03;
  var rot = 0.12 + rng() * 0.62, cr = Math.cos(rot), sr = Math.sin(rot);
  var dx = (rng() * 2 - 1) * 0.13 * R, dy = (rng() * 2 - 1) * 0.11 * R;
  var levels = [];
  for (var i = 0; i < n; i++) {
    var f = i / (n - 1), warp = rng() * U.TAU;
    // tier 0 是水下等深线（可通航）；tier>=1 岸线 0.90R = 硬碰撞 0.9R，峰顶 0.18R
    var base = tier === 0 ? (1.12 - f * 0.58) : (0.90 - f * 0.72);
    var pts = [];
    for (var j = 0; j < N; j++) {
      var a = j / N * U.TAU, rad = 1;
      for (var h2 = 0; h2 < harm.length; h2++) {
        rad += harm[h2].amp * Math.sin(harm[h2].k * a + harm[h2].ph + f * h2 * 0.22);
      }
      rad += (0.022 + f * 0.030) * Math.sin(7 * a + warp) +
             (0.014 + f * 0.020) * Math.sin(11 * a - warp * 1.3);
      rad = U.clamp(rad, 0.82, 1.12);
      var rx = Math.cos(a) * base * rad * R, ry = Math.sin(a) * base * rad * R * squash;
      pts.push([rx * cr - ry * sr + dx * f, rx * sr + ry * cr + dy * f]);
    }
    levels.push({
      pts: pts,
      elev: tier === 2 ? (i + 1) * 100 : (tier === 1 ? (i + 1) * 50 : -(n - i) * 5),
      major: i % 2 === 0
    });
  }
  return { levels: levels, px: dx, py: dy };
}
/* ---------------- 地图：双峰海峡（Two Brothers）----------------
   按战舰世界原版 42×42km 双峰海峡还原：
   · 中央两座大岛（「兄弟岛」）几乎相触，中间夹出一条沿出生对角线的窄窄中央水道——
     可冒险直穿抢点（原版标志玩法），两岛阻断视线，水道内极易被伏击；
   · 东、西两侧各有一组岛群，是主力舰队的接舷战线与巡洋/驱逐的掩体；
   · 北、南散布中小岛屿填充战场，避免大片空白水域。
   出生点：我方西南、敌方东北对角（原版 Standard Battle 布局）。
   坐标系：以世界中心 cx,cy 为原点，下面列表用相对偏移 (dx,dy,r,tier,tall,zone) 描述。
   礁体细节用 mulberry32 种子随机生成，保证每次开局地图完全一致。
------------------------------------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeReef(x, y, r, tier, seed, tall, zone) {
  return { x: x, y: y, r: r, tier: tier, zone: zone || 0, peak: !!tall,
    contours: genContours(r, tier, seed), ph: (seed % 997) / 997 * U.TAU };
}
function makeScenery() {
  var cx = WORLD / 2, cy = WORLD / 2, reefs = [], clouds = [];
  // (dx, dy, r, tier, tall, zone) —— 相对世界中心；tall 画峰标；zone: 0=中央兄弟岛 1=侧翼岛群 2=外围点缀岛
  var L = [];
  // 中央「双峰 / 兄弟岛」（zone 0）：两座大岛沿西北-东南错开，几乎相触；
  // 边缘间隙 ≈ 830u 就是原版的中央水道——沿西南-东北对角线直穿双方出生点
  L.push([-960, -960, 940, 2, 1, 0], [960, 960, 940, 2, 1, 0]);
  // 水道两口的浅滩：暗示入口位置、限制驱逐舰全速抢中时的走位（可通过不碰撞）
  L.push([-2100, 2400, 300, 0, 0, 0], [2100, -2400, 300, 0, 0, 0]);
  // 西侧岛群（zone 1）：原版主战线——1 大岛 + 卫星礁，提供战列线掩体与鱼雷伏击位
  L.push([-3700, -500, 620, 2, 0, 1], [-4300, 700, 470, 1, 0, 1],
         [-3050, 950, 370, 1, 0, 1], [-3500, -1650, 340, 0, 0, 1]);
  // 东侧岛群（zone 1）：与西侧点对称（绕地图中心旋转 180°），保证公平
  L.push([3700, 500, 620, 2, 0, 1], [4300, -700, 470, 1, 0, 1],
         [3050, -950, 370, 1, 0, 1], [3500, 1650, 340, 0, 0, 1]);
  // 北 / 南散布岛（zone 2）：填充战场、遮挡视野，避免大片空白水域
  L.push([0, 5600, 520, 1, 0, 2], [0, -5600, 520, 1, 0, 2]);
  L.push([2600, 5100, 360, 0, 0, 2], [-2600, -5100, 360, 0, 0, 2]);
  L.push([-1800, 4300, 470, 1, 0, 2], [1800, -4300, 470, 1, 0, 2]);
  L.push([-5200, 2300, 400, 1, 0, 2], [5200, -2300, 400, 1, 0, 2]);
  L.push([-5400, -2300, 330, 0, 0, 2], [5400, 2300, 330, 0, 0, 2]);
  L.push([3300, 3400, 380, 1, 0, 2], [-3300, -3400, 380, 1, 0, 2]);
  for (var i = 0; i < L.length; i++) {
    var e = L[i];
    // e[4] = tall → makeReef 里转成 peak（画主峰三角与标高）
    reefs.push(makeReef(cx + e[0], cy + e[1], e[2], e[3], 1009 + i * 7919, e[4], e[5]));
  }
  // 云影以镜头为锚循环漂移，保证任意位置都能看到柔和的光影变化
  for (var c = 0; c < 6; c++) {
    clouds.push({ ox: U.rand(-1700, 1700), oy: U.rand(-1200, 1200),
                  r: U.rand(420, 780), vx: U.rand(4, 11), vy: U.rand(-3, 3) });
  }
  return { reefs: reefs, clouds: clouds };
}

// 纯装饰的水下浅滩 / 浪区：确定性网格生成，铺满整张海图但不参与碰撞
function shoalAt(gx, gy) {
  var h = IT.hash2(gx * 31 + 7, gy * 17 + 3);
  if (h > 0.80) return null;
  var h2 = IT.hash2(gx * 13 + 41, gy * 29 + 9);
  var h3 = IT.hash2(gx * 7 + 91, gy * 37 + 23);
  return {
    x: gx * 520 + h2 * 420, y: gy * 520 + h3 * 420,
    r: 120 + h2 * 240, ell: 0.5 + h3 * 0.32, rot: h * U.TAU,
    ph: h3 * U.TAU, strength: 0.35 + h2 * 0.65
  };
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
// 线段是否被任意硬地形（礁石/岛屿）拦腰截断——用于判断接敌航线是否需要绕行水道
function terrainBlockedLine(x1, y1, x2, y2) {
  var d = U.dist(x1, y1, x2, y2), steps = Math.max(2, Math.floor(d / 220));
  var ix = (x2 - x1) / steps, iy = (y2 - y1) / steps;
  for (var i = 1; i < steps; i++) {
    if (terrainHard(x1 + ix * i, y1 + iy * i)) return true;
  }
  return false;
}
/* ---------------- 自动导航：A* 寻路 + 航点跟随 ----------------
   直线导航会撞岛，改为栅格寻路：
   · 礁石 / 岛屿按「碰撞半径 ×0.9 + 舵效余量」膨胀成禁航格（战列余量更大）；
   · 浅滩可穿但格代价 ×2.4（拖底减速），路线以绕行为主、必要时穿过；
   · A* 八方向最短路（禁止贴角斜穿两禁航格的夹缝）→ 视线简化成少量航点；
   · 跟随途中每 2.5 游戏秒从船位重规划一次，偏离航线也能自动纠正。 */
var NAV_CELL = 200, NAV_GRID = Math.ceil(WORLD / NAV_CELL);
var navGrid = null;                       // { blocked, cost } —— 礁体开局后不变，按局缓存
function navMargin() {
  var p = G.player;
  return p ? U.clamp(p.def.turnR * 0.4, 140, 280) : 180;   // 战列转弯半径大 → 余量更大
}
function buildNavGrid() {
  var n = NAV_GRID, N = n * n;
  var blocked = new Uint8Array(N), cost = new Float32Array(N);
  for (var i = 0; i < N; i++) cost[i] = 1;
  var m = navMargin();
  for (var k = 0; k < G.reefs.length; k++) {
    var r = G.reefs[k];
    var rad = r.tier === 0 ? r.r * 0.9 : r.r * 0.9 + m;    // 浅滩不禁航，只记高代价区
    var c0 = Math.max(0, Math.floor((r.x - rad) / NAV_CELL)), c1 = Math.min(n - 1, Math.floor((r.x + rad) / NAV_CELL));
    var r0 = Math.max(0, Math.floor((r.y - rad) / NAV_CELL)), r1 = Math.min(n - 1, Math.floor((r.y + rad) / NAV_CELL));
    for (var gy = r0; gy <= r1; gy++) {
      for (var gx = c0; gx <= c1; gx++) {
        var idx = gy * n + gx;
        if (U.dist((gx + 0.5) * NAV_CELL, (gy + 0.5) * NAV_CELL, r.x, r.y) < rad) {
          if (r.tier === 0) cost[idx] = Math.max(cost[idx], 2.4);
          else blocked[idx] = 1;
        }
      }
    }
  }
  navGrid = { blocked: blocked, cost: cost };
}
// 带余量的直线可航判定（仅礁石/岛屿，浅滩可过）
function navLineClear(x1, y1, x2, y2, m) {
  var d = U.dist(x1, y1, x2, y2), steps = Math.max(2, Math.floor(d / 110));
  var ix = (x2 - x1) / steps, iy = (y2 - y1) / steps;
  for (var s = 1; s <= steps; s++) {
    var px = x1 + ix * s, py = y1 + iy * s;
    for (var i = 0; i < G.reefs.length; i++) {
      var r = G.reefs[i];
      if (r.tier !== 0 && U.dist(px, py, r.x, r.y) < r.r * 0.9 + m) return false;
    }
  }
  return true;
}
// A* 求路并简化：返回航点数组（末位为精确目的地），不可达返回 null
function navPlanPath(sx, sy, gx, gy) {
  if (!navGrid) buildNavGrid();
  var n = NAV_GRID, blocked = navGrid.blocked, cost = navGrid.cost, N = n * n;
  var sgx0 = U.clamp(Math.floor(gx / NAV_CELL), 0, n - 1), sgy0 = U.clamp(Math.floor(gy / NAV_CELL), 0, n - 1);
  var goal = sgy0 * n + sgx0;
  var goalX = gx, goalY = gy;                 // 航线终点（若吸附到可航格则取格中心）
  // 目的地落在禁航格（贴岛）→ 螺旋外扩找最近可航格
  if (blocked[goal]) {
    var ok = false;
    outer:
    for (var ring = 1; ring <= 12; ring++) {
      for (var oy = -ring; oy <= ring; oy++) {
        for (var ox = -ring; ox <= ring; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
          var tx = sgx0 + ox, ty = sgy0 + oy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          if (!blocked[ty * n + tx]) {
            goal = ty * n + tx;
            goalX = (tx + 0.5) * NAV_CELL; goalY = (ty + 0.5) * NAV_CELL;   // 终点也吸附出岛体
            ok = true; break outer;
          }
        }
      }
    }
    if (!ok) return null;
  }
  var start = U.clamp(Math.floor(sy / NAV_CELL), 0, n - 1) * n + U.clamp(Math.floor(sx / NAV_CELL), 0, n - 1);
  if (start === goal) return [{ x: goalX, y: goalY }];
  var gScore = new Float32Array(N).fill(Infinity);
  var came = new Int32Array(N).fill(-1);
  var closed = new Uint8Array(N);
  var heap = [];                              // 二叉最小堆 [f, idx]
  function hpush(f, idx) {
    heap.push([f, idx]);
    var i = heap.length - 1;
    while (i > 0) { var p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
  }
  function hpop() {
    var top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m2 = i;
        if (l < heap.length && heap[l][0] < heap[m2][0]) m2 = l;
        if (r < heap.length && heap[r][0] < heap[m2][0]) m2 = r;
        if (m2 === i) break;
        var t = heap[m2]; heap[m2] = heap[i]; heap[i] = t; i = m2;
      }
    }
    return top;
  }
  var DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  var ghx = goal % n, ghy = (goal / n) | 0;
  function heur(idx) {
    var x = idx % n, y = (idx / n) | 0, dx = Math.abs(x - ghx), dy = Math.abs(y - ghy);
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);   // 八方向 octile 启发
  }
  gScore[start] = 0;
  hpush(heur(start), start);
  var iter = 0;
  while (heap.length && iter++ < 30000) {
    var ci = hpop()[1];
    if (closed[ci]) continue;
    closed[ci] = 1;
    if (ci === goal) break;
    var cx = ci % n, cy = (ci / n) | 0;
    for (var d = 0; d < 8; d++) {
      var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      var ni = ny * n + nx;
      if (blocked[ni] || closed[ni]) continue;
      if (d >= 4 && (blocked[cy * n + nx] || blocked[ny * n + cx])) continue;  // 不贴角斜穿
      var ng = gScore[ci] + DIRS[d][2] * cost[ni];
      if (ng < gScore[ni]) { gScore[ni] = ng; came[ni] = ci; hpush(ng + heur(ni), ni); }
    }
  }
  if (came[goal] < 0) return null;
  var raw = [], c = goal;
  while (c !== -1) { raw.push({ x: (c % n + 0.5) * NAV_CELL, y: ((c / n | 0) + 0.5) * NAV_CELL }); c = came[c]; }
  raw.reverse();
  raw.push({ x: goalX, y: goalY });
  // 视线简化：贪心连接最远可见航点，砍掉冗余拐点
  var m = navMargin(), out = [], px = sx, py = sy, i3 = 0;
  while (i3 < raw.length) {
    var j = raw.length - 1;
    for (; j > i3; j--) { if (navLineClear(px, py, raw[j].x, raw[j].y, m)) break; }
    out.push(raw[j]);
    px = raw[j].x; py = raw[j].y; i3 = j + 1;
  }
  return out;
}
// 平滑闭合等值线：中点 + 二次曲线，避免折线感
function contourPath(pts, scale) {
  var n = pts.length, last = pts[n - 1], s = scale == null ? 1 : scale;
  ctx.beginPath();
  ctx.moveTo((last[0] + pts[0][0]) * 0.5 * s, (last[1] + pts[0][1]) * 0.5 * s);
  for (var i = 0; i < n; i++) {
    var p = pts[i], q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p[0] * s, p[1] * s,
      (p[0] + q[0]) * 0.5 * s, (p[1] + q[1]) * 0.5 * s);
  }
  ctx.closePath();
}
// 单块礁体：岸外等深线 → 由岸到峰分层设色 → 等高线 → 晕渲 → 碎浪 → 高程注记 → 主峰符号
function drawContourIsland(r, t, overview) {
  var iz = 1 / G.zoom, tier = r.tier, lv = r.contours.levels;
  var tints = CONTOUR_TINTS[tier], lines = CONTOUR_LINES[tier];
  // 全图档小礁至少占约 22px，避免等高线糊成一点（放大上限 1.28，不堵中央水道）
  var sc = overview ? Math.max(1, Math.min(1.28, 22 * iz / r.r)) : 1;
  // 屏幕尺寸 LOD：默认广域档整张海图入镜时，小岛只有几十像素，
  // 全画 8 层线 + 晕渲 + 碎浪既看不清又拖帧率 → 抽稀层数、跳过细节
  var compact = overview || r.r * G.zoom * sc < 130;
  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.scale(sc, sc);
  // 岸外浅水色晕
  var halo = ctx.createRadialGradient(0, 0, r.r * 0.5, 0, 0, r.r * 1.4);
  halo.addColorStop(0, tier === 0 ? 'rgba(74,176,164,.10)' : 'rgba(58,154,160,.15)');
  halo.addColorStop(1, 'rgba(30,100,120,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(0, 0, r.r * 1.4, 0, U.TAU); ctx.fill();
  // 水下等深线：一圈缓缓流动的虚线，让相邻礁体自然连成岛群
  if (tier > 0) {
    ctx.save(); contourPath(lv[0].pts, 1.15);
    ctx.setLineDash([9 * iz, 8 * iz]); ctx.lineDashOffset = -t * 7 * iz;
    ctx.strokeStyle = 'rgba(150,226,224,.18)'; ctx.lineWidth = 1.1 * iz; ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }
  // 由外到内分层填充 + 描等高线（全图档抽稀层数）
  var idx = [];
  for (var i = 0; i < lv.length; i++) if (!compact || i % 2 === 0 || i === lv.length - 1) idx.push(i);
  for (var q = 0; q < idx.length; q++) {
    var k = idx[q], L = lv[k], f = k / (lv.length - 1);
    contourPath(L.pts);
    ctx.fillStyle = tints[k]; ctx.fill();
    if (tier === 0) {
      ctx.setLineDash([8 * iz, 7 * iz]);
      ctx.strokeStyle = 'rgba(146,226,208,' + (0.26 + f * 0.26).toFixed(2) + ')';
      ctx.lineWidth = (L.major ? 1.25 : 0.9) * iz; ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = lines[k];
      ctx.lineWidth = (L.major ? 1.4 : 0.9) * iz; ctx.stroke();
      // 主曲线内侧压一道暗线，形成台地层次（不是挤出的土块）
      if (!compact && L.major && k < lv.length - 1) {
        ctx.save(); contourPath(L.pts, 0.96);
        ctx.strokeStyle = 'rgba(2,18,22,.16)'; ctx.lineWidth = 1.8 * iz; ctx.stroke();
        ctx.restore();
      }
    }
  }
  // 坡面晕渲：左上受光、右下背光
  if (!compact && tier > 0) {
    ctx.save(); contourPath(lv[0].pts); ctx.clip();
    var sh = ctx.createLinearGradient(-r.r, -r.r, r.r * 0.8, r.r * 0.9);
    sh.addColorStop(0, 'rgba(226,246,214,.16)');
    sh.addColorStop(0.48, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(0,16,22,.30)');
    ctx.fillStyle = sh; ctx.fillRect(-r.r * 1.3, -r.r * 1.3, r.r * 2.6, r.r * 2.6);
    ctx.restore();
  }
  // 亮岸线重描一次
  if (tier > 0) {
    contourPath(lv[0].pts);
    ctx.strokeStyle = 'rgba(186,244,226,.62)'; ctx.lineWidth = 1.5 * iz; ctx.stroke();
  }
  // 拍岸碎浪：沿海岸线切向的短弧，随时间明暗起伏
  if (!compact && tier > 0) {
    var cp = lv[0].pts, cn = cp.length;
    for (var w = 0; w < cn; w += 4) {
      var tw = Math.max(0, Math.sin(G.realTime * 1.6 + r.ph + w * 0.31));
      if (tw < 0.32) continue;
      var p = cp[w], q2 = cp[(w + 1) % cn];
      ctx.strokeStyle = 'rgba(216,246,250,' + (tw * 0.30).toFixed(2) + ')';
      ctx.lineWidth = (0.8 + tw * 1.2) * iz;
      ctx.beginPath();
      ctx.moveTo(p[0] * 1.03, p[1] * 1.03);
      ctx.lineTo((p[0] + q2[0]) * 0.515, (p[1] + q2[1]) * 0.515);
      ctx.stroke();
    }
  }
  // 高程注记：字号恒为屏幕 9.5px，岛太小时不画
  if (!compact && tier > 0 && r.r * G.zoom * sc > 105) {
    ctx.font = (9.5 * iz) + 'px Consolas,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var e = 2; e < lv.length; e += 2) {
      var LE = lv[e], kk = (e * 13 + 5) % LE.pts.length;
      var a1 = LE.pts[kk], a2 = LE.pts[(kk + 1) % LE.pts.length];
      var ang = Math.atan2(a2[1] - a1[1], a2[0] - a1[0]);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save(); ctx.translate(a1[0], a1[1]); ctx.rotate(ang);
      var txt = String(LE.elev), bw = txt.length * 5.8 * iz;
      ctx.fillStyle = 'rgba(5,26,32,.6)';
      ctx.fillRect(-bw / 2 - 2 * iz, -6 * iz, bw + 4 * iz, 12 * iz);
      ctx.fillStyle = 'rgba(230,246,216,.82)';
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // 主峰地图符号（兄弟岛）：细线三角 + 中心点 + 标高
  if (r.peak && tier === 2) {
    var pr = 11 * iz;
    ctx.save(); ctx.translate(r.contours.px, r.contours.py);
    ctx.strokeStyle = 'rgba(244,252,226,.9)'; ctx.lineWidth = 1.4 * iz;
    ctx.beginPath();
    ctx.moveTo(0, -pr * 0.8); ctx.lineTo(pr * 0.7, pr * 0.55); ctx.lineTo(-pr * 0.7, pr * 0.55);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = 'rgba(244,252,226,.9)';
    ctx.beginPath(); ctx.arc(0, pr * 0.02, 1.5 * iz, 0, U.TAU); ctx.fill();
    if (!compact) {
      ctx.fillStyle = 'rgba(236,248,220,.85)';
      ctx.font = 'bold ' + (9.5 * iz) + 'px Consolas,monospace';
      ctx.textAlign = 'center';
      ctx.fillText('800', 0, -pr * 1.35);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }
  ctx.restore();
}

// 水下浅滩 / 浪区：浅青绿水色 + 沙纹弧 + 表面碎浪，纯视觉，不影响航行
function drawShoals(view, t, rt) {
  // 全图时浅滩细节小到看不见：网格抽稀、跳过沙脊与碎浪，只留水色斑
  var unit = G.zoom < 0.1 ? 2 : 1, cell = 520 * unit, detail = G.zoom >= 0.1;
  var gx0 = Math.floor(view.x / cell) - 1, gx1 = Math.ceil((view.x + view.w) / cell) + 1;
  var gy0 = Math.floor(view.y / cell) - 1, gy1 = Math.ceil((view.y + view.h) / cell) + 1;
  var iz = 1 / G.zoom;
  for (var gy = gy0; gy <= gy1; gy++) {
    for (var gx = gx0; gx <= gx1; gx++) {
      var s = shoalAt(gx * unit, gy * unit);
      if (!s) continue;
      if (s.x + s.r < view.x || s.x - s.r > view.x + view.w ||
          s.y + s.r < view.y || s.y - s.r > view.y + view.h) continue;
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(s.rot);
      var g = ctx.createRadialGradient(0, 0, s.r * 0.12, 0, 0, s.r);
      g.addColorStop(0, 'rgba(38,124,124,' + (0.11 * s.strength).toFixed(3) + ')');
      g.addColorStop(0.55, 'rgba(26,92,104,' + (0.065 * s.strength).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(20,78,92,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, s.r, s.r * s.ell, 0, 0, U.TAU); ctx.fill();
      if (detail) {
        // 水下沙脊：几条错开的同心弧
        ctx.lineWidth = 1.6 * iz;
        for (var q = 0; q < 5; q++) {
          var rr = s.r * (0.28 + q * 0.15);
          ctx.strokeStyle = 'rgba(164,228,212,' + (0.045 * s.strength).toFixed(3) + ')';
          ctx.beginPath();
          ctx.ellipse(0, 0, rr, rr * s.ell, 0, s.ph + q * 0.3, s.ph + q * 0.3 + 2.0);
          ctx.stroke();
        }
        // 表面碎浪：随时间轻微起伏的短弧
        for (var w = 0; w < 4; w++) {
          var wa = (w * 2.399 + s.ph) % U.TAU;
          var wr = s.r * (0.45 + IT.hash2(gx * 9 + w, gy * 13 + w) * 0.55);
          var wx = Math.cos(wa) * wr, wy = Math.sin(wa) * wr * s.ell;
          var tw = Math.max(0, Math.sin(rt * 1.7 + s.ph + w * 1.3));
          if (tw < 0.35) continue;
          ctx.strokeStyle = 'rgba(206,244,246,' + (tw * 0.08 * s.strength).toFixed(3) + ')';
          ctx.lineWidth = (1 + tw * 1.5) * iz;
          ctx.beginPath();
          ctx.ellipse(wx, wy, 9 + tw * 12, 2.2 + tw * 1.6, wa, 0, U.TAU);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
}

/* ---------------- 舰队编成 ---------------- */
function fleetAlive(team) {
  var n = 0;
  G.ships.forEach(function (s) { if (!s.isPlayer && s.team === team && !s.sunk) n++; });
  return n;
}
// 舰种均衡：统计本队现存各舰种数量（含玩家），返回最少的舰种（并列随机）。
// 增量刷舰时依次调用，12 艘即自然配平为 4 DD + 4 CA + 4 BB。
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
// 预生成一队舰种序列：确定性轮转 dd→ca→bb，保证各舰种均匀（12 艘即 4 DD + 4 CA + 4 BB）
function buildFleetPlan(n) {
  var cnt = { dd: 0, ca: 0, bb: 0 }, out = [];
  for (var i = 0; i < n; i++) {
    var mn = Math.min(cnt.dd, cnt.ca, cnt.bb);
    var cs = ['dd', 'ca', 'bb'].filter(function (k) { return cnt[k] === mn; });
    var t = cs[0];
    cnt[t]++; out.push(t);
  }
  return out;
}
// 分层阵型槽位（局部坐标：fwd 指向敌方，side 为南北侧向）。
// 战列靠后外线、巡洋居中、驱逐走最外侧两翼（贴近侧翼岛区）；东西两岸镜像对称。
function fleetSlot(kind, idx, total) {
  if (kind === 'ca') {
    var sc = total > 1 ? -560 + idx * (1120 / (total - 1)) : 0;
    return { side: sc, fwd: 40 };
  }
  if (kind === 'bb') {
    var sb = total > 1 ? -1150 + idx * (2300 / (total - 1)) : 0;
    return { side: sb, fwd: -360 };
  }
  // dd：最外侧两翼
  var mag = 1500 + Math.floor(idx / 2) * 620;
  var sgn = (idx % 2 === 0) ? -1 : 1;
  return { side: sgn * mag, fwd: 340 };
}
// 生成一艘 AI 舰：开局用分层固定阵型，战斗中增援用随机方位；舰种按均衡配比选取
function spawnFleetShip(team, index, initial) {
  var p = G.player, x, y, kind;
  if (initial) {
    // 对角出生：我方在西南锚点、敌方在东北锚点，按舰种分层布阵、双方点对称
    var base = G.spawnAnchor[team], foe = G.spawnAnchor[team === 0 ? 1 : 0];
    var toFoe = Math.atan2(foe.y - base.y, foe.x - base.x);
    var fx = Math.cos(toFoe), fy = Math.sin(toFoe);   // 指向敌方
    var sx = -fy, sy = fx;                             // 侧向（南北）
    // 本舰舰种取自预生成序列，并按同舰种序号落入对应槽位
    var plan = G.fleetPlan[team] || [];
    kind = plan[index] || balanceKind(team);
    var idxWithin = 0, totalOfType = 0;
    for (var k = 0; k < plan.length; k++) {
      if (plan[k] === kind) { totalOfType++; if (k < index) idxWithin++; }
    }
    if (!totalOfType) totalOfType = 1;
    var slot = fleetSlot(kind, idxWithin, totalOfType);
    x = base.x + fx * slot.fwd + sx * slot.side;
    y = base.y + fy * slot.fwd + sy * slot.side;
  } else {
    var a = Math.random() * U.TAU;
    var dist = team === 0 ? U.rand(280, 520) : U.rand(1500, 2600);
    x = p.x + Math.cos(a) * dist; y = p.y + Math.sin(a) * dist;
    kind = balanceKind(team);
  }
  // 出生点避开礁石/岛屿
  var ter = terrainHard(x, y);
  if (ter) {
    var ta = Math.atan2(y - ter.y, x - ter.x);
    x = ter.x + Math.cos(ta) * (ter.r * 0.9 + 260);
    y = ter.y + Math.sin(ta) * (ter.r * 0.9 + 260);
  }
  // 从同舰种池（如 DD: 睦月/法拉格特/闪电）随机抽具体舰
  var pool = KIND_KEYS[kind] || SHIP_KEYS;
  var type = U.pick(pool);
  var tgt = G.spawnAnchor[team === 0 ? 1 : 0];
  var ang = Math.atan2(tgt.y - y, tgt.x - x);   // 舰艏朝向对面舰队
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
  var min = team === 0 ? 0 : 1, max = team === 0 ? 15 : 16;
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
  navGrid = null;   // 礁体每局重新生成 → 寻路栅格缓存作废，首次导航时重建
  G.particles = new IT.Particles();
  G.time = 0; G.realTime = 0; G.endTimer = -1; G.shake = 0; G.hitFlash = 0;
  G.stats = { shots: 0, hits: 0, damage: 0, kills: 0 };
  G.cam.x = WORLD / 2; G.cam.y = WORLD / 2;
  // 默认「广域」档：视野为全图的 2.5 倍，既能看清本舰又保留战场纵深
  G.zoomLevel = wideLevel(); applyZoom();
  G.nav = null; G.spectate = null;
  G.win = false;
  var cx = WORLD / 2, cy = WORLD / 2;
  // 对角出生锚点（复刻双峰海峡）：我方西南、敌方东北，相距 2×√2×SPAWN_DIAG ≈ 13000u（约 70 km），
  // 远大于最长主炮射程（长门 20.5km = 3834u），开局无法互相攻击；中央双岛夹出的水道可直穿接敌
  G.spawnAnchor[0] = { x: cx - SPAWN_DIAG, y: cy + SPAWN_DIAG };   // 我方 · 西南
  G.spawnAnchor[1] = { x: cx + SPAWN_DIAG, y: cy - SPAWN_DIAG };   // 敌方 · 东北
  G.spawnSeq = 0; G.nameSeq = 0; G.detectTick = 0;
  // 预生成每队舰种序列（按均衡配比），供分层阵型定位
  G.fleetPlan = { 0: buildFleetPlan(G.fleet.allies), 1: buildFleetPlan(G.fleet.enemies) };
  var toFoe0 = Math.atan2(G.spawnAnchor[1].y - G.spawnAnchor[0].y, G.spawnAnchor[1].x - G.spawnAnchor[0].x);
  G.player = new Ship(G.fleet.ship, G.spawnAnchor[0].x, G.spawnAnchor[0].y, toFoe0, 0, true);
  G.ships.push(G.player);
  for (var i = 0; i < G.fleet.allies; i++) spawnFleetShip(0, i, true);
  for (var j = 0; j < G.fleet.enemies; j++) spawnFleetShip(1, j, true);
  updateDetection();
  G.mouse.wx = G.player.x + Math.cos(G.player.ang) * 500;
  G.mouse.wy = G.player.y + Math.sin(G.player.ang) * 500;
  // 准星始终落在本舰前方 500u：按本舰相对海域中心的偏移反算屏幕位置，开局不会指到十几公里外
  if (!G.mouse.has) {
    G.mouse.sx = G.w / 2 + (G.player.x - cx) * G.zoom;
    G.mouse.sy = G.h / 2 + (G.player.y - cy) * G.zoom - 500 * G.zoom;
  }
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
  var km = (U.dist(G.player.x, G.player.y, G.spawnAnchor[1].x, G.spawnAnchor[1].y) / KM2U).toFixed(0);
  var dx = G.spawnAnchor[1].x - G.spawnAnchor[0].x, dy = G.spawnAnchor[1].y - G.spawnAnchor[0].y;
  toast('战斗开始 · 敌方 ' + G.fleet.enemies + ' 舰在' + dirWord(dx, dy) + '方向约 ' + km + ' km，战列靠后外线、巡洋居中、驱逐走侧翼；中央水道可冒险直穿，主力沿两翼岛群接敌（按 T 切快速档加速）');
  if (G.voice) setTimeout(function () { G.voice.say('battle_start'); }, 450);
}

/* ---------------- 视角缩放 ----------------
   zoomLevel 0 = 全图（默认，整张 WORLD 海域完整入镜），1 = 最近战术视角。
   中间按指数插值，滚轮每格的视觉变化均匀；窗口尺寸变化后自动重新适配。
------------------------------------------- */
function viewRange() {
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  // 全图：宽高都容得下整张海域，留 4% 边距避免边界贴住屏幕
  var fit = Math.min(G.w / WORLD, G.h / WORLD) * 0.96;
  // 战术视角：沿用原来「交战距离内可瞄准」的基准缩放
  var tactic = U.clamp(Math.min(G.w / (coarse ? 1600 : 1900), G.h / (coarse ? 1050 : 1100)),
                       coarse ? 0.36 : 0.5, coarse ? 0.7 : 0.9);
  return { fit: Math.max(fit, 0.008), tactic: tactic, max: Math.min(1.25, tactic * 1.6) };
}
function applyZoom() {
  var r = viewRange();
  G.fitZoom = r.fit; G.tacticZoom = r.tactic; G.maxZoom = r.max;
  G.zoomLevel = U.clamp(G.zoomLevel, 0, 1);
  G.zoom = G.fitZoom * Math.pow(G.maxZoom / G.fitZoom, G.zoomLevel);
  var label = G.zoomLevel < 0.02 ? '全图' : (G.zoom < r.tactic * 0.75 ? '广域' : '战术');
  var ratio = (G.zoom / G.fitZoom).toFixed(1);
  var tag = $('viewTag'), btn = $('btnView');
  if (tag) tag.textContent = label + ' ×' + ratio;
  if (btn) {
    btn.textContent = G.zoomLevel < 0.02 ? '全' : (label === '广域' ? '广' : '战');
    btn.title = '视角：' + label + '（' + ratio + ' 倍全图）· 点击/G 切换 全图→广域→战术 / 滚轮连续缩放 / 镜头跟随本舰';
    btn.classList.toggle('view-on', G.zoomLevel >= 0.02);
  }
}
function tacticLevel() {
  var r = viewRange();
  return U.clamp(Math.log(r.tactic / r.fit) / Math.log(r.max / r.fit), 0, 1);
}
// 广域档：视野为全图的 2.5 倍宽（默认开局档位），介于全图与战术之间
function wideLevel() {
  var r = viewRange();
  return U.clamp(Math.log(2.5) / Math.log(r.max / r.fit), 0, 1);
}
// G 键 / 视角按钮：全图 → 广域 → 战术 三档循环（按 zoomLevel 在数轴上的位置判断当前档）
function toggleView() {
  var tl = tacticLevel(), wl = wideLevel();
  var cur = G.zoomLevel;
  var next = cur < wl * 0.5 ? wl : (cur < (wl + tl) / 2 ? tl : 0);
  G.zoomLevel = next;
  applyZoom();
  var label = next < 0.02 ? '全图' : (next === wl ? '广域 ×2.5' : '战术');
  toast('视角 · ' + label);
  G.sound.ui(next > 0);
}
function resize() {
  G.w = window.innerWidth; G.h = window.innerHeight;
  G.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(G.w * G.dpr); canvas.height = Math.floor(G.h * G.dpr);
  canvas.style.width = G.w + 'px'; canvas.style.height = G.h + 'px';
  applyZoom();     // 尺寸变化后保持当前档位，重新适配全图与战术视角
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
    // 节奏行：主炮 / 鱼雷装填（真实秒）与炮塔回转，逐舰一目了然
    var tempo = '炮 ' + v.reload.toFixed(1) + 's · ' +
      (v.torpDmg ? '雷 ' + v.torpReload + 's×' + v.torpSalvos + ' 座' : '无雷') +
      ' · 塔 ' + v.turretRate.toFixed(1);
    var tip = '航速 ' + v.knots + '节 · 加速 ' + v.accel + ' · 转舵 ' + v.rudderShift + 's · ' +
      '被侦测 ' + v.concealKm.toFixed(1) + 'km · 主炮 ' + v.reload + 's · 炮塔 ' + v.turretRate + 'rad/s' +
      (v.torpDmg ? ' · 鱼雷 ' + v.torpMount + ' 枚 ×' + v.torpSalvos + ' 组 / ' +
                   v.torpReload + 's / ' + v.torpKnots + '节 / ' + (v.torpRange / KM2U).toFixed(1) + 'km' : '');
    return '<button class="fleet-ship" data-ship="' + v.key + '" title="' + tip + '">' +
             '<b>' + v.tag.split(' · ')[0] + ' ' + v.name + '</b><small>' + v.desc + '</small>' +
             '<em>' + stat + '<br><span class="tempo">' + tempo + '</span></em></button>';
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
    e.textContent = '本舰 ' + v.tag + ' · 隐蔽 ' + v.concealKm.toFixed(1) + 'km · 友军 ' +
      fleetAlive(0) + ' 艘 · 敌舰 ' + fleetAlive(1) + ' 艘';
  });
}
function syncShipCard() {
  var v = playerDef(G.fleet.ship);
  $('shipTag').textContent = v.tag;
  $('shipName').innerHTML = v.name + ' <em>' + v.romaji + '</em>';
  $('gunLabel').textContent = v.gunLabel;
  $('torpLabel').textContent = v.torpLabel + (v.torpDmg ? ' · ' + v.torpSalvos + ' 座独立装填' : '');
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
  // 主炮条：各炮塔独立装填 → 显示平均就绪度；文字显示就绪门数
  var gunReady = p.gunReadyCount(), gunTotal = p.turretReloads.length;
  var gunR = 0;
  if (gunTotal) {
    var gsum = 0;
    for (var gi2 = 0; gi2 < gunTotal; gi2++) gsum += 1 - U.clamp(p.turretReloads[gi2] / p.turretReloadMax, 0, 1);
    gunR = gsum / gunTotal;
  }
  $('gunFill').style.width = (gunR * 100).toFixed(1) + '%';
  $('gunFill').parentNode.classList.toggle('ready', gunReady === gunTotal);
  // 鱼雷条：各管座独立装填 → 显示就绪管座比例
  var torpReadyCnt = p.torpReadyCount(), torpTotal = p.torpMountReloads.length;
  var torpReady = !!p.def.torpDmg && torpReadyCnt > 0 && p.torpGap <= 0;
  var tr = 0;
  if (torpTotal) {
    var tsum = 0;
    for (var ti2 = 0; ti2 < torpTotal; ti2++) tsum += 1 - U.clamp(p.torpMountReloads[ti2] / p.torpReloadMax, 0, 1);
    tr = tsum / torpTotal;
  }
  $('torpFill').style.width = (tr * 100).toFixed(1) + '%';
  $('torpFill').parentNode.classList.toggle('ready', torpReady);
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
  $('btnFireTouch').classList.toggle('disabled', gunReady === 0);
  $('btnTorpTouch').classList.toggle('disabled', !torpReady);

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
  $('speedVal').textContent = Math.round(Math.abs(p.speed) / 3.6);   // u/s → 节（1 节 = 3.6 u/s）：极速档 = 舰船标称节数，不随节奏档缩放
  $('gunText').textContent = gunReady === gunTotal ? ('就绪 · ' + gunTotal + ' 门可齐射')
    : (gunReady > 0 ? ('就绪 ' + gunReady + '/' + gunTotal + ' · 单击逐门')
                    : ('装填 ' + (minRemaining(p.turretReloads) * inv).toFixed(1) + 's'));
  $('torpText').textContent = !p.def.torpDmg ? '未装备'
    : (torpReadyCnt === 0 ? ('装填 ' + (minRemaining(p.torpMountReloads) * inv).toFixed(1) + 's')
      : (p.torpGap > 0 ? ('下一座 ' + (p.torpGap * inv).toFixed(1) + 's')
        : ('就绪 · ' + torpReadyCnt + '/' + torpTotal + ' 座 · 每座 ' + p.def.torpMount + ' 枚')));
  var icons = '';
  if (p.fire > 0) icons += '<i class="fire">起火 ' + Math.ceil(p.fire) + 's</i>';
  if (p.flood > 0) icons += '<i class="flood">进水</i>';
  $('statusIcons').innerHTML = icons;
  // 隐蔽 / 侦测状态
  var cv = $('concealVal'), ss = $('spotState'), rh = $('radarHint');
  if (cv) cv.textContent = (p.concealNow / KM2U).toFixed(1) + ' km' + (p.fireStacks > 1 ? ' ×' + p.fireStacks : '');
  if (ss) {
    var exposed = p.spotted[1];
    ss.textContent = p.gunBloom > 0 ? '开火暴露'
      : (p.inSmoke ? '烟幕隐蔽' : (exposed ? '已被发现' : '未被发现'));
    ss.classList.toggle('exposed', exposed || p.gunBloom > 0);
  }
  if (rh) {
    var un = 0;
    G.ships.forEach(function (o) { if (o.team === 1 && !o.sunk && !o.spotted[0]) un++; });
    var uc = un ? searchCentroid(0) : null;
    rh.textContent = un ? ('未侦测 ' + un + ' 艘 · 约 ' +
      (uc ? (U.dist(p.x, p.y, uc.x, uc.y) / KM2U).toFixed(0) : '--') + ' km · T 加速接敌')
      : '目标已全部标定';
  }
  var tipEl = $('aimTip');
  if (tipEl) tipEl.innerHTML = nearestTarget(true)
    ? '将准星压在<b>绿色提前量标记</b>上开火'
    : '敌舰未被发现 · 接敌后才会显现并进入火控解算';
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
  // 本舰沉没 → 观战态 HUD：不再显示可用的武器 / 瞄准数据，改提示跟随的友舰
  if (p.sunk) {
    var vs = viewRef(), watch = vs && vs !== p;
    if (ss) { ss.textContent = watch ? '观战 · ' + vs.short : '本舰已沉没'; ss.classList.add('exposed'); }
    if (rh) rh.textContent = watch ? '跟随友舰「' + vs.name + '」· 战斗继续' : '本舰已沉没 · 战斗继续';
    if (tipEl) tipEl.innerHTML = '<b>本舰已沉没</b> · 观战中，友军继续作战';
    $('gunText').textContent = '本舰已沉没';
    $('torpText').textContent = '本舰已沉没';
    $('btnFireTouch').classList.add('disabled');
    $('btnTorpTouch').classList.add('disabled');
    $('aimDist').textContent = '--'; $('aimTime').textContent = '--';
    $('turretState').textContent = '—'; $('turretState').style.color = '';
    $('speedVal').textContent = '0';
    $('statusIcons').innerHTML = '<i class="flood">已沉没</i>';
  }
}

function showResult() {
  var s = G.stats;
  var sunk = G.player && G.player.sunk;
  $('resultEyebrow').textContent = G.win ? 'VICTORY · BATTLE REPORT' : 'DEFEAT · BATTLE REPORT';
  $('resultTitle').textContent = G.win ? (sunk ? '友军获胜' : '战斗胜利') : '我方舰队全灭';
  $('resultTitle').style.color = G.win ? '#7dffa8' : '#ff8a75';
  $('resultDesc').textContent = G.win
    ? (sunk ? '本舰已沉没，友军完成清场，海域控制权仍归我方。' : '敌方舰队已全部沉入海底，海域控制权归你所有。')
    : '我方舰队全部沉没……下次记得用机动规避敌方齐射。';
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

  var p = viewRef() || G.player;   // 本舰沉没后雷达以观战友舰为中心
  // 海图地形：浅滩 / 礁石 / 岛屿按真实位置投影到雷达
  mctx.save();
  mctx.beginPath(); mctx.arc(0, 0, R - 1, 0, U.TAU); mctx.clip();
  G.reefs.forEach(function (r) {
    var x = (r.x - p.x) * scale, y = (r.y - p.y) * scale, rr = r.r * scale;
    if (x + rr < -R || x - rr > R || y + rr < -R || y - rr > R) return;
    if (r.tier === 0) {
      mctx.fillStyle = 'rgba(58,148,138,.13)';
      mctx.beginPath(); mctx.ellipse(x, y, rr, rr * 0.74, 0.35, 0, U.TAU); mctx.fill();
      mctx.strokeStyle = 'rgba(110,205,190,.42)'; mctx.lineWidth = 1;
      mctx.setLineDash([2, 2]);
      mctx.beginPath(); mctx.ellipse(x, y, rr, rr * 0.74, 0.35, 0, U.TAU); mctx.stroke();
      mctx.setLineDash([]);
    } else if (r.tier === 1) {
      mctx.fillStyle = 'rgba(88,128,138,.55)';
      mctx.beginPath(); mctx.ellipse(x, y, rr * 0.8, rr * 0.6, 0.35, 0, U.TAU); mctx.fill();
      mctx.strokeStyle = 'rgba(170,220,230,.48)'; mctx.lineWidth = 1; mctx.stroke();
    } else {
      mctx.fillStyle = 'rgba(76,122,78,.68)';
      mctx.beginPath(); mctx.ellipse(x, y, rr, rr * 0.75, 0.35, 0, U.TAU); mctx.fill();
      mctx.strokeStyle = 'rgba(162,216,166,.62)'; mctx.lineWidth = 1; mctx.stroke();
      mctx.fillStyle = 'rgba(194,224,172,.32)';
      mctx.beginPath(); mctx.ellipse(x - rr * 0.2, y - rr * 0.16, rr * 0.44, rr * 0.3, 0.35, 0, U.TAU); mctx.fill();
    }
  });
  mctx.restore();
  // 方位刻度与距离标注
  for (var d = 0; d < 24; d++) {
    var da = d / 24 * U.TAU, r0 = R - (d % 6 === 0 ? 9 : 4);
    mctx.strokeStyle = 'rgba(111,227,255,.28)'; mctx.lineWidth = 1;
    mctx.beginPath();
    mctx.moveTo(Math.cos(da) * r0, Math.sin(da) * r0);
    mctx.lineTo(Math.cos(da) * R, Math.sin(da) * R); mctx.stroke();
  }
  mctx.font = '9px Consolas,monospace'; mctx.textAlign = 'center';
  mctx.fillStyle = 'rgba(158,226,242,.72)';
  mctx.fillText('N', 0, -R - 5); mctx.fillText('S', 0, R + 11);
  mctx.fillText('W', -R - 9, 3); mctx.fillText('E', R + 9, 3);
  mctx.font = '8px Consolas,monospace'; mctx.textAlign = 'left';
  mctx.fillStyle = 'rgba(130,200,224,.5)';
  [2, 4, 6].forEach(function (km) { mctx.fillText(km + 'km', 3, -R * km / 8 + 10); });
  // 鱼雷
  G.torps.forEach(function (t) {
    var x = (t.x - p.x) * scale, y = (t.y - p.y) * scale;
    if (x * x + y * y > R * R) return;
    // 我方鱼雷青蓝、敌方鱼雷橙红，与海面颜色一致
    mctx.fillStyle = t.owner === 0 ? '#7fe6ff' : '#ff5a45';
    mctx.fillRect(x - 2, y - 2, 4, 4);
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
  // 敌舰：只显示已被我方发现的
  G.ships.forEach(function (s) {
    if (s.team === 0 || s.sunk || !s.spotted[0]) return;
    var x = (s.x - p.x) * scale, y = (s.y - p.y) * scale;
    var d = Math.sqrt(x * x + y * y);
    if (d > R - 5) { x *= (R - 5) / d; y *= (R - 5) / d; }
    mctx.fillStyle = '#ff6a55';
    mctx.beginPath(); mctx.arc(x, y, 3.4, 0, U.TAU); mctx.fill();
    mctx.strokeStyle = 'rgba(255,106,85,.45)'; mctx.lineWidth = 1;
    mctx.beginPath(); mctx.arc(x, y, 7, 0, U.TAU); mctx.stroke();
  });
  // 未侦测敌舰：雷达边缘给出大致方位箭头，不暴露精确位置
  var unknown = 0;
  G.ships.forEach(function (s) { if (s.team === 1 && !s.sunk && !s.spotted[0]) unknown++; });
  if (unknown) {
    var uc = searchCentroid(0);
    if (uc) {
      var ua = Math.atan2(uc.y - p.y, uc.x - p.x);
      mctx.save();
      mctx.translate(Math.cos(ua) * (R - 9), Math.sin(ua) * (R - 9));
      mctx.rotate(ua);
      mctx.fillStyle = 'rgba(255,150,110,.85)';
      mctx.beginPath(); mctx.moveTo(9, 0); mctx.lineTo(-4, -5); mctx.lineTo(-4, 5); mctx.closePath(); mctx.fill();
      mctx.restore();
      mctx.font = 'bold 8px Consolas,monospace'; mctx.textAlign = 'center';
      mctx.fillStyle = 'rgba(255,180,150,.9)';
      mctx.fillText('?' + unknown, Math.cos(ua) * (R - 24), Math.sin(ua) * (R - 24) + 3);
    }
  }
  // 本舰
  mctx.save(); mctx.rotate(p.ang);
  mctx.fillStyle = '#6fe3ff'; mctx.strokeStyle = '#d8f8ff'; mctx.lineWidth = 1;
  mctx.beginPath(); mctx.moveTo(9, 0); mctx.lineTo(-6, -5.5); mctx.lineTo(-3, 0); mctx.lineTo(-6, 5.5);
  mctx.closePath(); mctx.fill(); mctx.stroke();
  mctx.restore();
  mctx.restore();
}

/* ---------------- 渲染 ---------------- */
// 水深底图：按视野反算源矩形，只贴可见部分
function drawSeabed(view) {
  if (!seabedMap) return;
  var ix0 = Math.max(0, view.x), iy0 = Math.max(0, view.y);
  var ix1 = Math.min(WORLD, view.x + view.w), iy1 = Math.min(WORLD, view.y + view.h);
  if (ix1 <= ix0 || iy1 <= iy0) return;
  var k = seabedSize / WORLD;
  ctx.drawImage(seabedMap, ix0 * k, iy0 * k, (ix1 - ix0) * k, (iy1 - iy0) * k,
    ix0, iy0, ix1 - ix0, iy1 - iy0);
}

// 战术网格：细格 / 主格 / 坐标刻度 / 本舰距离圈
function drawTacticalGrid(view, t) {
  var iz = 1 / G.zoom, step = 500;
  while (step * G.zoom < 26) step *= 2;   // 全图时细格自动抽稀，不会糊成一片
  var major = step * 4;
  var x0 = Math.floor(view.x / step) * step, y0 = Math.floor(view.y / step) * step;
  ctx.save();
  ctx.lineWidth = 0.8 * iz;
  ctx.setLineDash([3 * iz, 11 * iz]);
  ctx.strokeStyle = 'rgba(128,202,228,.045)';
  ctx.beginPath();
  for (var gx = x0; gx < view.x + view.w + step; gx += step) {
    if (gx % major === 0) continue;
    ctx.moveTo(gx, view.y); ctx.lineTo(gx, view.y + view.h);
  }
  for (var gy = y0; gy < view.y + view.h + step; gy += step) {
    if (gy % major === 0) continue;
    ctx.moveTo(view.x, gy); ctx.lineTo(view.x + view.w, gy);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // 主格 + 交点十字 + 坐标标注
  var mx0 = Math.floor(view.x / major) * major, my0 = Math.floor(view.y / major) * major;
  ctx.strokeStyle = 'rgba(128,208,234,.10)'; ctx.lineWidth = 1 * iz;
  ctx.beginPath();
  for (var ax = mx0; ax < view.x + view.w + major; ax += major) { ctx.moveTo(ax, view.y); ctx.lineTo(ax, view.y + view.h); }
  for (var ay = my0; ay < view.y + view.h + major; ay += major) { ctx.moveTo(view.x, ay); ctx.lineTo(view.x + view.w, ay); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(140,216,240,.22)';
  ctx.beginPath();
  for (var bx = mx0; bx < view.x + view.w + major; bx += major) {
    for (var by = my0; by < view.y + view.h + major; by += major) {
      ctx.moveTo(bx - 4 * iz, by); ctx.lineTo(bx + 4 * iz, by);
      ctx.moveTo(bx, by - 4 * iz); ctx.lineTo(bx, by + 4 * iz);
    }
  }
  ctx.stroke();
  // 主格不加文字标注，保持瞄准区干净
  // 本舰距离圈（2 / 4 / 6 km），极淡，不干扰瞄准
  if (G.player && !G.player.sunk && G.state !== 'menu') {
    ctx.setLineDash([9 * iz, 13 * iz]);
    ctx.strokeStyle = 'rgba(111,227,255,.075)'; ctx.lineWidth = 1 * iz;
    [2, 4, 6].forEach(function (km) {
      ctx.beginPath(); ctx.arc(G.player.x, G.player.y, K(km), 0, U.TAU); ctx.stroke();
    });
    ctx.setLineDash([]);
    // 本舰隐蔽圈：敌方要进入这个半径才可能发现本舰（红色 = 已被发现）
    if (G.player && G.state !== 'menu') {
      ctx.setLineDash([5 * iz, 10 * iz]);
      ctx.strokeStyle = G.player.spotted[1] ? 'rgba(255,120,90,.26)' : 'rgba(125,255,168,.2)';
      ctx.lineWidth = 1.2 * iz;
      ctx.beginPath();
      ctx.arc(G.player.x, G.player.y, G.player.concealNow || G.player.def.conceal, 0, U.TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// 太阳耀斑带 + 波峰线 + 碎光：按世界网格确定性分布，镜头移动时不会跳变
function drawSunGlints(view, t, rt) {
  var iz = 1 / G.zoom, TAU = U.TAU;
  var slope = 0.32, band = Math.max(820, 340 / G.zoom);   // 全图时按屏幕宽度撑开光带
  var midY = view.y + view.h * 0.5;
  var sunX = WORLD * 0.5 - 260 + (midY - WORLD * 0.5) * slope;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  var sg = ctx.createLinearGradient(sunX - band, 0, sunX + band, 0);
  sg.addColorStop(0, 'rgba(120,190,220,0)');
  sg.addColorStop(0.4, 'rgba(255,238,202,.018)');
  sg.addColorStop(0.5, 'rgba(255,244,214,.085)');
  sg.addColorStop(0.6, 'rgba(255,238,202,.018)');
  sg.addColorStop(1, 'rgba(120,190,220,0)');
  ctx.fillStyle = sg; ctx.fillRect(sunX - band, view.y, band * 2, view.h);

  // 波峰短线：全图时细线小到看不见，直接跳过（也省掉上万次网格循环）
  if (G.zoom > 0.12) {
    var c2 = 220;
    var ax0 = Math.floor(view.x / c2), ax1 = Math.ceil((view.x + view.w) / c2);
    var ay0 = Math.floor(view.y / c2), ay1 = Math.ceil((view.y + view.h) / c2);
    for (var ay = ay0; ay <= ay1; ay++) {
      for (var ax = ax0; ax <= ax1; ax++) {
        var h1 = IT.hash2(ax * 3 + 5, ay * 7 + 11);
        if (h1 < 0.70) continue;
        var px = ax * c2 + IT.hash2(ax * 17 + 3, ay * 23 + 9) * c2;
        var py = ay * c2 + IT.hash2(ax * 29 + 13, ay * 11 + 27) * c2;
        var sw = Math.sin(rt * 0.9 + h1 * 12) * 3;
        ctx.strokeStyle = 'rgba(168,222,240,' + (0.008 + h1 * 0.02).toFixed(3) + ')';
        ctx.lineWidth = (0.7 + h1 * 0.8) * iz;
        ctx.beginPath();
        ctx.moveTo(px - 18, py);
        ctx.quadraticCurveTo(px, py - 2 + sw, px + 24, py + 1);
        ctx.stroke();
      }
    }
  }
  // 日照碎光：网格间距按屏幕密度自适应，全图时不会退化成几万次循环
  var cell = Math.max(124, 62 / G.zoom);
  var gx0 = Math.floor(view.x / cell), gx1 = Math.ceil((view.x + view.w) / cell);
  var gy0 = Math.floor(view.y / cell), gy1 = Math.ceil((view.y + view.h) / cell);
  for (var gy = gy0; gy <= gy1; gy++) {
    for (var gx = gx0; gx <= gx1; gx++) {
      var h = IT.hash2(gx * 3 + 1, gy * 5 + 7);
      if (h > 0.48) continue;
      var sx = gx * cell + IT.hash2(gx * 9 + 41, gy * 13 + 5) * cell;
      var sy = gy * cell + IT.hash2(gx * 7 + 19, gy * 31 + 61) * cell;
      var cx = WORLD * 0.5 - 260 + (sy - WORLD * 0.5) * slope;
      var sun = 1 - U.clamp(Math.abs(sx - cx) / band, 0, 1);
      sun *= sun;
      if (sun < 0.05) continue;
      var tw = Math.max(0, Math.sin(rt * 2.4 + h * 40));
      var a = sun * (0.025 + tw * 0.26);
      ctx.fillStyle = 'rgba(255,247,218,' + a.toFixed(3) + ')';
      var rScale = 0.8 / G.zoom;   // 战术档≈1，全图时把碎光撑到同样的屏幕尺寸
      ctx.beginPath();
      ctx.ellipse(sx, sy, (8 + tw * 20) * rScale, (1.2 + tw * 2.6) * rScale, 0.22, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

// 云影：以镜头为锚循环漂移，始终有柔和的明暗变化
function drawCloudShadows(view, t) {
  function wrap(v, span) { return ((v % span) + span) % span - span / 2; }
  G.clouds.forEach(function (c) {
    var x = G.cam.x + wrap(c.ox + t * c.vx * 3, 3800);
    var y = G.cam.y + wrap(c.oy + t * c.vy * 3, 2600);
    if (x + c.r < view.x || x - c.r > view.x + view.w ||
        y + c.r < view.y || y - c.r > view.y + view.h) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, c.r);
    g.addColorStop(0, 'rgba(1,12,22,.13)');
    g.addColorStop(0.6, 'rgba(1,12,22,.07)');
    g.addColorStop(1, 'rgba(1,12,22,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, c.r, c.r * 0.6, 0.4, 0, U.TAU); ctx.fill();
  });
}

function drawSea(view, t) {
  var rt = G.realTime;
  // 边界外深海
  ctx.fillStyle = '#051724';
  ctx.fillRect(view.x, view.y, view.w, view.h);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, WORLD, WORLD); ctx.clip();
  drawSeabed(view);
  // 波纹 + 洋流合成层，整体缓慢漂移（只做一次全屏采样）
  var ox = t * 6, oy = t * 2.4;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = seaPattern;
  ctx.fillRect(view.x - ox, view.y - oy, view.w, view.h);
  ctx.restore();
  // 水下浅滩 / 浪区
  drawShoals(view, t, rt);
  // 战术网格
  drawTacticalGrid(view, t);
  // 海域边界
  ctx.strokeStyle = 'rgba(111,227,255,.22)'; ctx.lineWidth = 3 / G.zoom;
  ctx.setLineDash([18 / G.zoom, 14 / G.zoom]);
  ctx.strokeRect(0, 0, WORLD, WORLD);
  ctx.setLineDash([]);
  // 日照与波峰碎光
  drawSunGlints(view, t, rt);
  ctx.restore();
  // 云影压在光照之上，形成明暗层次（不裁剪，边界外也有轻微雾感）
  drawCloudShadows(view, t);
}

function drawScenery(view, t) {
  var overview = G.zoom < 0.1;
  G.reefs.forEach(function (r) {
    if (r.x + r.r * 1.45 < view.x || r.x - r.r * 1.45 > view.x + view.w ||
        r.y + r.r * 1.45 < view.y || r.y - r.r * 1.45 > view.y + view.h) return;
    drawContourIsland(r, t, overview);
  });
}

// 未侦测到的敌舰不显示实体，只给一个模糊的「可疑海域」圈，避免全图一片空白
function drawUnknownContacts(t) {
  if (G.state !== 'play' || !G.player) return;
  var n = 0;
  for (var i = 0; i < G.ships.length; i++) {
    var s = G.ships[i];
    if (s.team === 1 && !s.sunk && !s.spotted[0]) n++;
  }
  if (!n) return;
  var c = searchCentroid(0);
  if (!c) return;
  var own = searchCentroid(1);      // 我方舰队中心（team 1 的「敌方」就是 team 0）
  var ref = viewRef() || G.player;  // 观战时以跟随的友舰为基准
  var iz = 1 / G.zoom, R = K(5);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,160,110,' + (0.28 + Math.sin(t * 2) * 0.06).toFixed(2) + ')';
  ctx.lineWidth = 1.5 * iz; ctx.setLineDash([11 * iz, 9 * iz]);
  ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, U.TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,186,150,.85)';
  ctx.font = 'bold ' + (18 * iz) + 'px Consolas,monospace';
  ctx.fillText('？', c.x, c.y + 6 * iz);
  ctx.font = (10 * iz) + 'px Consolas,monospace';
  ctx.fillText('敌方未侦测 · 约 ' + (U.dist(ref.x, ref.y, c.x, c.y) / KM2U).toFixed(0) + ' km',
    c.x, c.y - R - 9 * iz);
  // 全图档同时标出我方舰队；接敌航线被岛群挡住时不画直线，改为提示绕行
  if (G.zoom < 0.1 && own) {
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(111,227,255,.4)'; ctx.lineWidth = 1.4 * iz;
    ctx.beginPath(); ctx.arc(own.x, own.y, R * 0.8, 0, U.TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(150,235,255,.85)'; ctx.font = (10 * iz) + 'px Consolas,monospace';
    ctx.fillText('我方舰队', own.x, own.y - R * 0.8 - 9 * iz);
    if (terrainBlockedLine(own.x, own.y, c.x, c.y)) {
      ctx.fillStyle = 'rgba(255,200,150,.72)'; ctx.font = (9 * iz) + 'px Consolas,monospace';
      ctx.fillText('岛群阻隔 · 绕行两翼或穿中央水道', own.x, own.y + R * 0.8 + 15 * iz);
    } else {
      ctx.setLineDash([14 * iz, 12 * iz]);
      ctx.strokeStyle = 'rgba(160,220,240,.2)'; ctx.lineWidth = 1.2 * iz;
      ctx.beginPath(); ctx.moveTo(own.x, own.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(170,225,240,.55)'; ctx.font = (9 * iz) + 'px Consolas,monospace';
      ctx.fillText('接敌航线 · ' + (U.dist(own.x, own.y, c.x, c.y) / KM2U).toFixed(0) + ' km',
        (own.x + c.x) / 2, (own.y + c.y) / 2 - 8 * iz);
    }
  }
  ctx.restore();
}

function drawWorld(t) {
  var iz = 1 / G.zoom;   // 世界单位 → 屏幕像素，弹丸按屏幕尺寸补偿，全图下也能看清
  var view = {
    x: G.cam.x - G.w / (2 * G.zoom), y: G.cam.y - G.h / (2 * G.zoom),
    w: G.w / G.zoom, h: G.h / G.zoom
  };
  drawSea(view, t);
  drawScenery(view, t);
  // 尾迹：未被发现的敌舰连尾迹也不显示
  for (var i = 0; i < G.ships.length; i++) {
    var sw = G.ships[i];
    if (sw.team === 1 && !sw.spotted[0] && !sw.sunk) continue;
    IT.drawWake(ctx, sw);
  }
  // 鱼雷：我方青蓝带亮芯，敌方橙红带警示环；航迹同色，一眼可分敌我
  G.torps.forEach(function (tp) {
    var mine = tp.owner === 0;
    var rgb = mine ? '111,227,255' : '255,90,70';
    if (tp.trail.length > 1) {
      ctx.save(); ctx.lineCap = 'round';
      for (var k = 1; k < tp.trail.length; k++) {
        var a = tp.trail[k - 1], b = tp.trail[k];
        if (b.a <= 0) continue;
        ctx.strokeStyle = 'rgba(' + rgb + ',' + (b.a * 0.7).toFixed(2) + ')';
        ctx.lineWidth = (1.5 + b.a * 2.0) * iz;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.save(); ctx.translate(tp.x, tp.y); ctx.rotate(tp.ang);
    ctx.scale(Math.max(1, 14 * iz / 16), Math.max(1, 14 * iz / 16));  // 全图下也保持约 14px 可辨长度
    ctx.shadowColor = mine ? '#6fe3ff' : '#ff5a45'; ctx.shadowBlur = 10;
    ctx.fillStyle = mine ? '#bff2ff' : '#ff8a6a';
    ctx.fillRect(-8, -1.8, 16, 3.6);
    ctx.shadowBlur = 0;
    ctx.fillStyle = mine ? '#6fe3ff' : '#ff3b22';       // 弹头色块
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(3, -2.4); ctx.lineTo(3, 2.4); ctx.closePath(); ctx.fill();
    if (!mine) {                                        // 敌方鱼雷额外脉冲警示环
      var pulse = 0.45 + Math.sin(t * 9 + tp.x * 0.01) * 0.22;
      ctx.strokeStyle = 'rgba(255,90,70,' + pulse.toFixed(2) + ')'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0, 0, 8, 0, U.TAU); ctx.stroke();
    }
    ctx.restore();
  });
  // 舰船：敌方舰只有被我方发现后才显示
  for (var j = 0; j < G.ships.length; j++) {
    var ds = G.ships[j];
    if (ds.team === 1 && !ds.spotted[0] && !ds.sunk) continue;
    IT.drawShip(ctx, ds, t, G.zoom, 14);
  }
  // 未发现目标的可疑海域：只给大致方位，不暴露具体位置
  drawUnknownContacts(t);
  // 自动导航点：青色脉冲圆环 + 避障航线（本舰→各航点的虚线折线）+ 距离标注
  if (G.nav && G.player && !G.player.sunk) {
    var p0 = G.player, pulse = 0.5 + Math.sin(t * 5) * 0.25;
    var wps = G.nav.path, wi = Math.min(G.nav.wp, wps.length - 1);
    ctx.save();
    ctx.strokeStyle = 'rgba(111,227,255,.55)';
    ctx.lineWidth = 1.6 * iz;
    ctx.setLineDash([12 * iz, 10 * iz]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y);
    for (var wj = wi; wj < wps.length; wj++) ctx.lineTo(wps[wj].x, wps[wj].y);
    ctx.stroke();
    ctx.setLineDash([]);
    // 途经点小十字标（接下来的两三个，提醒绕岛拐点）
    ctx.strokeStyle = 'rgba(111,227,255,.5)';
    ctx.lineWidth = 1.4 * iz;
    for (var wk = wi; wk < Math.min(wps.length - 1, wi + 3); wk++) {
      var cr = 6 * iz;
      ctx.beginPath();
      ctx.moveTo(wps[wk].x - cr, wps[wk].y); ctx.lineTo(wps[wk].x + cr, wps[wk].y);
      ctx.moveTo(wps[wk].x, wps[wk].y - cr); ctx.lineTo(wps[wk].x, wps[wk].y + cr);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(111,227,255,' + (0.35 + pulse * 0.5).toFixed(2) + ')';
    ctx.lineWidth = 2.2 * iz;
    ctx.beginPath(); ctx.arc(G.nav.x, G.nav.y, (18 + pulse * 8) * iz, 0, U.TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(111,227,255,.9)';
    ctx.beginPath(); ctx.arc(G.nav.x, G.nav.y, 4.5 * iz, 0, U.TAU); ctx.fill();
    // 距离标注（世界空间文字按缩放补偿，全图下也可读）
    ctx.font = Math.max(11, 13 * iz) + 'px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((U.dist(p0.x, p0.y, G.nav.x, G.nav.y) / KM2U).toFixed(1) + ' km',
                 G.nav.x, G.nav.y - 30 * iz);
    ctx.restore();
  }
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
  // 炮弹：颜色与轨迹按弹种区分（HE 暖色 / AP 冷色），敌我再用不同色调
  G.shells.forEach(function (sh) {
    var col = shellColor(sh);
    var y = sh.drawY();
    ctx.save();
    if (sh.trail.length > 1) {
      ctx.lineCap = 'round';
      for (var q = 1; q < sh.trail.length; q++) {
        var a = sh.trail[q - 1], b = sh.trail[q], f = q / sh.trail.length;
        ctx.strokeStyle = 'rgba(' + col.trail + ',' + (f * 0.68).toFixed(2) + ')';
        ctx.lineWidth = (1.0 + f * 2.0) * iz;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ctx.fillStyle = col.core;
    ctx.shadowColor = col.glow; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(sh.x, y, (sh.he ? 3.4 : 3.0) * iz, 0, U.TAU); ctx.fill();
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
  if (G.state === 'play' && G.mouse.has && !G.assist && playerActive()) drawAimSpot(t);
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
    if (f.label) {
      ctx.font = 9 * iz + 'px Consolas,monospace';
      ctx.fillStyle = f.crit ? '#ffd45e' : (f.label === 'FIRE' ? '#ff9b3c' : '#9fd8e8');
      ctx.fillText(f.label, f.x, f.y - 14 * iz);
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
    if (s.team === 0 || s.sunk || !s.spotted[0]) return;
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
    if (s.team === 0 || s.sunk || !s.spotted[0]) return;
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
  if (!G.mouse.has || G.state !== 'play' || !G.player || G.player.sunk) return;
  var x = G.mouse.sx, y = G.mouse.sy;
  var p = G.player;
  var d = U.dist(p.x, p.y, G.mouse.wx, G.mouse.wy);
  var ready = p.gunReadyCount() > 0;   // 任一炮塔就绪即可开火（单击逐门 / 双击齐射）
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
  var ref = viewRef() || G.player;   // 观战时方位距离以跟随的友舰为基准
  G.ships.forEach(function (s) {
    if (s.team === 0 || s.sunk || !s.spotted[0]) return;
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
    ctx.fillText(Math.round(U.dist(ref.x, ref.y, s.x, s.y) / KM2U * 1000) + 'm',
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
  if (G.player && !G.player.sunk && G.player.hp / G.player.maxHp < 0.3 && G.state === 'play') {
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
  // 侦测解算按真实时间节流（约每 0.12s 一次），避免每帧 12×12 次的视线计算
  G.detectTick -= rdt;
  if (G.detectTick <= 0) { G.detectTick = 0.12; updateDetection(); }
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
    // 自动导航：右键目的地 → A* 避障航线 → 逐航点自动打舵（手动操舵会先取消）
    if (G.nav && G.player && !G.player.sunk) {
      var nv = G.nav;
      // 定期重规划：船位偏离航线（交战漂移）后自动纠偏
      nv.replan -= dt;
      if (nv.replan <= 0) {
        var np = navPlanPath(G.player.x, G.player.y, nv.x, nv.y);
        if (!np) {
          G.nav = null;
          toast('航线被岛群封死 · 导航取消');
          G.sound.ui(false);
        } else { nv.path = np; nv.wp = 0; nv.replan = 2.5; }
      }
    }
    if (G.nav && G.player && !G.player.sunk) {
      var nv2 = G.nav;
      var wp = nv2.path[Math.min(nv2.wp, nv2.path.length - 1)];
      var tdx = wp.x - G.player.x, tdy = wp.y - G.player.y;
      var tnd = Math.sqrt(tdx * tdx + tdy * tdy);
      var isFinal = nv2.wp >= nv2.path.length - 1;
      // 途经点用宽松半径（够得着就走）；最终点沿用随航速放大的抵达圈 + 驶过判定
      var arr = isFinal ? 160 + G.player.speed * 2.2 : Math.max(220, G.player.speed * 1.6);
      if (isFinal && (tnd < arr || (nv2.min != null && tnd > nv2.min + 140 && tnd < 1200))) {
        var passed = tnd >= arr;
        G.nav = null;
        toast(passed ? '已驶过导航点 · 导航结束' : '已抵达导航点');
        G.sound.ui(false);
      } else if (!isFinal && tnd < arr) {
        nv2.wp++;                                   // 途经点已够近 → 切下一个航点
      } else {
        if (isFinal && (nv2.min == null || tnd < nv2.min)) nv2.min = tnd;
        // 比例舵：舵角随航向误差缩放（±1 满舵 / 小误差小舵角），慢舵 BB 不会大幅过冲振荡
        var ndiff = U.norm(Math.atan2(tdy, tdx) - G.player.ang);
        G.player.rudderTarget = Math.abs(ndiff) < 0.08 ? 0 : U.clamp(ndiff * 1.8, -1, 1);
      }
    }
    // 玩家炮塔跟随准星
    if (G.player && !G.player.sunk) {
      var rel = U.norm(Math.atan2(G.mouse.wy - G.player.y, G.mouse.wx - G.player.x) - G.player.ang);
      G.player.turrets.forEach(function (t) { t.target = rel; });
    }
    // 按住 = 逐门滚动射击 / 逐座滚动放雷（每座之间留短间隔，可分别瞄准）
    if (playerActive() && G.heldFire && G.player.gunReadyCount() > 0) playerFire();
    if (playerActive() && G.heldTorp && G.player.torpGap <= 0 && G.player.torpReadyCount() > 0) playerTorp();
    // 玩家自动副炮（俾斯麦）：与 AI 同逻辑，射程内自动持续输出
    var pl = G.player;
    if (pl && !pl.sunk && pl.def.specials.secondary && pl.secReload <= 0) {
      var secTgt = null, secD = Infinity;
      G.ships.forEach(function (o) {
        if (o.team !== 1 || o.sunk || !o.spotted[0]) return;   // 只瞄准已发现的敌舰
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
  G.shake = Math.max(0, G.shake - (dt / P().time) * 30);   // 按真实时间衰减：标准档下不残留
  G.hitFlash = Math.max(0, G.hitFlash - dt * 1.7);
  G.tipCd = Math.max(0, G.tipCd - rdt);
  if (G.toastTimer > 0) {
    G.toastTimer -= rdt;
    if (G.toastTimer <= 0) $('toast').classList.remove('show');
  }
  // 相机：跟随本舰；本舰沉没后改跟随观战友舰（全图档平滑过渡到海域中心）
  var vr = viewRef();
  if (vr) {
    var la = G.mouse.has ? Math.atan2(G.mouse.wy - vr.y, G.mouse.wx - vr.x) : vr.ang;
    var tx = vr.x + Math.cos(la) * 110, ty = vr.y + Math.sin(la) * 110;
    // 全图时把镜头钉在海域中心，放大后平滑过渡为跟随参照舰
    var follow = U.clamp((G.zoom / G.fitZoom - 1) / 2.2, 0, 1);
    var gx = U.lerp(WORLD / 2, tx, follow), gy = U.lerp(WORLD / 2, ty, follow);
    var k = 1 - Math.pow(0.002, rdt);
    G.cam.x = U.lerp(G.cam.x, gx, k); G.cam.y = U.lerp(G.cam.y, gy, k);
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
  ctx.clearRect(0, 0, G.w, G.h);   // 底色由 drawSea 覆盖，这里不再重复填充
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
  seabedMap = IT.makeSeabedMap(WORLD, seabedSize);
  // 短波纹与洋流烘焙成同一张可平铺纹理，每帧只需一次全屏采样
  var seaTile = IT.makeSeaTexture(512);
  seaTile.getContext('2d').drawImage(IT.makeCurrentTexture(512), 0, 0);
  seaPattern = ctx.createPattern(seaTile, 'repeat');
  resize();
  window.addEventListener('resize', resize);
  bindInput();
  $('fleetSetup').innerHTML = fleetMarkup();
  $('fleetLive').innerHTML = fleetMarkup();
  setAssist(window.matchMedia('(pointer: coarse)').matches);   // 触屏默认开启自动解算
  setPace(G.pace);                                            // 默认「标准」档（基准 100% 流速）
  reset();
  G.state = 'menu';
  // 菜单时的准星位置
  G.mouse.sx = G.w * 0.5; G.mouse.sy = G.h * 0.42; G.mouse.has = false;
  requestAnimationFrame(frame);
}
boot();

})();

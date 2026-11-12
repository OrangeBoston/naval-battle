# 项目长期笔记 · 战舰世界（海战 Demo《钢铁怒潮 IRON TIDE》）

## 技术约束
- 纯 HTML/CSS/JS + Canvas 2D，零依赖、零构建，双击 `index.html`（file://）即可离线运行；不要引入 npm 包、ES module、fetch 或外部 CDN 资源。
- **战斗音效 = 真实海军录音**（非合成）：`sounds/` 下 13 个文件（gun/gun_heavy/explosion/explosion_big/hit/hit_crit/splash/torpedo/sink/ambient + ui_up/ui_down 保留合成）；原 `alarm` 键已**弃用**——战斗警报改由大肥鱼语音 `alarm` 负责（见下），`sounds.js` 里的 `alarm` 键保留但不再被 game.js 调用。由 `tools/build_sfx.py` 从合法 CC0/公有领域来源（BeachHead、OpenGameArt、usstunny.com）整理映射而成；`js/sounds.js` 内嵌 base64 兜底（file:// 双击即响）。引擎 `Sound` 用 `decodeAudioData` 播放，**优先 `fetch sounds/*.{wav,mp3,ogg}`，失败回退 base64**。**用户可把 `sounds/` 下同名文件换成真实录音，无需改代码。** 加载顺序：`index.html` 依次引 `sounds.js`→`engine.js`→`voice.js`→`game.js`。BB 主炮 `gun()` 传 `type==='bb'` 改用 `gun_heavy`。
- **语音播报 = Breeze 本地 TTS（大肥鱼声线）**：`sounds/vo/*.wav`（21 条）由 `tools/generate_voice.py`（批量 20 条）+ `tools/gen_alarm.py`（单独增量生成 `alarm`/战斗警报）调用本机 `breeze-server.exe`（127.0.0.1:8137，`D:\breeze-tts\start-breeze.cmd` 启动）合成；`js/voice.js` 内嵌 base64。`engine.js` 的 `Voice` 类复用 `Sound` 的 AudioContext，机制同 `Sound`；侧栏 `btnVoice` 按钮 + `V` 键开关。触发点：舵令/变速/开火/鱼雷/装填完/目标锁定/命中/击沉/受击/胜负/战斗开始/战斗警报(alarm,语音,4s 节流)。**舵令节流**：`syncRudder` 仅当转向方向真正改变且与上次舵令间隔 >2.5s 才播报，避免频繁刷屏。
- **浏览器环境铁律**：engine.js 一律用 `window.` 而非 `global.`（浏览器无 Node 的 `global`）；game.js 是 IIFE，必须在 `var G={...}` 后写 `window.G = G;` 才能被 engine.js 访问；`file://` 下 `Sound`/`Voice` 的 `fetchBuffer` 应跳过文件 fetch 直接读 base64（消除 404 噪音）。
- 全局命名空间 `window.IT`（engine.js）与 game.js 内 IIFE 闭包；`G` 为游戏全局状态对象（须通过 `window.G` 暴露）。
- 双端适配：桌面键鼠 + `(pointer:coarse)` 触屏布局；触屏默认开启火控辅助。

## 视觉与手感基调
- 深色海军战术 HUD：青蓝 `#6fe3ff` 为玩家/UI 主色，敌舰 `#ff6a55`，起火/警示橙红，提前量 `#7dffa8`；切角面板、扫描线、雷达扫描扇。
- 提前量解算是核心玩法；任何改动都要保证「准星可达敌舰解算点」，镜头缩放与交战距离需一起调。
- **默认慢节奏**（用户多次要求「再慢一些」）：`PACES.slow` 时间流速 **0.2**（2026-11-12 由 0.4 下调），`T` / HUD 按钮可切标准节奏（1.0）。`playerReload` 设为与 time 同值（0.2）：玩家按舰船列出的装填间隔以真实秒计（长门 29s 就是 29 真实秒），世界统一减速、手感不失衡。新增机制一律遵守：世界物理按缩放 dt；玩家输入响应（舵角/炮塔/车钟）、UI 提示、结算延迟、镜头跟随按真实时间 `rdt = dt / P().time`；HUD 秒数与航速需换算为真实感知值；`paceSec(x)` 把「真实秒」转成游戏秒，用于开局缓冲与 AI 鱼雷 CD 这类不该被流速拖长的计时。
- **舰队编成是一等公民**：`PLAYER_SHIPS` 9 艘完全体真实数据舰（2026-11-12 替换旧 3 舰：睦月/法拉格特/闪电/克利夫兰/妙高/爱宕/长门/俾斯麦/约克公爵），`shipDef(key)` 为唯一数据源（玩家/AI 共用，`DEFS`/`FLEET_TYPES` 已删除）。世界尺度换算：`KM2U=187`、`SP(knots)=knots×3.6/154`、`TR/RR/TS`、`vel=m/s×1.875`；turrets 为 `{lx,barrels}`（1~4 管）；HE/AP 双弹种（`s.ammo`，R 切换），要害命中恰好 ×2，仅 HE 有 10% 起火；特技：烟雾 Z（90s CD/15s，`G.smokes` 封顶 240、AI 远距无法锁定烟中目标）、引擎增压 B（闪电，极速 ×1.22）、俾斯麦自动副炮（`fireSecondary`——**玩家与 AI 各有一条调用路径**：AI 在 `updateAI` 内，玩家在 `update()` 主循环专设块，只瞄准敌舰 `team===1`）。AI 按距离选弹种、残血自动拉烟。默认编成 友:敌=6:6（`allies:5,enemies:6` 含本舰，本舰+5友军 vs 6敌）；AI 舰按 `balanceKind(team)` 舰种均衡刷（每队 DD/CA/BB 差≤1，6 艘即 2/2/2，玩家舰种计入配额，增援补最稀缺舰种），具体舰从同类池 `KIND_KEYS` 随机抽。`G.fleet` 保存舰种/友军/敌舰数，`C` 或侧栏「编」随时调整且即时生效。任何新增战斗逻辑必须区分「玩家 / 友军 AI / 敌方 AI」（`isPlayer` + `aiOwned`），不能假定固定舰数；胜负只看本舰沉没与敌舰全灭。
- **地图与特效**（2026-11-12）：障碍物三档高低差（浅滩/礁石/岛屿，`drawRockBody` 伪 3D 挤出 + 落影 + 顶面高光）；海面有日光辉斑 + 闪烁碎光 + 深浅水色斑；粒子系统支持 `type:'flash'`（加性发光，炮口焰/爆闪光球）。雷达覆盖 8km，HUD 距离一律换算为米。
- **地形参与玩法**（2026-11-12 应"地形没起作用"）：`WORLD=22000`，36 个障碍铺满中心 8.8km 半径（中心 760u 净空）；浅滩 tier0=拖底减速（`speed*=1-2.6*dt`），礁石/岛屿 tier1/2=硬碰撞（`terrainHard/terrainAny` 圆形判定 r×0.9：推离+搁浅掉血按速度×0.4（岛×1.6）+急停×0.22+`groundCd` 3s 保护）；炮弹落点在 tier≥1 上被拦截（对舰无伤害，高弹道可飞越）；鱼雷触 tier≥1 引爆；**岛屿 tier2 阻断视线**（`losBlocked` 线段-圆判定，`findTarget`/`nearestTarget` 均跳过岛后目标，岛后可脱锁）；AI 有地形规避（前方 430u 内障碍沿切向绕行 `away±0.85`，紧急减速）；出生点避开障碍（推到 r+260 外）；敌舰初始距离 1850-2610u（约 10-14km）。注意：辅助开启且无射程内目标时 `playerFire` 拒绝开火（大地图开局正常现象）。
- **镜头震动规范**（2026-11-12 应"震动太频繁"）：必须用 `addShake(v, x, y)`（500u 内全额、2100u 外为零，上限 18）——远处的爆炸/沉没不晃屏；玩家开炮按口径 dd0.9/ca1.8/bb3.4；**衰减必须按真实时间** `G.shake -= (dt/P().time)*30`（曾用游戏 dt，慢节奏 0.2 下衰减慢 5 倍导致震动残留——这是"太频繁"的主因）。`window.__game` 调试钩子暴露 WORLD/losBlocked/terrainHard/bigExplosion/Shell/Torpedo 供自动化测试。

## 迭代习惯
- 每次交付后用户会提出功能增减或视觉修复，优先小步修改并实际运行验证，不要只给建议。

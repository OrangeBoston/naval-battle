#!/usr/bin/env python3
# Build the game's sounds/ directory + js/sounds.js base64 from real downloaded
# naval recordings. Existing synthesized ui_up/ui_down are kept as-is.
import os, base64, shutil

PROJ = "C:/Users/xgamer/WorkBuddy/战舰世界"
RAW  = os.path.join(PROJ, "sounds", "raw")
SEVEN = os.path.join(RAW, "7z", "qubodup-NavalBattleSoundSet-cc0")
BEACH = RAW
USNY  = RAW
SOUNDS = os.path.join(PROJ, "sounds")

# name -> (source absolute path, extension to write on disk)
MAP = {
    'gun':            (os.path.join(SEVEN, 'ogg', 'GunShot.ogg'), 'ogg'),
    'gun_heavy':      (os.path.join(SEVEN, 'ogg', 'WaterSurfaceExplosion05.ogg'), 'ogg'),
    'explosion':      (os.path.join(SEVEN, 'ogg', 'ExplosionMetal.ogg'), 'ogg'),
    'explosion_big':  (os.path.join(SEVEN, 'ogg', 'WaterSurfaceExplosion02.ogg'), 'ogg'),
    'hit':            (os.path.join(BEACH, 'naval-ship-impact.mp3'), 'mp3'),
    'hit_crit':       (os.path.join(BEACH, 'naval-metal-damage.mp3'), 'mp3'),
    'splash':         (os.path.join(SEVEN, 'ogg', 'Splash.ogg'), 'ogg'),
    'torpedo':        (os.path.join(USNY, 'usny_Torpedo.wav'), 'wav'),
    'sink':           (os.path.join(SEVEN, 'ogg', 'WaterSurfaceExplosion03.ogg'), 'ogg'),
    'alarm':          (os.path.join(USNY, 'usny_battlestation.wav'), 'wav'),
    'ui_up':          (os.path.join(SOUNDS, 'ui_up.wav'), 'wav'),
    'ui_down':        (os.path.join(SOUNDS, 'ui_down.wav'), 'wav'),
    'ambient':        (os.path.join(SEVEN, 'ogg', 'BattleShipMovementAmbient.ogg'), 'ogg'),
}

# Names whose OLD synthesized files (any extension) must be removed so the
# loader does not pick the stale .wav before the new .ogg/.mp3.
REMOVE_OLD = ['gun','gun_heavy','explosion','explosion_big','hit','hit_crit',
              'splash','torpedo','sink','alarm','ambient']

for name in REMOVE_OLD:
    for ext in ('wav','mp3','ogg'):
        p = os.path.join(SOUNDS, f'{name}.{ext}')
        if os.path.exists(p) and os.path.abspath(p) != os.path.abspath(MAP[name][0]):
            os.remove(p)
            print('removed stale', p)

b64 = {}
for name,(src,ext) in MAP.items():
    assert os.path.exists(src), f'missing {src}'
    dst = os.path.join(SOUNDS, f'{name}.{ext}')
    if os.path.abspath(src) != os.path.abspath(dst):
        shutil.copyfile(src, dst)
    with open(dst,'rb') as f:
        data = f.read()
    b64[name] = base64.b64encode(data).decode('ascii')
    print(f'{name:12s} {ext:4s} {len(data):8d} B -> b64 {len(b64[name])}')

# write js/sounds.js
out = os.path.join(PROJ, 'js', 'sounds.js')
lines = ["/* Real naval combat SFX — downloaded from the web (CC0 / public domain).",
         "   Sources: OpenGameArt 'Battle at Sea' & 'Tiny Naval Battle' (CC0),",
         "   BeachHead port (CC0), and real US Navy audio (usstunny.com, public domain).",
         "   Prefer fetch sounds/<name>.<ext>; fall back to base64 on file://.",
         "*/",
         "window.SOUND_BASE64 = {"]
for i,(name,v) in enumerate(b64.items()):
    comma = ',' if i < len(b64)-1 else ''
    lines.append(f"  '{name}': '{v}'{comma}")
lines.append("};")
with open(out,'w',encoding='utf-8') as f:
    f.write('\n'.join(lines)+'\n')
print('wrote', out, os.path.getsize(out), 'bytes')

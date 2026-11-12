#!/usr/bin/env python3
# Generate Chinese voice lines with the local Breeze TTS server (dafeiyu voice),
# downsample to 16 kHz mono WAV, and emit js/voice.js (base64 fallback for file://).
import urllib.request, json, os, wave, io, base64, array, sys

HOST, PORT = '127.0.0.1', 8137
VO = ['rudder_left','rudder_right','rudder_center','speed_up','speed_down','speed_full',
      'speed_stop','fire_main','torpedo_fire','reload_done','enemy_spotted','target_lock',
      'enemy_hit','enemy_sunk','player_hit','player_critical','battle_start','victory',
      'defeat','ship_sink']
TXT = {
    'rudder_left':'左满舵', 'rudder_right':'右满舵', 'rudder_center':'舵回中',
    'speed_up':'加车', 'speed_down':'减速', 'speed_full':'全速前进', 'speed_stop':'停车',
    'fire_main':'主炮开火', 'torpedo_fire':'鱼雷发射', 'reload_done':'装填完毕',
    'enemy_spotted':'发现敌舰', 'target_lock':'目标锁定', 'enemy_hit':'命中',
    'enemy_sunk':'敌舰沉没', 'player_hit':'我舰中弹', 'player_critical':'舰体受损',
    'battle_start':'战斗开始', 'victory':'战斗胜利', 'defeat':'任务失败', 'ship_sink':'弃舰',
}
OUT = 'C:/Users/xgamer/WorkBuddy/战舰世界/sounds/vo'
os.makedirs(OUT, exist_ok=True)

def gen(text):
    payload = json.dumps({'input':text,'voice':'dafeiyu','response_format':'wav'}).encode('utf-8')
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(f'http://{HOST}:{PORT}/v1/audio/speech', data=payload,
                                        headers={'Content-Type':'application/json'})
            data = urllib.request.urlopen(req, timeout=90).read()
            if data[:4] != b'RIFF':
                raise RuntimeError(f'not wav: {data[:40]!r}')
            return data
        except Exception as e:
            last = e
    raise last

def resample_mono_16k(wav_bytes):
    r = wave.open(io.BytesIO(wav_bytes), 'rb')
    fr, ch = r.getframerate(), r.getnchannels()
    n = r.getnframes()
    raw = r.readframes(n); r.close()
    a = array.array('h'); a.frombytes(raw)
    if ch > 1:
        mono = array.array('h')
        for i in range(0, len(a), ch):
            mono.append(sum(a[i:i+ch]) // ch)
        a = mono
    target = 16000
    if fr != target:
        ratio = fr / target
        L = len(a)
        out_len = int(L / ratio)
        out = array.array('h')
        for j in range(out_len):
            pos = j * ratio
            i0 = int(pos); frac = pos - i0
            i1 = min(i0 + 1, L - 1)
            v = a[i0] * (1 - frac) + a[i1] * frac
            out.append(int(round(v)))
        a = out
    mx = max((abs(x) for x in a), default=0) or 1
    th = int(mx * 0.02)
    i0 = 0
    while i0 < len(a) and abs(a[i0]) < th: i0 += 1
    i1 = len(a) - 1
    while i1 > i0 and abs(a[i1]) < th: i1 -= 1
    a = a[i0:i1+1]
    buf = io.BytesIO()
    w = wave.open(buf, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(a.tobytes()); w.close()
    return buf.getvalue()

b64 = {}
for n in VO:
    raw = gen(TXT[n])
    proc = resample_mono_16k(raw)
    with open(os.path.join(OUT, n + '.wav'), 'wb') as f:
        f.write(proc)
    b64[n] = base64.b64encode(proc).decode('ascii')
    print(f'{n:14s} {TXT[n]:6s} {len(proc):7d} B', flush=True)

lines = ["/* Voice lines generated locally with Breeze TTS (dafeiyu voice).",
         "   Played on player commands & key battle events. */",
         "window.VOICE_BASE64 = {"]
for i,(n,v) in enumerate(b64.items()):
    comma = ',' if i < len(b64)-1 else ''
    lines.append(f"  '{n}': '{v}'{comma}")
lines.append("};")
open('C:/Users/xgamer/WorkBuddy/战舰世界/js/voice.js','w',encoding='utf-8').write('\n'.join(lines)+'\n')
print('wrote js/voice.js', os.path.getsize('C:/Users/xgamer/WorkBuddy/战舰世界/js/voice.js'), 'bytes')

#!/usr/bin/env python3
# 单独生成一条大肥鱼声线语音 "alarm / 战斗警报"，增量合并进 js/voice.js，
# 不重跑已有的 20 条语音。
import urllib.request, json, os, wave, io, base64, array, re

HOST, PORT = '127.0.0.1', 8137
OUT = 'C:/Users/xgamer/WorkBuddy/战舰世界/sounds/vo'
VOICE_JS = 'C:/Users/xgamer/WorkBuddy/战舰世界/js/voice.js'
NAME, TEXT = 'alarm', '战斗警报'

def gen(text):
    payload = json.dumps({'input': text, 'voice': 'dafeiyu', 'response_format': 'wav'}).encode('utf-8')
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(f'http://{HOST}:{PORT}/v1/audio/speech', data=payload,
                                        headers={'Content-Type': 'application/json'})
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

raw = gen(TEXT)
proc = resample_mono_16k(raw)
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, NAME + '.wav'), 'wb') as f:
    f.write(proc)
b64 = base64.b64encode(proc).decode('ascii')
print(f'{NAME:8s} {TEXT} {len(proc):7d} B')

# 解析现有 voice.js，保留已有条目，增量加入 alarm
existing = {}
if os.path.exists(VOICE_JS):
    txt = open(VOICE_JS, encoding='utf-8').read()
    for m in re.finditer(r"'([a-z_]+)'\s*:\s*'([A-Za-z0-9+/=]+)'", txt):
        existing[m.group(1)] = m.group(2)
existing[NAME] = b64

order = ['rudder_left','rudder_right','rudder_center','speed_up','speed_down','speed_full',
         'speed_stop','fire_main','torpedo_fire','reload_done','enemy_spotted','target_lock',
         'enemy_hit','enemy_sunk','player_hit','player_critical','battle_start','victory',
         'defeat','ship_sink','alarm']
keys = [k for k in order if k in existing] + [k for k in existing if k not in order]

lines = ["/* Voice lines generated locally with Breeze TTS (dafeiyu voice).",
         "   Played on player commands & key battle events. */",
         "window.VOICE_BASE64 = {"]
for i, k in enumerate(keys):
    comma = ',' if i < len(keys) - 1 else ''
    lines.append(f"  '{k}': '{existing[k]}'{comma}")
lines.append("};")
open(VOICE_JS, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('wrote js/voice.js', os.path.getsize(VOICE_JS), 'bytes; alarm present:', NAME in existing,
      '; total clips:', len(existing))

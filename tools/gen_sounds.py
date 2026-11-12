#!/usr/bin/env python3
# 离线渲染《钢铁怒潮》真实感战斗音效采样（纯 Python，无依赖）
# 输出：sounds/*.wav  +  js/sounds.js（内嵌 base64，供 file:// 双击运行兜底）
import math, struct, wave, base64, os, random

SR = 22050  # 采样率：战斗音效无需高保真，22.05k 足够且体积小

def rnd(): return random.uniform(-1.0, 1.0)

def white(n): return [rnd() for _ in range(n)]

def lp(src, a):
    """一阶低通/平滑：a 越小截止越低"""
    out = []; s = 0.0
    for x in src:
        s = s + a * (x - s); out.append(s)
    return out

def one_pole_bandpass(src, a_low, a_high):
    """近似带通：低通后减去更低通"""
    lo = lp(src, a_low)
    hi = lp(src, a_high)
    return [lo[i] - hi[i] for i in range(len(src))]

# ---------------- 各类音效 ----------------
def gun(heavy=False):
    dur = 0.9 if heavy else 0.55
    n = int(dur * SR); out = [0.0] * n
    # 低频"轰"体：正弦从高频扫到低频 + 指数衰减
    f0, f1, body = (95, 35, 0.72) if heavy else (140, 45, 0.6)
    for i in range(n):
        t = i / SR; env = math.exp(-t * (6 if heavy else 9))
        f = f0 * math.exp(-t * (3 if heavy else 4)) + f1
        out[i] += math.sin(2 * math.pi * f * t) * body * env
    # 高频"爆裂"噪声
    crack = lp(white(n), 0.18 if heavy else 0.25)
    for i in range(n):
        t = i / SR; env = math.exp(-t * (22 if heavy else 30))
        out[i] += crack[i] * (0.55 if heavy else 0.5) * env
    return out

def explosion(big=False):
    dur = 1.5 if big else 0.8
    n = int(dur * SR); out = [0.0] * n
    rumble = lp(white(n), 0.07 if big else 0.1)
    for i in range(n):
        t = i / SR; env = math.exp(-t * (3 if big else 4.5))
        out[i] += rumble[i] * (0.8 if big else 0.7) * env
    # 低频冲击
    f0, f1 = (90, 25) if big else (120, 30)
    for i in range(n):
        t = i / SR; env = math.exp(-t * (3.5 if big else 5))
        f = f0 * math.exp(-t * 2.5) + f1
        out[i] += math.sin(2 * math.pi * f * t) * (0.6 if big else 0.5) * env
    if big:
        # 碎片噼啪
        for _ in range(16):
            c = int(random.uniform(0.05, 0.6) * SR); d = int(0.05 * SR)
            for i in range(d):
                if c + i < n:
                    t = i / SR; env = math.exp(-t * 40)
                    out[c + i] += rnd() * 0.22 * env
    return out

def hit(crit=False):
    n = int(0.35 * SR); out = [0.0] * n
    crack = lp(white(n), 0.4)
    for i in range(n):
        t = i / SR; env = math.exp(-t * 18)
        out[i] += crack[i] * 0.5 * env
    # 金属叮（暴击更尖）
    f = 1400 if crit else 900
    for i in range(n):
        t = i / SR; env = math.exp(-t * 12)
        out[i] += math.sin(2 * math.pi * f * t) * 0.18 * env
    return out

def splash():
    n = int(0.4 * SR); out = [0.0] * n
    s = lp(white(n), 0.6)
    low = lp(s, 0.3)
    band = [s[i] - low[i] for i in range(n)]
    for i in range(n):
        t = i / SR; env = math.exp(-t * 10)
        out[i] += band[i] * 0.55 * env
    return out

def torpedo():
    n = int(0.85 * SR); out = [0.0] * n
    # 发动机嗡鸣（含二次谐波）
    for i in range(n):
        t = i / SR; env = math.exp(-t * 2.5) * (1 - math.exp(-t * 15))
        f = 70 + t * 40
        out[i] += (math.sin(2 * math.pi * f * t) + 0.3 * math.sin(2 * math.pi * 2 * f * t)) * 0.18 * env
    # 喷气白噪
    s = lp(white(n), 0.5)
    for i in range(n):
        t = i / SR; env = math.exp(-t * 3) * (1 - math.exp(-t * 10))
        out[i] += s[i] * 0.2 * env
    # 发射撞击
    for i in range(int(0.06 * SR)):
        t = i / SR; env = math.exp(-t * 40)
        out[i] += math.sin(2 * math.pi * 90 * t) * 0.4 * env
    return out

def sink():
    n = int(2.2 * SR); out = [0.0] * n
    rumble = lp(white(n), 0.06)
    for i in range(n):
        t = i / SR; env = math.exp(-t * 1.6)
        out[i] += rumble[i] * 0.7 * env
    for i in range(n):
        t = i / SR; env = math.exp(-t * 2); f = 80 * math.exp(-t * 1.5) + 22
        out[i] += math.sin(2 * math.pi * f * t) * 0.55 * env
    # 结构呻吟（低频滑音）
    for _ in range(6):
        c = int(random.uniform(0.2, 1.8) * SR); d = int(random.uniform(0.3, 0.7) * SR)
        f0 = random.uniform(60, 120)
        for i in range(d):
            if c + i < n:
                t = i / SR; env = math.exp(-t * 3)
                out[c + i] += math.sin(2 * math.pi * (f0 + t * 20) * t) * 0.2 * env
    return out

def alarm():
    n = int(0.36 * SR); out = [0.0] * n
    for i in range(n):
        t = i / SR
        f = 440 if (t % 0.18) < 0.09 else 330
        # 轻微方波质感
        s = math.sin(2 * math.pi * f * t)
        out[i] += (s + 0.3 * math.sin(2 * math.pi * 2 * f * t)) * 0.3
    return out

def ui(up=True):
    n = int(0.1 * SR); out = [0.0] * n
    f0, f1 = (620, 900) if up else (430, 300)
    for i in range(n):
        t = i / SR; env = math.exp(-t * 30); f = f0 + (f1 - f0) * t / 0.1
        out[i] += math.sin(2 * math.pi * f * t) * 0.22 * env
    return out

def ambient():
    # 3 秒无缝循环：LFO = 1/3 Hz（整周期），低频海浪起伏
    n = int(3.0 * SR); out = [0.0] * n
    low = lp(white(n), 0.045)  # 棕噪感
    pk = max(1e-6, max(abs(x) for x in low))
    for i in range(n):
        t = i / SR
        lfo = 0.6 + 0.4 * math.sin(2 * math.pi * (1.0 / 3.0) * t)
        out[i] = (low[i] / pk) * 0.5 * lfo
    return out

# ---------------- 渲染 + 封装 ----------------
MANIFEST = {
    'gun':        (lambda: gun(False),  False),
    'gun_heavy':  (lambda: gun(True),   False),
    'explosion':  (lambda: explosion(False), False),
    'explosion_big': (lambda: explosion(True),  False),
    'hit':        (lambda: hit(False),  False),
    'hit_crit':   (lambda: hit(True),   False),
    'splash':     (lambda: splash(),    False),
    'torpedo':    (lambda: torpedo(),   False),
    'sink':       (lambda: sink(),      False),
    'alarm':      (lambda: alarm(),     False),
    'ui_up':      (lambda: ui(True),    False),
    'ui_down':    (lambda: ui(False),   False),
    'ambient':    (lambda: ambient(),   True),
}

def write_wav(path, samples, sr=SR):
    pk = max(1e-6, max(abs(x) for x in samples))
    scale = 0.9 / pk
    w = wave.open(path, 'w')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, x * scale)) * 32767)) for x in samples)
    w.writeframes(frames); w.close()
    return frames

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    snd_dir = os.path.join(root, 'sounds')
    js_dir = os.path.join(root, 'js')
    os.makedirs(snd_dir, exist_ok=True)
    os.makedirs(js_dir, exist_ok=True)

    b64_map = {}
    summary = []
    for name, (gen, loop) in MANIFEST.items():
        samples = gen()
        wav_path = os.path.join(snd_dir, name + '.wav')
        frames = write_wav(wav_path, samples)
        b64 = base64.b64encode(frames).decode('ascii')
        b64_map[name] = b64
        summary.append(f"  {name:14s} {len(samples)/SR:5.2f}s  wav={len(frames)//1024}KB  b64={len(b64)//1024}KB")

    js_path = os.path.join(js_dir, 'sounds.js')
    with open(js_path, 'w', encoding='ascii') as f:
        f.write("/* Realistic combat SFX (offline-rendered, base64 fallback).\n")
        f.write("   Replace sounds/<name>.wav|.mp3 with real recordings anytime. */\n")
        f.write("window.SOUND_BASE64 = {\n")
        for name in MANIFEST:
            f.write(f"  '{name}': '{b64_map[name]}',\n")
        f.write("};\n")
    # 大小统计
    total = sum(len(v) for v in b64_map.values())
    print("生成完成：")
    print("\n".join(summary))
    print(f"  --- js/sounds.js 总大小 ≈ {total//1024} KB")

if __name__ == '__main__':
    random.seed(7)
    main()

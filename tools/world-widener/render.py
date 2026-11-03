"""Render a WorldWidener dump (ww dump) to PNG, with approximate map colors.

usage: render.py <dump.bin> <out.png> [x0 x1 y0 y1] [--scale N]
"""
import sys
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--")]
scale = 1
if "--scale" in sys.argv:
    scale = int(sys.argv[sys.argv.index("--scale") + 1])
    args = [a for a in args if a != str(scale)]

raw = open(args[0], "rb").read()
w, h = np.frombuffer(raw[:8], dtype="<i4")
rec = np.dtype([("tile", "<u2"), ("wall", "<u2"), ("liq", "u1"), ("ltype", "u1")])
grid = np.frombuffer(raw[8:], dtype=rec).reshape(w, h).transpose()  # [y, x]
x0, x1, y0, y1 = (int(v) for v in args[2:6]) if len(args) >= 6 else (0, w, 0, h)
grid = grid[y0:y1, x0:x1]

COLORS = {
    0: (151, 107, 75), 1: (128, 128, 128), 2: (28, 216, 94), 3: (13, 101, 36), 5: (151, 107, 75),
    6: (140, 101, 80), 7: (150, 67, 22), 8: (185, 164, 23), 9: (185, 194, 195), 166: (163, 95, 60),
    167: (110, 140, 182), 168: (120, 160, 170), 169: (169, 190, 200), 221: (40, 100, 180),
    222: (90, 200, 90), 223: (200, 50, 50), 107: (11, 80, 143), 108: (91, 169, 169), 111: (128, 26, 52),
    23: (141, 137, 223), 25: (98, 95, 167), 112: (74, 67, 109), 163: (180, 160, 230), 398: (90, 80, 150),
    199: (208, 80, 80), 203: (128, 44, 45), 234: (110, 60, 60), 200: (220, 110, 120), 399: (150, 60, 60),
    109: (78, 193, 227), 117: (181, 172, 190), 116: (238, 225, 218), 164: (200, 245, 253), 402: (200, 180, 220),
    53: (186, 168, 84), 112: (74, 67, 109), 397: (180, 160, 100), 396: (190, 150, 92), 151: (200, 170, 100),
    59: (92, 68, 73), 60: (143, 215, 29), 226: (141, 56, 0), 237: (250, 150, 0), 211: (180, 255, 60),
    147: (211, 236, 241), 161: (144, 195, 232), 41: (66, 88, 160), 43: (60, 140, 80), 44: (150, 60, 140),
    57: (85, 75, 70), 58: (200, 40, 40), 75: (40, 40, 40), 76: (110, 40, 40), 189: (220, 230, 255),
    202: (220, 220, 230), 70: (93, 127, 255), 72: (182, 175, 130), 40: (149, 80, 60), 30: (170, 120, 80),
    19: (170, 120, 80), 4: (253, 221, 3), 21: (220, 170, 60), 467: (220, 170, 60), 48: (200, 200, 200),
    225: (255, 160, 30), 229: (255, 200, 50), 230: (255, 200, 50), 368: (100, 100, 100), 367: (200, 200, 200),
    404: (90, 120, 255), 484: (200, 170, 130), 495: (190, 160, 100), 659: (170, 120, 240),
}
img = np.zeros(grid.shape + (3,), dtype=np.uint8)
sky = np.array([135, 190, 255], dtype=np.uint8)
under = np.array([75, 60, 50], dtype=np.uint8)
img[:] = sky
img[grid["wall"] > 0] = under
liq = grid["liq"] > 0
img[liq & (grid["ltype"] == 0)] = (40, 80, 230)
img[liq & (grid["ltype"] == 1)] = (255, 80, 0)
img[liq & (grid["ltype"] == 2)] = (230, 170, 40)
img[liq & (grid["ltype"] == 3)] = (200, 120, 255)
has = grid["tile"] != 0xFFFF
img[has] = (160, 140, 120)
for t, c in COLORS.items():
    img[grid["tile"] == t] = c
img[has & (grid["tile"] >= 693)] = (255, 0, 255)  # modded tiles stand out
im = Image.fromarray(img)
if scale != 1:
    im = im.resize((im.width // scale, im.height // scale), Image.BOX)
im.save(args[1])
print(args[1], im.size)

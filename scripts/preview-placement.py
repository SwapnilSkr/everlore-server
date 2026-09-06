#!/usr/bin/env python3
"""
Preview a landmark sprite on its terrain plate, without touching the app.

    python3 scripts/preview-placement.py marblegate
    python3 scripts/preview-placement.py marblegate --scale .9 --rot -4 --dy 8

Rebuilding the app to judge a 10px nudge costs minutes; this costs a second,
and it composites with the SAME arithmetic the renderer uses:

    draw width = 1122 * 0.16 * scale     (map width x the sprite fraction)
    anchor     = the sprite's centre     (not its base)
    rotation   = degrees CLOCKWISE about that centre

Coordinates are printed in both the plate pixels you can measure on the image
and the normalised x/y the world file wants, so there is no arithmetic left to
get wrong by hand. --grid overlays plate coordinates for measuring a target.

Reads the processed art, so run `bun run assets:process` first if the drop
folder has changed.
"""
import argparse, os, sys
try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('needs Pillow:  python3 -m pip install pillow')

ART = os.path.expanduser('~/Desktop/sample files/sample files for everlore/world assets processed')
MAP_W, PLATE_TOP, MAP_H = 1122, 1870, 5142   # central plate's band in the stitched map
SPRITE_FRACTION = 0.16                        # must match world_map_view.dart

ap = argparse.ArgumentParser()
ap.add_argument('name', help='location id, e.g. marblegate')
ap.add_argument('--plate', default='plate_central')
ap.add_argument('--x', type=float, help='normalised x (default: keep current)')
ap.add_argument('--y', type=float, help='normalised MAP y (default: keep current)')
ap.add_argument('--scale', type=float, default=0.87)
ap.add_argument('--rot', type=float, default=0.0, help='degrees clockwise')
ap.add_argument('--dx', type=float, default=0.0, help='nudge, plate pixels')
ap.add_argument('--dy', type=float, default=0.0, help='nudge, plate pixels')
ap.add_argument('--zoom', type=int, default=3)
ap.add_argument('--grid', action='store_true', help='overlay plate coordinates')
ap.add_argument('--out', default='/tmp/placement.png')
a = ap.parse_args()

plate = Image.open(f'{ART}/{a.plate}.webp').convert('RGBA')
spr = Image.open(f'{ART}/sprite_{a.name}.webp').convert('RGBA')

# normalised map y -> plate pixels, and back
cx = round((a.x if a.x is not None else 0.5508) * MAP_W) + round(a.dx)
cy = round((a.y if a.y is not None else 0.5679) * MAP_H) - PLATE_TOP + round(a.dy)

dw = round(MAP_W * SPRITE_FRACTION * a.scale)
dh = round(dw * spr.height / spr.width)
s = spr.resize((dw, dh), Image.LANCZOS)
if a.rot:
    s = s.rotate(-a.rot, resample=Image.BICUBIC, expand=True)  # PIL turns the other way
plate.alpha_composite(s, (cx - s.width // 2, cy - s.height // 2))

CW, CH = 420, 340
x0 = max(0, min(plate.width - CW, cx - CW // 2))
y0 = max(0, min(plate.height - CH, cy - CH // 2))
view = plate.crop((x0, y0, x0 + CW, y0 + CH)).resize((CW * a.zoom, CH * a.zoom), Image.LANCZOS)

if a.grid:
    d = ImageDraw.Draw(view)
    for X in range(x0, x0 + CW):
        if X % 20 == 0:
            px = (X - x0) * a.zoom
            d.line([(px, 0), (px, CH * a.zoom)], fill=(255, 80, 80) if X % 100 == 0 else (255, 190, 70))
            d.text((px + 2, 4), str(X), fill=(255, 255, 0))
    for Y in range(y0, y0 + CH):
        if Y % 20 == 0:
            py = (Y - y0) * a.zoom
            d.line([(0, py), (CW * a.zoom, py)], fill=(70, 160, 255) if Y % 100 == 0 else (110, 200, 255))
            d.text((4, py + 2), str(Y), fill=(150, 225, 255))

view.convert('RGB').save(a.out)
print(f'drawn {dw}x{dh} at plate ({cx},{cy})  ->  {a.out}')
print(f'world file:  x: {cx / MAP_W:.4f}, y: {(PLATE_TOP + cy) / MAP_H:.4f}, '
      f'scale: {a.scale}, rotation: {a.rot:g}')

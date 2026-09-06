"""
Headless Blender harness: build a landmark parametrically, render it through a
DECLARED camera.

    blender -b --python render_asset.py -- --elevation 58 --yaw 42 --out /tmp/a.png

The camera is the whole point. Iron Verdict's sprites were matched to a camera
that existed only implicitly inside a painting, which is why one gate cost four
regenerations. Here elevation and yaw are inputs, so a landmark cannot be drawn
at the wrong angle — and a sprite that must face a road is a yaw value, not a
new generation.

Orthographic on purpose: the plates read as a flat-projected map, and ortho is
what makes a landmark's angle independent of where it sits on the map. A
perspective camera would need a different render per position.
"""
import bpy, math, sys, os

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return type(default)(argv[argv.index(name) + 1]) if name in argv else default

ELEV   = arg('--elevation', 58.0)   # degrees above the horizon
YAW    = arg('--yaw', 45.0)         # degrees around Z
SUN_AZ = arg('--sun-az', 135.0)     # light direction, degrees
SUN_EL = arg('--sun-el', 50.0)
RES    = arg('--res', 512)
OUT    = arg('--out', '/tmp/render.png')

# ----------------------------------------------------------------- clean slate
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ------------------------------------------------------------------- materials
def mat(name, rgb, rough=0.85):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    return m

STONE = mat('stone', (0.62, 0.52, 0.36))
SLATE = mat('slate', (0.20, 0.21, 0.23), 0.7)

def put(obj, m):
    obj.data.materials.append(m)
    return obj

# ------------------------------------------------- a gatehouse, parametrically
# Two tower drums flanking a curtain wall with an arched opening cut through it.
# This is the shape that beat us as a 2D sprite; as geometry it is ~20 lines.
# NOTE: primitive_cube_add(size=1) spans +/-0.5, so scale is the FULL dimension,
# not the half-extent. Getting that wrong makes the wall half-width and the arch
# boolean eats what is left.
R, H, SPAN, WALL_T, WALL_H = 1.0, 2.6, 3.4, 0.7, 2.2

def tower(x):
    bpy.ops.mesh.primitive_cylinder_add(radius=R, depth=H, location=(x, 0, H / 2))
    drum = put(bpy.context.object, STONE)
    # crenellated cap: a slightly proud ring
    bpy.ops.mesh.primitive_cylinder_add(radius=R * 1.12, depth=0.28, location=(x, 0, H + 0.1))
    put(bpy.context.object, STONE)
    bpy.ops.mesh.primitive_cone_add(radius1=R * 1.1, radius2=0, depth=1.5, location=(x, 0, H + 0.95))
    put(bpy.context.object, SLATE)
    return drum

tower(-SPAN / 2); tower(SPAN / 2)

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WALL_H / 2))
wall = bpy.context.object
wall.scale = (SPAN, WALL_T, WALL_H)
bpy.ops.object.transform_apply(scale=True)
put(wall, STONE)

# the archway: a horizontal cylinder + a box below it, subtracted from the wall
bpy.ops.mesh.primitive_cylinder_add(radius=0.55, depth=WALL_T * 3, location=(0, 0, 1.0),
                                    rotation=(math.pi / 2, 0, 0))
arch = bpy.context.object
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
jamb = bpy.context.object; jamb.scale = (1.1, WALL_T * 3, 1.0)
bpy.ops.object.transform_apply(scale=True)

for cutter in (arch, jamb):
    m = wall.modifiers.new('cut', 'BOOLEAN'); m.operation = 'DIFFERENCE'; m.object = cutter
bpy.context.view_layer.objects.active = wall
for m in list(wall.modifiers):
    bpy.ops.object.modifier_apply(modifier=m.name)
for cutter in (arch, jamb):
    bpy.data.objects.remove(cutter, do_unlink=True)

# ---------------------------------------------------------------------- camera
cam_data = bpy.data.cameras.new('cam'); cam_data.type = 'ORTHO'; cam_data.ortho_scale = 8.0
cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
e, y = math.radians(ELEV), math.radians(YAW)
d = 20
cam.location = (d * math.cos(e) * math.sin(y), -d * math.cos(e) * math.cos(y), d * math.sin(e))
cam.rotation_euler = (math.pi / 2 - e, 0, y)
scene.camera = cam

# ----------------------------------------------------------------------- light
sun_data = bpy.data.lights.new('sun', 'SUN'); sun_data.energy = 4.0
sun_data.angle = math.radians(6)                      # soft-ish contact shadows
sun = bpy.data.objects.new('sun', sun_data); scene.collection.objects.link(sun)
se, sa = math.radians(SUN_EL), math.radians(SUN_AZ)
sun.rotation_euler = (math.pi / 2 - se, 0, sa)

world = bpy.data.worlds.new('w'); world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.38, 0.45, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.5
scene.world = world

# ---------------------------------------------------------------------- render
scene.render.engine = 'BLENDER_EEVEE'
scene.render.film_transparent = True                  # alpha out, no chroma key
scene.render.resolution_x = scene.render.resolution_y = RES
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f'RENDERED {OUT} elev={ELEV} yaw={YAW}')

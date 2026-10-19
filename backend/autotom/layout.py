"""One layout resolver shared by migration, preview and generated simulation geometry."""
import math


def generate_layout(sim, room, settings=None, legacy=False):
    settings = settings or {}
    rows, cols = sim['rows'], sim['plants_per_row']
    dx = settings.get('plant_spacing') or 1 / math.sqrt(sim['density'])
    dy = settings.get('row_spacing') or 1 / math.sqrt(sim['density'])
    center = settings.get('center') or [room['width']/2, room['length']/2, 0]
    yaw = settings.get('rotation', 0)
    angle = math.radians(yaw)
    plants = []
    def add(x, y, role, row, col):
        index = len(plants) + 1
        plants.append(dict(id=f'plant-{index}', name=f'{"Plant" if role == "central" else "Border"} {index}',
            role=role, reporting_id=index if role == 'central' else None,
            position=[center[0]+x*math.cos(angle)-y*math.sin(angle), center[1]+x*math.sin(angle)+y*math.cos(angle), center[2]],
            rotation=[0,0,yaw], enabled=True, row=row+1, col=col+1))
    for row in range(rows):
        for col in range(cols):
            stagger = dx / 2 if settings.get('pattern') == 'staggered' and row % 2 else 0
            add((col-(cols-1)/2)*dx+stagger, (row-(rows-1)/2)*dy, 'central', row, col)
    br, bp = sim['border_rows'], sim['border_plants']
    if legacy:
        # Exact upstream four-loop pattern and iteration order (intentionally asymmetric).
        coordinates = []
        coordinates += [(c, r) for r in range(-br,0) for c in range(cols)]
        coordinates += [(c, r) for r in range(rows,rows+br) for c in range(cols+bp)]
        coordinates += [(c, r) for r in range(-br,rows) for c in range(cols,cols+bp)]
        coordinates += [(c, r) for r in range(-br,rows+br) for c in range(-bp,0)]
    else:
        coordinates = [(c,r) for r in range(-br,rows+br) for c in range(-bp,cols+bp)
                       if not (0 <= c < cols and 0 <= r < rows)]
    for c,r in coordinates:
        stagger = dx/2 if settings.get('pattern') == 'staggered' and r % 2 else 0
        add((c-(cols-1)/2)*dx+stagger, (r-(rows-1)/2)*dy, 'border', r,c)
    return dict(mode='preset', pattern=settings.get('pattern','grid'), plant_spacing=settings.get('plant_spacing'),
                row_spacing=settings.get('row_spacing'), center=center, rotation=yaw, plants=plants,
                next_reporting_id=rows*cols+1)

"""Normalize GroIMP 2.2's X,Z,Y vertex-colour OBJ to Z-up OBJ + MTL."""
from pathlib import Path


def normalize_obj(source: Path, target: Path):
    vertices = []
    records = []
    materials = {}
    active = None
    with source.open() as stream:
        for line in stream:
            fields = line.split()
            if not fields:
                continue
            if fields[0] == "v":
                x, z, y = fields[1:4]
                color = tuple(float(v) for v in fields[4:7]) if len(fields) >= 7 else (0.5, 0.7, 0.3)
                vertices.append(color)
                records.append(f"v {x} {y} {z}\n")
            elif fields[0] == "vn":
                records.append(f"vn {fields[1]} {fields[3]} {fields[2]}\n")
            elif fields[0] == "f":
                indices = [int(v.split('/')[0]) for v in fields[1:]]
                colors = [vertices[i-1] if i > 0 else vertices[i] for i in indices]
                rgb = tuple(round(sum(c[i] for c in colors) / len(colors), 6) for i in range(3))
                if rgb not in materials:
                    materials[rgb] = f"surface_{len(materials)+1}"
                name = materials[rgb]
                if active != name:
                    records.append(f"usemtl {name}\n")
                    active = name
                # Swapping Y/Z is a reflection, so reverse winding as well.
                records.append("f " + " ".join(reversed(fields[1:])) + "\n")
            elif fields[0] not in ("mtllib", "usemtl"):
                records.append(line)
    if not vertices or not materials:
        raise ValueError(f"GroIMP exported an empty scene: {source.name}")
    target.write_text(f"# AutoTom: metres, Z-up. Source: GroIMP 2.2\nmtllib {target.stem}.mtl\n" + "".join(records))
    target.with_suffix(".mtl").write_text("# GroIMP vertex colours converted to materials\n" + "\n".join(
        f"newmtl {name}\nKd {rgb[0]} {rgb[1]} {rgb[2]}\nKa 0.05 0.05 0.05\nNs 8\nillum 2\n"
        for rgb, name in materials.items()))

from autotom.geometry import normalize_obj


def test_export_preserves_world_coordinates_colours_and_orientation(tmp_path):
    source, target = tmp_path / "source.obj", tmp_path / "plants.obj"
    # GroIMP exporter writes X,Z,Y; vertex colours are not standard OBJ materials.
    source.write_text("v 1 3 2 0.2 0.6 0.1\nv 2 3 2 0.2 0.6 0.1\nv 1 4 2 0.2 0.6 0.1\nf 1 2 3\n")
    normalize_obj(source, target)
    result = target.read_text()
    assert "v 1 2 3" in result
    assert "f 3 2 1" in result
    assert "mtllib plants.mtl" in result
    assert "usemtl surface_1" in result
    assert "Kd 0.2 0.6 0.1" in target.with_suffix(".mtl").read_text()

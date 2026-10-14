import type { GameModelMesh } from '../core/game-assets';
type Vertex = GameModelMesh['vertices'][number];
/** Clip in source space, retaining original UV/color interpolation at timeline cuts. */
export function clipNativeMeshZ(mesh: Pick<GameModelMesh, 'vertices' | 'indices'>, near: number, far: number) {
  const vertices: Vertex[] = [],
    indices: number[] = [];
  const mix = (a: Vertex, b: Vertex, t: number): Vertex => {
    const vector = (x: readonly number[], y: readonly number[]) => x.map((value, i) => value + (y[i] - value) * t);
    return {
      position: vector(a.position, b.position) as Vertex['position'],
      uv: vector(a.uv, b.uv) as Vertex['uv'],
      uv2: a.uv2 && b.uv2 ? (vector(a.uv2, b.uv2) as Vertex['uv2']) : undefined,
      color: vector(a.color, b.color) as Vertex['color'],
    };
  };
  for (let i = 0; i < mesh.indices.length; i += 3) {
    let polygon = mesh.indices.slice(i, i + 3).map(index => mesh.vertices[index]);
    for (const [edge, sign] of [
      [near, 1],
      [far, -1],
    ]) {
      const output: Vertex[] = [];
      for (let j = 0; j < polygon.length; j++) {
        const a = polygon[j],
          b = polygon[(j + 1) % polygon.length];
        const da = (a.position[2] - edge) * sign,
          db = (b.position[2] - edge) * sign;
        if (da >= 0) output.push(a);
        if (da >= 0 !== db >= 0) output.push(mix(a, b, da / (da - db)));
      }
      polygon = output;
    }
    const offset = vertices.length;
    vertices.push(...polygon);
    for (let j = 2; j < polygon.length; j++) indices.push(offset, offset + j - 1, offset + j);
  }
  return { vertices, indices };
}

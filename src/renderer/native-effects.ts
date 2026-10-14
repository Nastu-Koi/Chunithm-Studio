import type { GameTexture, GameTextures } from '../core/game-assets';
import {
  effectLifetime,
  effectResourceIndices,
  sampleNativeEffect,
  selectNativeEffects,
  type NativeEffectMaterialSample,
} from '../core/game-effects';
import { GameMeshRenderer, type MeshPaint } from './game-mesh-renderer';
import { projectNativeNotePoint } from './native-notes';
import type { NoteEffectEvent } from './note-effects';

// Original bomb root offsets, table 0x1c1e788 applied at 0xc405ee. The shared
// original judgement Z=-65 is already the preview projection's local Z=0.
const bombDepth: Record<string, number> = {
  Air: -30,
  AirDown: -30,
  AirHoldIn: -40,
  AirHold: -40,
  AirSlide: -40,
  AirAction: -40,
  Mine: -40,
};

/** Uses copied AFNC programs and images. The explicit preview timebase is 60 units/s. */
export class NativeNoteEffects {
  readonly diagnostics = new Set<string>();
  readonly lifetime: number;
  private images = new Map<string, HTMLImageElement>();
  private selections = new Map<string, ReturnType<typeof selectNativeEffects>>();
  private constructor(private assets: GameTextures) {
    const durations = Object.values(assets.effectPrograms ?? {})
      .filter(p => p.program.nodes.find(n => n.parent === null)?.states.some(s => s.id === 0))
      .map(p => effectLifetime(p, 0))
      .filter((value): value is number => value !== null);
    this.lifetime = Math.max(0, ...durations) / 60;
    this.diagnostics.add('原始打击动画使用 60 内部单位/秒的预览基准与固定随机种子，尚未与运行中的游戏时钟校准。');
  }
  static async load(
    assets: GameTextures,
    decode: (texture: GameTexture) => Promise<HTMLImageElement | undefined>,
  ): Promise<NativeNoteEffects> {
    const renderer = new NativeNoteEffects(assets);
    const referencedIds = new Set(assets.effectTables?.notes.flatMap(row => row.values) ?? []);
    const referenced = new Set(
      assets.effectTables?.acroarts
        .filter(row => referencedIds.has(row.id))
        .map(row => row.filename.replace(/\.afb$/i, '')),
    );
    for (const [source, textures] of Object.entries(assets.effects)) {
      const effect = assets.effectPrograms?.[source];
      if (
        !effect ||
        !referenced.has(source) ||
        !effect.program.nodes.find(n => n.parent === null)?.states.some(s => s.id === 0)
      )
        continue;
      const resources = new Set(
        effectResourceIndices(effect, 0).map(index =>
          effect.resources.find(r => r.index === index)?.name.toLowerCase(),
        ),
      );
      await Promise.all(
        textures
          .filter(texture => resources.has(texture.sourceName.toLowerCase()))
          .map(async texture => {
            const image = await decode(texture);
            if (image) renderer.images.set(`${source}:${texture.sourceName.toLowerCase()}`, image);
            else renderer.diagnostics.add(`${source}: 无法解码 ${texture.sourceName}`);
          }),
      );
    }
    return renderer;
  }
  draw(
    layer: GameMeshRenderer,
    event: NoteEffectEvent,
    age: number,
    speed: number,
    keep = false,
    budget = 4096,
  ): number {
    if (!layer.active || !this.assets.effectTables || !this.assets.effectPrograms || budget < 1) return 0;
    const width = Math.max(1, Math.min(16, Math.ceil(event.width))),
      key = `${event.kind}:${width}`;
    let selection = this.selections.get(key);
    if (!selection) {
      selection = selectNativeEffects(this.assets.effectTables, event.kind, width);
      this.selections.set(key, selection);
      for (const message of selection.diagnostics) this.diagnostics.add(message);
    }
    const references = keep
      ? [['keep', selection.keep] as const]
      : ([
          ['bomb', selection.bomb],
          ['reaction', selection.reaction],
          ['text', selection.text],
        ] as const);
    let drawn = 0;
    for (const [role, reference] of references) {
      if (drawn >= budget) break;
      if (!reference) continue;
      const effect = this.assets.effectPrograms[reference.sourceName];
      if (!effect) {
        this.diagnostics.add(`${reference.sourceName}: 原始动画程序未载入`);
        continue;
      }
      if (!effect.program.nodes.find(n => n.parent === null)?.states.some(s => s.id === 0)) {
        this.diagnostics.add(`${reference.sourceName}: 原始动画没有当前预览使用的判定分支`);
        continue;
      }
      const lifetime = effectLifetime(effect, 0);
      if (!keep && lifetime === null) {
        this.diagnostics.add(`${reference.sourceName}: 未确认结束时间，未执行一次性打击效果`);
        continue;
      }
      if (lifetime !== null && age * 60 >= lifetime) continue;
      let sample: ReturnType<typeof sampleNativeEffect>;
      try {
        sample = sampleNativeEffect(effect, age * 60, 0, event.seed, { particleLimit: Math.min(512, budget - drawn) });
      } catch (error) {
        this.diagnostics.add(`${reference.sourceName}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      for (const message of sample.diagnostics) this.diagnostics.add(`${reference.sourceName}: ${message}`);
      const xScale = role === 'bomb' ? selection.scaleX : 1;
      const zOffset = role === 'bomb' ? (bombDepth[event.kind] ?? 0) : 0;
      const project = (p: readonly number[]) =>
        projectNativeNotePoint(event.lane + event.width / 2, 0, [p[0] * xScale, p[1] + event.y, p[2] + zOffset], speed);
      const material = (value: NativeEffectMaterialSample): MeshPaint | undefined => {
        const name = effect.resources.find(r => r.index === value.resources[0])?.name;
        const image = name && this.images.get(`${effect.sourceName}:${name.toLowerCase()}`);
        if (!image) {
          this.diagnostics.add(`${effect.sourceName}: 动画纹理 ${name ?? value.resources[0]} 缺失`);
          return;
        }
        return {
          image,
          color: value.color,
          blendSource: value.blendSource,
          blendDestination: value.blendDestination,
          blendOperation: value.blendOperation,
          blendEnabled: value.blendEnabled,
          alphaCutoff: 0.0001,
          wrap: value.wrap ?? [2, 2],
        };
      };
      for (const plane of sample.planes) {
        if (drawn >= budget) break;
        const paint = material(plane.material);
        if (!paint) continue;
        const [u0, v0, u1, v1] = plane.uv,
          uv = [
            [u0, v0],
            [u0, v1],
            [u1, v1],
            [u1, v0],
          ];
        layer.mesh(
          plane.positions.map((p, i) => ({ ...project(p), uv: uv[i] })),
          [0, 1, 2, 0, 2, 3],
          paint,
        );
        drawn++;
      }
      for (const particle of sample.particles) {
        if (drawn >= budget) break;
        const paint = material(particle.material);
        if (!paint) continue;
        const matrix = particle.world,
          p = particle.position;
        const center = [0, 1, 2].map(
          r => matrix[r] * p[0] + matrix[r + 4] * p[1] + matrix[r + 8] * p[2] + matrix[r + 12],
        );
        const norm = (v: number[]) => {
          const l = Math.hypot(...v);
          return l ? v.map(n => n / l) : [0, 1, 0];
        };
        const length = Math.hypot(54, 190.5),
          sine = 54 / length,
          cosine = 190.5 / length;
        let right = [matrix[0], matrix[1], matrix[2]],
          up = [matrix[4], matrix[5], matrix[6]];
        if (particle.billboard === 1) {
          right = [1, 0, 0];
          up = [0, cosine, -sine];
        } else if (particle.billboard === 2) {
          up = norm(up);
          right = norm([up[1] * cosine - up[2] * sine, -up[0] * cosine, up[0] * sine]);
        } else if (particle.billboard !== 0) {
          this.diagnostics.add(`未确认的原生粒子朝向模式 ${particle.billboard}`);
          continue;
        }
        const [u0, v0, u1, v1] = particle.uv,
          uv = [
            [u0, v0],
            [u0, v1],
            [u1, v1],
            [u1, v0],
          ];
        layer.mesh(
          particle.offsets.map(([x, y], i) => ({
            ...project(center.map((v, axis) => v + right[axis] * x + up[axis] * y)),
            uv: uv[i],
            color: particle.color,
          })),
          [0, 1, 2, 0, 2, 3],
          paint,
        );
        drawn++;
      }
    }
    return drawn;
  }
}

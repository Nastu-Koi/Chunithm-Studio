import {
  ArrowUp,
  ArrowUpRight,
  AudioLines,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Columns3,
  Copy,
  Diamond,
  DiamondPlus,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  ImagePlus,
  Link2,
  LocateFixed,
  Maximize,
  MonitorPlay,
  MousePointer2,
  Music,
  PanelRight,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  SkipBack,
  SlidersHorizontal,
  Spline,
  Square,
  TriangleAlert,
  Undo2,
  Volume2,
  type IconNode,
} from 'lucide';

/** One Lucide icon as inline SVG markup; it takes the text colour and scales with the font size. */
function svg(node: IconNode): string {
  const shapes = node
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .map(([name, value]) => `${name}="${value}"`)
          .join(' ')}/>`,
    )
    .join('');
  return `<svg class="icon" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
}

/** Every icon the interface uses, named by what it stands for in this program. */
export const ICON = {
  select: svg(MousePointer2),
  erase: svg(Eraser),
  copy: svg(Copy),
  paste: svg(ClipboardPaste),
  mirror: svg(FlipHorizontal2),
  flip: svg(FlipVertical2),
  align: svg(AudioLines),
  advanced: svg(SlidersHorizontal),
  cursor: svg(LocateFixed),
  inspector: svg(PanelRight),
  shape: svg(Spline),
  connect: svg(Link2),
  insertNode: svg(DiamondPlus),
  node: svg(Diamond),
  up: svg(ArrowUp),
  add: svg(Plus),
  undo: svg(Undo2),
  redo: svg(Redo2),
  open: svg(ArrowUpRight),
  music: svg(Music),
  editView: svg(Columns3),
  playView: svg(MonitorPlay),
  ok: svg(Check),
  done: svg(CircleCheck),
  error: svg(CircleAlert),
  warning: svg(TriangleAlert),
  fullscreen: svg(Maximize),
  restart: svg(SkipBack),
  play: svg(Play),
  pause: svg(Pause),
  stop: svg(Square),
  loop: svg(Repeat),
  volume: svg(Volume2),
  image: svg(ImagePlus),
};

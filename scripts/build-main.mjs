import { build } from 'esbuild';
await build({ entryPoints: ['src/backend/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/main.cjs', external: ['electron', 'sharp', 'ffmpeg-static'] });
await build({ entryPoints: ['src/backend/preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/preload.cjs', external: ['electron'] });

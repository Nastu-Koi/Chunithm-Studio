import { readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';

// The files the packaged app loads at run time, relative to the repository root. Everything else stays out of the package:
// listing what belongs, instead of what does not, keeps a new top-level directory (such as release/) from slipping in.
const PACKAGED = ['package.json', 'dist', 'dist-electron', 'node_modules', 'assets', 'native/win-x64'];

// @electron/packager applies these exclusions itself only when `ignore` is a list of patterns, not a function.
// The command links in node_modules/.bin point at development packages that pruning removes; the other dot entries there are caches.
const LEFT_OUT = /(^|\/)node_modules\/\.[^/]+($|\/)|(^|\/)node_gyp_bins($|\/)|(^|\/)\.git($|\/)|\.o(bj)?$/;

/** Whether a path as @electron/packager reports it ('' for the root, then '/dir/file') belongs in the package. */
export function isPackagedPath(file) {
  const relative = file.replaceAll('\\', '/').replace(/^\//, '');
  if (LEFT_OUT.test(relative)) return false;
  return (
    !relative ||
    PACKAGED.some(entry => relative === entry || relative.startsWith(`${entry}/`) || entry.startsWith(`${relative}/`))
  );
}

/** Delete every empty folder below `dir`, deepest first, so a folder holding only empty folders goes too; `dir` itself stays. */
export async function removeEmptyDirectories(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    await removeEmptyDirectories(child);
    if (!(await readdir(child)).length) await rmdir(child);
  }
}

/** Every symbolic link or junction below `dir`, without following any of them. */
export async function findLinks(dir) {
  const links = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) links.push(child);
    else if (entry.isDirectory()) links.push(...(await findLinks(child)));
  }
  return links;
}

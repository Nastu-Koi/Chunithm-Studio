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
  return !relative || PACKAGED.some(entry => relative === entry || relative.startsWith(`${entry}/`) || entry.startsWith(`${relative}/`));
}

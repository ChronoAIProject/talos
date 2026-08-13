import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when the module at `importMetaUrl` is the process entrypoint.
 *
 * Node resolves the ESM entrypoint to its real path, while process.argv[1]
 * keeps the path the user invoked — for a symlinked binary (the installer
 * links ~/.local/bin/talos-worker to the versioned bundle) the two differ,
 * so the comparison must resolve symlinks first.
 */
export const isMainModule = (importMetaUrl: string, argv1: string | undefined): boolean => {
  if (argv1 === undefined) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
};

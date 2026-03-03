import { isAbsolute, relative, resolve, sep } from 'node:path';

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function isInsideProject(projectRoot: string, absolutePath: string): boolean {
  const relPath = relative(projectRoot, absolutePath);
  return relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath));
}

/**
 * Format a path for prompt output:
 * - inside project root -> ./relative/path
 * - outside project root -> absolute/path
 */
export function formatPromptPath(projectPath: string, pathValue: string): string {
  const projectRoot = resolve(projectPath);
  const resolvedPath = isAbsolute(pathValue)
    ? resolve(pathValue)
    : resolve(projectRoot, pathValue);

  if (isInsideProject(projectRoot, resolvedPath)) {
    const relPath = toPosixPath(relative(projectRoot, resolvedPath));
    return relPath.length === 0 ? './' : `./${relPath}`;
  }

  return toPosixPath(resolvedPath);
}

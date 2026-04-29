/**
 * node-fs.ts — Node.js adapter implementing the FileSystem interface.
 *
 * This is the only file that imports `fs` and `path` from Node.
 * It bridges the platform-agnostic dep-graph core with the real filesystem.
 */

import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as ts from 'typescript';
import type { FileSystem } from './dep-graph.js';
import * as p from './path.js';

/**
 * Convert a native OS path to the canonical posix-style used internally.
 * On Windows this turns backslashes into forward slashes.
 * On posix systems this is essentially a no-op.
 */
function toPosix(fsPath: string): string {
  return fsPath.split(nodePath.sep).join('/');
}

/** Entry returned by readDir — mirrors the subset of Dirent we need. */
interface FsEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/**
 * Create a FileSystem backed by Node's `fs` module.
 */
export function createNodeFileSystem(): FileSystem {
  return {
    readFile(filePath: string): string {
      return nodeFs.readFileSync(filePath, 'utf-8');
    },

    fileExists(filePath: string): boolean {
      try {
        return nodeFs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    },

    directoryExists(dirPath: string): boolean {
      try {
        return nodeFs.statSync(dirPath).isDirectory();
      } catch {
        return false;
      }
    },

    readDir(dirPath: string): { name: string; isDirectory: boolean; isFile: boolean }[] {
      try {
        const entries = nodeFs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
        }));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Parse a tsconfig.json and extract path aliases.
 * This lives here (not in dep-graph.ts) because it uses the TS compiler API's
 * readConfigFile which needs `ts.sys.readFile` — a Node-specific API.
 *
 * Returns aliases in posix-style absolute paths.
 */
export function loadAliasesFromTsconfig(
  tsconfigPath: string,
  root: string
): Record<string, string> {
  const aliases: Record<string, string> = {};
  try {
    const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      nodePath.dirname(tsconfigPath)
    );
    const paths = parsed.options.paths;
    const baseUrl = parsed.options.baseUrl || '.';
    const resolvedBase = toPosix(
      nodePath.resolve(nodePath.dirname(tsconfigPath), baseUrl)
    );

    if (paths) {
      for (const [pattern, targets] of Object.entries(paths)) {
        if (targets.length === 0) continue;
        const alias = pattern.replace(/\/\*$/, '');
        const target = targets[0].replace(/\/\*$/, '');
        aliases[alias] = p.resolve(resolvedBase, target);
      }
    }
  } catch {
    // tsconfig not parseable — silently skip
  }
  return aliases;
}

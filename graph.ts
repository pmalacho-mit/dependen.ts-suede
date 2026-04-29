/**
 * dep-graph — Dependency graph builder for TypeScript + Svelte codebases.
 *
 * Platform-agnostic: no direct Node.js `fs` or `path` imports.
 * Filesystem access is injected via the `FileSystem` interface in BuildOptions.
 * Path operations use the built-in posix-style `./path.ts` utilities.
 *
 * Usage (Node):
 *   import { buildDependencyGraph, getDownstream, findAllReferences } from './dep-graph';
 *   import { createNodeFileSystem, loadAliasesFromTsconfig } from './node-fs';
 *
 *   const graph = await buildDependencyGraph('./src', {
 *     fs: createNodeFileSystem(),
 *     aliases: loadAliasesFromTsconfig('./tsconfig.json', './'),
 *   });
 *
 * Usage (Browser / virtual FS):
 *   const graph = await buildDependencyGraph('/project', {
 *     fs: myVirtualFileSystem,
 *     aliases: { '$lib': '/project/src/lib' },
 *   });
 */

import * as ts from 'typescript';
import * as p from './path.js';

// ---------------------------------------------------------------------------
// FileSystem interface — the only I/O contract the core needs
// ---------------------------------------------------------------------------

export interface FileSystem {
  /** Read the full text content of a file. Throw if not found. */
  readFile(filePath: string): string;
  /** Return true if `filePath` exists and is a file. */
  fileExists(filePath: string): boolean;
  /** Return true if `dirPath` exists and is a directory. */
  directoryExists(dirPath: string): boolean;
  /** List entries in a directory. */
  readDir(dirPath: string): { name: string; isDirectory: boolean; isFile: boolean }[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single import edge from one file to another. */
export interface ImportEdge {
  /** Absolute path of the file being imported */
  target: string;
  /** The raw import specifier as written in source (e.g. '../utils/math') */
  specifier: string;
  /** Named bindings pulled in (empty for side-effect or namespace imports) */
  names: string[];
  /** Whether this is a type-only import (`import type { ... }`) */
  typeOnly: boolean;
  /** Whether this came from a dynamic `import()` expression */
  dynamic: boolean;
}

/** Per-file metadata stored in the graph. */
export interface FileNode {
  /** Absolute file path */
  filePath: string;
  /** Relative path from the project root (for display) */
  relativePath: string;
  /** Files this file imports (forward edges) */
  imports: ImportEdge[];
  /** Files that import this file (reverse edges — populated after full traversal) */
  importedBy: ImportEdge[];
  /** Symbols exported from this file */
  exports: ExportInfo[];
}

export interface ExportInfo {
  name: string; // 'default' for default exports
  isType: boolean;
  /** If this is a re-export, the source file it originates from */
  reExportSource?: string;
}

export interface DependencyGraph {
  /** Map from absolute file path → FileNode */
  nodes: Map<string, FileNode>;
  /** The root directory that was scanned */
  root: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** The filesystem implementation to use (required). */
  fs: FileSystem;
  /** Directory names to exclude (default: ['node_modules', '.svelte-kit', 'dist', 'build', '.git']) */
  exclude?: string[];
  /** File extensions to process (default: ['.ts', '.tsx', '.js', '.jsx', '.svelte']) */
  extensions?: string[];
  /** Path aliases (e.g. { '$lib': '/abs/path/to/src/lib', '@': '/abs/path/to/src' }) */
  aliases?: Record<string, string>;
  /** Whether to follow type-only imports (default: true) */
  includeTypeImports?: boolean;
  /** Whether to follow dynamic import() calls (default: true) */
  includeDynamicImports?: boolean;
}

const DEFAULT_EXCLUDE = ['node_modules', '.svelte-kit', 'dist', 'build', '.git'];
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.svelte'];

// ---------------------------------------------------------------------------
// Helpers — file discovery
// ---------------------------------------------------------------------------

function shouldExclude(filePath: string, excludes: string[]): boolean {
  const parts = filePath.split('/');
  return excludes.some((ex) => parts.includes(ex));
}

/** Recursively collect all matching files under `dir`. */
function collectFiles(
  dir: string,
  extensions: string[],
  excludes: string[],
  fs: FileSystem
): string[] {
  const results: string[] = [];
  const entries = fs.readDir(dir);

  for (const entry of entries) {
    const fullPath = p.join(dir, entry.name);
    if (shouldExclude(fullPath, excludes)) continue;

    if (entry.isDirectory) {
      results.push(...collectFiles(fullPath, extensions, excludes, fs));
    } else if (entry.isFile && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers — resolve import specifiers to absolute file paths
// ---------------------------------------------------------------------------

/** Try common extension/index resolution like Node does. */
function tryResolve(basePath: string, extensions: string[], fs: FileSystem): string | null {
  // Exact match
  if (fs.fileExists(basePath)) return basePath;

  // Try appending extensions
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (fs.fileExists(withExt)) return withExt;
  }

  // Try as directory with index file
  if (fs.directoryExists(basePath)) {
    for (const ext of extensions) {
      const indexFile = p.join(basePath, `index${ext}`);
      if (fs.fileExists(indexFile)) return indexFile;
    }
  }

  return null;
}

function resolveAliases(
  specifier: string,
  aliases: Record<string, string>
): string | null {
  for (const [alias, target] of Object.entries(aliases)) {
    // Exact match: '$lib' → '/abs/src/lib'
    if (specifier === alias) {
      return target;
    }
    // Prefix match: '$lib/foo' → '/abs/src/lib/foo'
    const prefix = alias.endsWith('/') ? alias : alias + '/';
    if (specifier.startsWith(prefix)) {
      const remainder = specifier.slice(prefix.length);
      return p.join(target, remainder);
    }
  }
  return null;
}

function resolveSpecifier(
  specifier: string,
  fromFile: string,
  extensions: string[],
  aliases: Record<string, string>,
  fs: FileSystem
): string | null {
  const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
  const isAliased = Object.keys(aliases).some(
    (a) => specifier === a || specifier.startsWith(a.endsWith('/') ? a : a + '/')
  );

  if (!isRelative && !isAliased) return null;

  let basePath: string;
  if (isAliased) {
    const resolved = resolveAliases(specifier, aliases);
    if (!resolved) return null;
    basePath = resolved;
  } else {
    basePath = p.resolve(p.dirname(fromFile), specifier);
  }

  return tryResolve(basePath, extensions, fs);
}

// ---------------------------------------------------------------------------
// Parsing — TypeScript / JavaScript
// ---------------------------------------------------------------------------

interface ParsedImports {
  imports: Omit<ImportEdge, 'target'>[];
  exports: ExportInfo[];
}

function parseTS(filePath: string, source: string): ParsedImports {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports: Omit<ImportEdge, 'target'>[] = [];
  const exports: ExportInfo[] = [];

  function visit(node: ts.Node) {
    // --- Import declarations ---
    if (ts.isImportDeclaration(node)) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = !!(node.importClause?.isTypeOnly);
      const names: string[] = [];

      if (node.importClause) {
        if (node.importClause.name) {
          names.push(node.importClause.name.text);
        }
        const bindings = node.importClause.namedBindings;
        if (bindings) {
          if (ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              names.push(el.name.text);
            }
          } else if (ts.isNamespaceImport(bindings)) {
            names.push(`* as ${bindings.name.text}`);
          }
        }
      }

      imports.push({ specifier, names, typeOnly, dynamic: false });
    }

    // --- Dynamic import() ---
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({
        specifier: (node.arguments[0] as ts.StringLiteral).text,
        names: [],
        typeOnly: false,
        dynamic: true,
      });
    }

    // --- Export declarations ---
    if (ts.isExportDeclaration(node)) {
      const isType = node.isTypeOnly;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          exports.push({ name: el.name.text, isType: !!isType });
        }
      }
      if (node.moduleSpecifier) {
        const reExportSpec = (node.moduleSpecifier as ts.StringLiteral).text;
        imports.push({ specifier: reExportSpec, names: [], typeOnly: !!isType, dynamic: false });
      }
    }

    // Named export: export const/function/class/enum
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
      const mods = ts.getModifiers(node);
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const name = node.name?.text || 'default';
        const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        exports.push({ name: isDefault ? 'default' : name, isType: false });
      }
    }

    if (ts.isVariableStatement(node)) {
      const mods = ts.getModifiers(node);
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            exports.push({ name: decl.name.text, isType: false });
          }
        }
      }
    }

    // export default expression
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      exports.push({ name: 'default', isType: false });
    }

    // Type exports: export type / export interface
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const mods = ts.getModifiers(node);
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exports.push({ name: node.name.text, isType: true });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { imports, exports };
}

// ---------------------------------------------------------------------------
// Parsing — Svelte
// ---------------------------------------------------------------------------

function parseSvelte(filePath: string, source: string): ParsedImports {
  const scriptRegex = /<script(?:\s+[^>]*)?>([^]*?)<\/script>/gi;
  const allImports: Omit<ImportEdge, 'target'>[] = [];
  const allExports: ExportInfo[] = [];

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(source)) !== null) {
    const scriptContent = match[1];
    const tagAttrs = match[0].slice(0, match[0].indexOf('>'));
    const isTS =
      /lang\s*=\s*["']ts["']/.test(tagAttrs) ||
      /lang\s*=\s*["']typescript["']/.test(tagAttrs);

    const ext = isTS ? '.ts' : '.js';
    const virtualPath = filePath + ext;
    const parsed = parseTS(virtualPath, scriptContent);
    allImports.push(...parsed.imports);
    allExports.push(...parsed.exports);
  }

  if (!allExports.some((e) => e.name === 'default')) {
    allExports.push({ name: 'default', isType: false });
  }

  return { imports: allImports, exports: allExports };
}

// ---------------------------------------------------------------------------
// Core — Build graph
// ---------------------------------------------------------------------------

export async function buildDependencyGraph(
  rootDir: string,
  options: BuildOptions
): Promise<DependencyGraph> {
  const fs = options.fs;
  const root = p.normalize(rootDir);
  const excludes = options.exclude ?? DEFAULT_EXCLUDE;
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const includeType = options.includeTypeImports ?? true;
  const includeDynamic = options.includeDynamicImports ?? true;
  const aliases: Record<string, string> = { ...(options.aliases ?? {}) };

  // SvelteKit convention: auto-add $lib if not already aliased
  if (!aliases['$lib']) {
    const libPath = p.join(root, 'src', 'lib');
    if (fs.directoryExists(libPath)) {
      aliases['$lib'] = libPath;
    }
  }

  // Discover all source files
  const allFiles = collectFiles(root, extensions, excludes, fs);
  const graph: DependencyGraph = { nodes: new Map(), root };

  // Phase 1: Parse every file, extract imports & exports
  for (const filePath of allFiles) {
    const source = fs.readFile(filePath);
    const isSvelte = filePath.endsWith('.svelte');
    const parsed = isSvelte ? parseSvelte(filePath, source) : parseTS(filePath, source);

    const resolvedImports: ImportEdge[] = [];
    for (const imp of parsed.imports) {
      if (!includeType && imp.typeOnly) continue;
      if (!includeDynamic && imp.dynamic) continue;

      const resolved = resolveSpecifier(imp.specifier, filePath, extensions, aliases, fs);
      if (resolved) {
        resolvedImports.push({ ...imp, target: resolved });
      }
    }

    const node: FileNode = {
      filePath,
      relativePath: p.relative(root, filePath),
      imports: resolvedImports,
      importedBy: [],
      exports: parsed.exports,
    };
    graph.nodes.set(filePath, node);
  }

  // Phase 2: Populate reverse edges (importedBy)
  for (const [, node] of graph.nodes) {
    for (const edge of node.imports) {
      const targetNode = graph.nodes.get(edge.target);
      if (targetNode) {
        targetNode.importedBy.push({
          target: node.filePath,
          specifier: edge.specifier,
          names: edge.names,
          typeOnly: edge.typeOnly,
          dynamic: edge.dynamic,
        });
      }
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Queries — Downstream (what is affected if this file changes?)
// ---------------------------------------------------------------------------

export function getDownstream(graph: DependencyGraph, filePath: string): string[] {
  const abs = p.resolve(graph.root, filePath);
  const enqueued = new Set<string>([abs]);
  const queue: string[] = [abs];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = graph.nodes.get(current);
    if (!node) continue;

    for (const edge of node.importedBy) {
      if (!enqueued.has(edge.target)) {
        enqueued.add(edge.target);
        result.push(p.relative(graph.root, edge.target));
        queue.push(edge.target);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Queries — Upstream (what does this file depend on?)
// ---------------------------------------------------------------------------

export function getUpstream(graph: DependencyGraph, filePath: string): string[] {
  const abs = p.resolve(graph.root, filePath);
  const enqueued = new Set<string>([abs]);
  const queue: string[] = [abs];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = graph.nodes.get(current);
    if (!node) continue;

    for (const edge of node.imports) {
      if (!enqueued.has(edge.target)) {
        enqueued.add(edge.target);
        result.push(p.relative(graph.root, edge.target));
        queue.push(edge.target);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Queries — Find all references to a specific export
// ---------------------------------------------------------------------------

export function findAllReferences(
  graph: DependencyGraph,
  filePath: string,
  exportName?: string
): { file: string; importedAs: string; isDynamic: boolean; isTypeOnly: boolean }[] {
  const abs = p.resolve(graph.root, filePath);
  const results: { file: string; importedAs: string; isDynamic: boolean; isTypeOnly: boolean }[] = [];
  const visited = new Set<string>();

  const queue: { file: string; symbolName: string | undefined }[] = [
    { file: abs, symbolName: exportName },
  ];

  while (queue.length > 0) {
    const { file: current, symbolName } = queue.shift()!;
    const key = `${current}::${symbolName ?? '*'}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const node = graph.nodes.get(current);
    if (!node) continue;

    for (const edge of node.importedBy) {
      const matchesSymbol =
        !symbolName || edge.names.length === 0 || edge.names.includes(symbolName);

      if (matchesSymbol) {
        results.push({
          file: p.relative(graph.root, edge.target),
          importedAs: symbolName ?? '*',
          isDynamic: edge.dynamic,
          isTypeOnly: edge.typeOnly,
        });

        const importerNode = graph.nodes.get(edge.target);
        if (importerNode) {
          const reExports = importerNode.exports.filter(
            (exp) => !symbolName || exp.name === symbolName
          );
          if (reExports.length > 0) {
            queue.push({ file: edge.target, symbolName });
          }
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Queries — Detect circular dependencies
// ---------------------------------------------------------------------------

export function findCircularDependencies(graph: DependencyGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(filePath: string) {
    if (inStack.has(filePath)) {
      const cycleStart = stack.indexOf(filePath);
      const cycle = stack.slice(cycleStart).map((f) => p.relative(graph.root, f));
      cycle.push(p.relative(graph.root, filePath));
      cycles.push(cycle);
      return;
    }
    if (visited.has(filePath)) return;

    visited.add(filePath);
    inStack.add(filePath);
    stack.push(filePath);

    const node = graph.nodes.get(filePath);
    if (node) {
      for (const edge of node.imports) {
        dfs(edge.target);
      }
    }

    stack.pop();
    inStack.delete(filePath);
  }

  for (const filePath of graph.nodes.keys()) {
    dfs(filePath);
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Serialization — for tooling / CI integration
// ---------------------------------------------------------------------------

export interface SerializedGraph {
  root: string;
  files: {
    path: string;
    imports: { target: string; names: string[]; typeOnly: boolean; dynamic: boolean }[];
    exports: ExportInfo[];
  }[];
}

export function serializeGraph(graph: DependencyGraph): SerializedGraph {
  const files: SerializedGraph['files'] = [];

  for (const [, node] of graph.nodes) {
    files.push({
      path: node.relativePath,
      imports: node.imports.map((e) => ({
        target: p.relative(graph.root, e.target),
        names: e.names,
        typeOnly: e.typeOnly,
        dynamic: e.dynamic,
      })),
      exports: node.exports,
    });
  }

  return { root: graph.root, files };
}

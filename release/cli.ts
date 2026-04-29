#!/usr/bin/env node
/**
 * dep-graph CLI
 *
 * Usage:
 *   npx ts-node src/cli.ts [command] [options]
 *
 * Commands:
 *   build [dir]                        Build and print the full dependency graph
 *   downstream <file>                  Show all files affected by changes to <file>
 *   upstream <file>                    Show all transitive dependencies of <file>
 *   refs <file> [export]               Find all references to an export from <file>
 *   cycles                             Detect circular dependencies
 *   json [dir]                         Output the full graph as JSON (for tooling)
 *
 * Options:
 *   --root <dir>                       Project root (default: cwd)
 *   --tsconfig <path>                  Path to tsconfig.json
 *   --exclude <dirs>                   Comma-separated dirs to exclude
 *   --no-type-imports                  Ignore type-only imports
 *   --no-dynamic-imports               Ignore dynamic import() calls
 */

import * as nodePath from 'path';
import {
  buildDependencyGraph,
  getDownstream,
  getUpstream,
  findAllReferences,
  findCircularDependencies,
  serializeGraph,
  type BuildOptions,
} from './dep-graph.js';
import { createNodeFileSystem, loadAliasesFromTsconfig } from './node-fs.js';
import * as p from './path.js';

// ---- Minimal arg parsing (no external deps) ----

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'build';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = command === args[0] ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--no-')) {
      flags[arg.slice(5)] = false;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// ---- Convert native OS path to posix for the core ----

function toPosix(fsPath: string): string {
  return nodePath.resolve(fsPath).split(nodePath.sep).join('/');
}

// ---- Formatting helpers ----

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

function heading(text: string) {
  console.log(`\n${BOLD}${CYAN}${text}${RESET}`);
}

function bullet(text: string, dim?: string) {
  const suffix = dim ? ` ${DIM}${dim}${RESET}` : '';
  console.log(`  ${GREEN}→${RESET} ${text}${suffix}`);
}

function warn(text: string) {
  console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}

function error(text: string) {
  console.error(`${RED}✖${RESET} ${text}`);
}

// ---- Main ----

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  const rawRoot = (flags.root as string) || process.cwd();
  const root = toPosix(rawRoot);

  // Determine target directory (posix absolute)
  const targetDir =
    positional[0] && !positional[0].includes('.')
      ? toPosix(positional[0])
      : root;

  // Load aliases from tsconfig (Node-specific, done here not in core)
  const tsconfigNative =
    (flags.tsconfig as string) || nodePath.join(targetDir, 'tsconfig.json');
  const tsconfigAliases = loadAliasesFromTsconfig(tsconfigNative, targetDir);

  // Build options — inject the Node filesystem adapter
  const opts: BuildOptions = {
    fs: createNodeFileSystem(),
    aliases: tsconfigAliases,
  };

  if (flags.exclude) opts.exclude = (flags.exclude as string).split(',');
  if (flags['type-imports'] === false) opts.includeTypeImports = false;
  if (flags['dynamic-imports'] === false) opts.includeDynamicImports = false;

  const graph = await buildDependencyGraph(targetDir, opts);

  const nodeCount = graph.nodes.size;
  let edgeCount = 0;
  for (const [, node] of graph.nodes) edgeCount += node.imports.length;

  switch (command) {
    case 'build': {
      heading(`Dependency graph: ${nodeCount} files, ${edgeCount} edges`);
      console.log();

      for (const [, node] of graph.nodes) {
        if (node.imports.length === 0) continue;
        console.log(`${BOLD}${node.relativePath}${RESET}`);
        for (const imp of node.imports) {
          const rel = p.relative(graph.root, imp.target);
          const tags: string[] = [];
          if (imp.typeOnly) tags.push('type');
          if (imp.dynamic) tags.push('dynamic');
          if (imp.names.length) tags.push(imp.names.join(', '));
          const detail = tags.length ? `[${tags.join(' | ')}]` : '';
          bullet(rel, detail);
        }
        console.log();
      }
      break;
    }

    case 'downstream': {
      const file = positional[0];
      if (!file) {
        error('Usage: dep-graph downstream <file>');
        process.exit(1);
      }
      const affected = getDownstream(graph, file);
      heading(`Files affected by changes to ${file} (${affected.length}):`);
      if (affected.length === 0) warn('No downstream dependents found.');
      else affected.forEach((f) => bullet(f));
      break;
    }

    case 'upstream': {
      const file = positional[0];
      if (!file) {
        error('Usage: dep-graph upstream <file>');
        process.exit(1);
      }
      const deps = getUpstream(graph, file);
      heading(`Transitive dependencies of ${file} (${deps.length}):`);
      if (deps.length === 0) warn('No upstream dependencies found.');
      else deps.forEach((f) => bullet(f));
      break;
    }

    case 'refs': {
      const file = positional[0];
      const exportName = positional[1];
      if (!file) {
        error('Usage: dep-graph refs <file> [exportName]');
        process.exit(1);
      }
      const refs = findAllReferences(graph, file, exportName);
      const label = exportName ? `'${exportName}' from ${file}` : file;
      heading(`References to ${label} (${refs.length}):`);
      if (refs.length === 0) warn('No references found.');
      else {
        for (const ref of refs) {
          const tags: string[] = [];
          if (ref.isTypeOnly) tags.push('type');
          if (ref.isDynamic) tags.push('dynamic');
          const detail = tags.length ? `[${tags.join(', ')}]` : '';
          bullet(`${ref.file}`, `as '${ref.importedAs}' ${detail}`);
        }
      }
      break;
    }

    case 'cycles': {
      const cycles = findCircularDependencies(graph);
      heading(`Circular dependencies (${cycles.length}):`);
      if (cycles.length === 0) {
        console.log(`  ${GREEN}✓${RESET} No circular dependencies detected.`);
      } else {
        for (const cycle of cycles) {
          console.log(`  ${RED}⟳${RESET} ${cycle.join(` ${DIM}→${RESET} `)}`);
        }
      }
      break;
    }

    case 'json': {
      const serialized = serializeGraph(graph);
      console.log(JSON.stringify(serialized, null, 2));
      break;
    }

    default:
      error(`Unknown command: ${command}`);
      console.log('Commands: build, downstream, upstream, refs, cycles, json');
      process.exit(1);
  }
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});

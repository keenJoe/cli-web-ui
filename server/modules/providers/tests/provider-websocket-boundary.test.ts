import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const providersModuleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function listProductionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'tests' ? [] : listProductionSourceFiles(entryPath);
    }

    return /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}

function listModuleSpecifiers(sourceText: string, filePath: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const moduleSpecifiers: string[] = [];

  sourceFile.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }
  });

  return moduleSpecifiers;
}

test('R16: providers production code has no dependency on the WebSocket transport module', async () => {
  const violations: string[] = [];

  for (const filePath of await listProductionSourceFiles(providersModuleRoot)) {
    const sourceText = await readFile(filePath, 'utf8');
    for (const moduleSpecifier of listModuleSpecifiers(sourceText, filePath)) {
      if (moduleSpecifier === '@/modules/websocket/index.js' || moduleSpecifier.startsWith('@/modules/websocket/')) {
        violations.push(`${path.relative(providersModuleRoot, filePath)} -> ${moduleSpecifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

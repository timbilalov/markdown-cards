// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])));
  return groups.flat();
}

it.each([
  ['domain', ['domain']], ['ports', ['domain', 'ports']], ['application', ['domain', 'ports', 'application', 'utils', 'types']]
] as const)('keeps %s independent of UI, environment and storage implementations', async (layer, allowed) => {
  const files = await sources(join(root, layer)); const violations: string[] = [];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const check = (specifier: string) => {
      const local = specifier.startsWith('.') ? resolve(dirname(file), specifier)
        : specifier.startsWith('$lib/') ? resolve(root, specifier.slice(5)) : null;
      if (local ? !allowed.some(folder => local.startsWith(join(root, folder) + sep))
        : /^(svelte(?:\/|$)|@sveltejs(?:\/|$)|\$app\/|\$env\/|node:|fs(?:\/|$)|http(?:\/|$)|https(?:\/|$))/.test(specifier)) {
        violations.push(`${file}: ${specifier}`);
      }
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

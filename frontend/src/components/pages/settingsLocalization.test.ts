import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('SettingsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const han = /[\u3400-\u9fff]/u;
const visibleAttributes = new Set(['placeholder', 'title', 'aria-label', 'label', 'description']);
const offenders: string[] = [];

const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
const add = (node: ts.Node, text: string) => offenders.push(`${file.fileName}:${lineOf(node)} ${JSON.stringify(text)}`);
const isConsoleArgument = (node: ts.Node) => {
  let current: ts.Node | undefined = node;
  while (current && !ts.isStatement(current)) {
    if (ts.isCallExpression(current.parent) && current.parent.arguments.includes(current as ts.Expression)) {
      return /^console\.(?:log|info|debug|warn|error)$/.test(current.parent.expression.getText(file));
    }
    current = current.parent;
  }
  return false;
};

function visit(node: ts.Node) {
  if (ts.isJsxText(node) && han.test(node.text.trim())) add(node, node.text.trim());

  if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(file)) && node.initializer) {
    const text = ts.isStringLiteral(node.initializer)
      ? node.initializer.text
      : ts.isJsxExpression(node.initializer) && node.initializer.expression
        ? node.initializer.expression.getText(file)
        : '';
    if (han.test(text)) add(node, text);
  }

  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && han.test(node.getText(file))) {
    const parent = node.parent;
    const translated = ts.isCallExpression(parent) && parent.expression.getText(file) === 't';
    const diagnostic = isConsoleArgument(node);
    const behaviorRegex = ts.isRegularExpressionLiteral(parent);
    const localeToken = (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'zh-CN';
    const commentRange = ts.getLeadingCommentRanges(source, node.getFullStart())?.some(range => range.pos <= node.getStart(file) && range.end >= node.getEnd());
    if (!translated && !diagnostic && !behaviorRegex && !localeToken && !commentRange && !ts.isJsxAttribute(parent)) add(node, node.getText(file));
  }

  ts.forEachChild(node, visit);
}
visit(file);

test('SettingsPage has no untranslated user-visible Chinese literals', () => {
  assert.deepEqual(offenders, [], `Untranslated visible Chinese:\n${offenders.join('\n')}`);
});

test('SettingsPage keeps behavior-only Chinese outside localization coverage', () => {
  assert.match(source, /\/失败\|错误\|不完整\|被引用\|阻止/);
  assert.match(source, /Storage account updated, but refreshing capacity statistics failed:/);
  assert.match(source, /i18n\.resolvedLanguage \|\| i18n\.language/);
  assert.doesNotMatch(source, /settings\.cards\.remaining\./);
});

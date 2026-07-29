import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('tooltip copy', () => {
  const sourceRoot = join(__dirname, '../..');

  it('keeps em dashes out of title strings', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        const assignsTitle = /\btitle\s*:|\.title\s*=|setAttribute\(\s*['"]title/.test(line);
        if (assignsTitle && line.includes('\u2014')) {
          violations.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(violations, `em dashes found in tooltip copy:\n${violations.join('\n')}`).toEqual([]);
  });

  it('puts keyboard shortcuts in parentheses instead of middot suffixes', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        const titleWithShortcutSuffix = /(?:\btitle\s*:|\.title\s*=).*·.*(?:F\d|KBD_MOD|Shift|Ctrl|Alt|⌘)/.test(line);
        if (titleWithShortcutSuffix) violations.push(`${file}:${index + 1}`);
      });
    }
    expect(violations, `shortcut suffixes found in tooltip copy:\n${violations.join('\n')}`).toEqual([]);
  });
});

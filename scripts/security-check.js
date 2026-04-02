#!/usr/bin/env node
/**
 * セキュリティチェックスクリプト
 * HTML/JSファイルに禁止パターンが含まれていないか検査する
 *
 * 使い方: node scripts/security-check.js
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SERVER_FILE = path.join(__dirname, '..', 'server.js');

// ── 検査対象ファイル収集 ──
function collectFiles(dir, ext) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, ext));
    } else if (ext.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

// ── 検査ルール定義 ──
const rules = [
  {
    id: 'inline-handler',
    description: 'インラインイベントハンドラ (onclick, onchange, oninput等)',
    pattern: /\s(onclick|onchange|oninput|onsubmit|onkeydown|onkeyup|onmouseover|onfocus|onblur)\s*=/gi,
    targets: 'html',
    severity: 'error',
  },
  {
    id: 'external-cdn',
    description: '外部CDN参照 (unpkg, jsdelivr, cdnjs)',
    pattern: /src\s*=\s*["']https?:\/\/(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//gi,
    targets: 'html',
    severity: 'error',
  },
  {
    id: 'innerHTML-user-data',
    description: 'innerHTML に未エスケープのユーザーデータ挿入の可能性',
    pattern: /\.innerHTML\s*=\s*[`'"]/g,
    targets: 'html',
    severity: 'warn',
    note: '静的HTMLのみなら許容。ユーザーデータを含む場合は esc() でエスケープすること',
  },
  {
    id: 'writeFileSync-request',
    description: 'writeFileSync の使用（リクエスト処理中は write-file-atomic を使うこと）',
    pattern: /writeFileSync\s*\(/g,
    targets: 'server',
    severity: 'warn',
    note: '起動時の初期化は許容。リクエスト処理中のみ write-file-atomic を使用',
  },
  {
    id: 'eval-usage',
    description: 'eval() の使用',
    pattern: /[^a-zA-Z]eval\s*\(/g,
    targets: 'all',
    severity: 'error',
  },
  {
    id: 'document-write',
    description: 'document.write の使用',
    pattern: /document\.write\s*\(/g,
    targets: 'html',
    severity: 'error',
  },
];

// ── 検査実行 ──
const htmlFiles = collectFiles(PUBLIC_DIR, ['.html']);
const allFiles = [...htmlFiles, SERVER_FILE];

let errorCount = 0;
let warnCount = 0;
const findings = [];

for (const rule of rules) {
  let targetFiles;
  if (rule.targets === 'html') targetFiles = htmlFiles;
  else if (rule.targets === 'server') targetFiles = [SERVER_FILE];
  else targetFiles = allFiles;

  for (const filePath of targetFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset lastIndex for global regex
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        const rel = path.relative(path.join(__dirname, '..'), filePath);
        findings.push({
          severity: rule.severity,
          rule: rule.id,
          file: rel,
          line: i + 1,
          description: rule.description,
          note: rule.note,
          snippet: line.trim().substring(0, 120),
        });
        if (rule.severity === 'error') errorCount++;
        else warnCount++;
      }
    }
  }
}

// ── 結果出力 ──
if (findings.length === 0) {
  console.log('✓ セキュリティチェック: 問題なし');
  process.exit(0);
}

console.log(`\nセキュリティチェック結果: ${errorCount} error(s), ${warnCount} warning(s)\n`);

for (const f of findings) {
  const icon = f.severity === 'error' ? '✗' : '⚠';
  console.log(`  ${icon} [${f.severity.toUpperCase()}] ${f.rule}`);
  console.log(`    ${f.file}:${f.line}`);
  console.log(`    ${f.description}`);
  if (f.note) console.log(`    → ${f.note}`);
  console.log(`    | ${f.snippet}`);
  console.log();
}

if (errorCount > 0) {
  console.log(`${errorCount} 件のエラーが検出されました。修正してください。`);
  process.exit(1);
} else {
  console.log(`警告のみ ${warnCount} 件。確認してください。`);
  process.exit(0);
}

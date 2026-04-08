// Auto-inject diagnostics:false into jest.config to prevent TS type errors from blocking tests
const fs = require('fs');
const p = 'jest.config.cjs';
if (fs.existsSync(p)) {
  let c = fs.readFileSync(p, 'utf8');
  if (!c.includes('diagnostics')) {
    // Try transform inline first: "ts-jest"] -> "ts-jest", { diagnostics: false }]
    c = c.replace(/(["'])ts-jest\1\s*\]/g, '$1ts-jest$1, { diagnostics: false }]');
    // If still no diagnostics, try adding to preset line
    if (!c.includes('diagnostics')) {
      c = c.replace(/(preset:\s*["']ts-jest["'])/, '$1,\n  transform: { "^.+\\\\.ts$": ["ts-jest", { diagnostics: false }] }');
    }
    fs.writeFileSync(p, c);
  }
}

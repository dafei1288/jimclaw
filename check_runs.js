const fs = require('fs');
const path = require('path');
const runsDir = path.join(__dirname, 'workspace');
const dirs = fs.readdirSync(runsDir)
  .filter(d => d.startsWith('run_') && !d.includes('bg'))
  .sort()
  .slice(-8); // last 8 runs

for (const dir of dirs) {
  const boulderPath = path.join(runsDir, dir, 'boulder.json');
  if (!fs.existsSync(boulderPath)) {
    console.log(`${dir}: NO boulder.json`);
    continue;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(boulderPath, 'utf8'));
    const state = raw.state || raw;
    const isDone = state.isDone || false;
    const deploy = (state.deploymentStatus || {}).status || 'None';
    const retryCount = state.retryCount || 0;
    const url = (state.deploymentStatus || {}).url || '';
    const lastFail = (state.lastFailureSummary || '').slice(0, 120);
    const spec = state.spec || {};
    const title = (state.taskContract || {}).title || '';

    const status = isDone ? '✅' : '❌';
    console.log(`${status} ${dir} | done=${isDone} deploy=${deploy} retry=${retryCount}`);
    if (title) console.log(`   title: ${title}`);
    if (url) console.log(`   url: ${url}`);
    if (lastFail) console.log(`   fail: ${lastFail}`);
    console.log('');
  } catch (e) {
    console.log(`${dir}: PARSE ERROR - ${e.message}`);
  }
}

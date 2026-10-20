// Browser regression tests intercept HTTP, so they need no server or reserved port.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'benchmarks/manifest.json')));
const bundle = JSON.parse(fs.readFileSync(path.join(root, 'examples/full-dot/bundle.json')));

async function launch(t, custom = () => false) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught browser errors'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const json = data => route.fulfill({ json: data });
    if (await custom(route, url, json)) return;
    if (url.pathname === '/v1/health') return json({ toolchain_ready: true });
    if (url.pathname === '/v1/benchmarks') return json({ items: Object.entries(manifest).map(([id, value]) => ({ ...value, id })) });
    if (url.pathname === '/v1/experiments') return json({ items: [], total: 0 });
    let relative = url.pathname === '/' ? 'web/index.html' : url.pathname.startsWith('/static/') ? `web/${url.pathname.slice(8)}` : url.pathname.slice(1);
    const target = path.resolve(root, relative);
    if (target.startsWith(root + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(target)];
      return route.fulfill({ body: fs.readFileSync(target), contentType });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Fixture not found' } } });
  });
  await page.goto('http://autotuner.test/');
  await page.locator('#benchmark option').first().waitFor({ state: 'attached' });
  return page;
}

test('bundled evidence displays tuning, holdout, controls, and actual settings', async t => {
  const page = await launch(t);
  await page.getByRole('button', { name: 'dot · saved full Portable evidence' }).click();
  await page.locator('#comparisons h3').filter({ hasText: 'Held-out' }).waitFor();
  assert.equal(await page.locator('#comparisons tbody tr').count(), 10);
  assert.match(await page.locator('#comparisons').innerText(), /guided vs random/);
  assert.match(await page.locator('#comparisons').innerText(), /guided vs empty control/);
  assert.match(await page.locator('#result-note').innerText(), /10 confirmation rounds, 5 search repetitions/);
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  assert.match(await page.locator('#environment-link').getAttribute('href'), /environment.json$/);
  await page.locator('#trial-rows tr').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('#trial-detail').waitFor({ state: 'visible' });
  assert.match(await page.locator('#trial-detail').innerText(), /effective_pipeline/);
  if (process.env.BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.BROWSER_SCREENSHOT, fullPage: true });
});

test('browser rejects seeds beyond its exact integer range', async t => {
  let submissions = 0;
  const page = await launch(t, async (route, url, json) => {
    if (route.request().method() === 'POST') { submissions++; await json({}); return true; }
    return false;
  });
  await page.locator('#seed').fill('9007199254740992');
  await page.locator('#run-button').click();
  assert.equal(await page.locator('#seed').evaluate(input => input.checkValidity()), false);
  assert.equal(submissions, 0);
});

test('saved uint64 seeds display exactly without JavaScript rounding', async t => {
  const raw = JSON.stringify(bundle).replaceAll('"seed":17', '"seed":18446744073709551615');
  const page = await launch(t, async (route, url) => {
    if (url.pathname === '/examples/full-dot/bundle.json') {
      await route.fulfill({ body: raw, contentType: 'application/json' }); return true;
    }
    return false;
  });
  await page.getByRole('button', { name: 'dot · saved full Portable evidence' }).click();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.match(await page.locator('#comparisons').innerText(), /seed 18446744073709551615/);
  assert.doesNotMatch(await page.locator('#comparisons').innerText(), /seed 18446744073709552000/);
});

test('switching runs ignores a late response from the previous selection', async t => {
  let releaseSlow, slowStarted;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const started = new Promise(resolve => { slowStarted = resolve; });
  const run = id => ({ id, status: 'completed', stage: 'completed', progress: { planned_candidates: 40, attempted_candidates: 40, valid_candidates: 30 } });
  const page = await launch(t, async (route, url, json) => {
    if (url.pathname === '/v1/experiments') {
      await json({ items: ['slow', 'fast'].map(id => ({ id, benchmark_id: id, mode: 'full', status: 'completed', created_at: '2026-10-16T00:00:00Z' })), total: 2 }); return true;
    }
    if (url.pathname === '/v1/experiments/slow') { slowStarted(); await slowGate; await json(run('slow')); return true; }
    if (url.pathname === '/v1/experiments/fast') { await json(run('fast')); return true; }
    if (url.pathname.endsWith('/report')) { await json(bundle.summary); return true; }
    if (url.pathname.endsWith('/trials')) { await json({ items: bundle.trials }); return true; }
    if (url.pathname.includes('/artifacts/')) { await route.fulfill({ body: '<svg xmlns="http://www.w3.org/2000/svg"/>', contentType: 'image/svg+xml' }); return true; }
    return false;
  });
  await page.locator('#saved-runs button').filter({ hasText: 'slow' }).click();
  await started;
  await page.locator('#saved-runs button').filter({ hasText: 'fast' }).click();
  await page.locator('#results').waitFor({ state: 'visible' });
  const response = page.waitForResponse(response => response.url().endsWith('/slow'));
  releaseSlow();
  await response;
  assert.equal(await page.locator('#run-id').innerText(), 'fast');
});

test('custom confirmation counts and rejected finalists render accurately', async t => {
  const modified = structuredClone(bundle);
  modified.summary.request.confirmation_rounds = 12;
  modified.summary.request.search_repetitions = 7;
  modified.summary.winners.guided = null;
  modified.summary.comparisons.tuning.guided_vs_o3 = { label: 'unavailable', reason: 'Rejected finalist' };
  const page = await launch(t, async (route, url, json) => {
    if (url.pathname === '/examples/full-dot/bundle.json') { await json(modified); return true; }
    return false;
  });
  await page.getByRole('button', { name: 'dot · saved full Portable evidence' }).click();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.match(await page.locator('#result-note').innerText(), /12 confirmation rounds, 7 search repetitions/);
  assert.match(await page.locator('#metrics').innerText(), /No valid confirmed trial/);
  assert.equal((await page.locator('#result-label').innerText()).toLowerCase(), 'unavailable');
});

test('mobile evidence remains accessible without overflowing the viewport', async t => {
  const page = await launch(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'dot · saved full Portable evidence' }).click();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('cancel shows partial evidence and retry selects a fresh experiment', async t => {
  let cancelled = false, retried = false;
  const page = await launch(t, async (route, url, json) => {
    if (url.pathname === '/v1/experiments') {
      await json({ items: [{ id: 'active', benchmark_id: 'active', mode: 'quick', status: 'running', created_at: '2026-10-16T00:00:00Z' }], total: 1 }); return true;
    }
    if (url.pathname === '/v1/experiments/active/cancel') { cancelled = true; await json({ cancellation_requested: true }); return true; }
    if (url.pathname === '/v1/experiments/active/retry') { retried = true; await json({ id: 'fresh' }); return true; }
    if (url.pathname === '/v1/experiments/active' || url.pathname === '/v1/experiments/fresh') {
      const id = url.pathname.endsWith('/fresh') ? 'fresh' : 'active';
      await json({ id, status: id === 'active' && cancelled ? 'cancelled' : 'running', stage: 'search', progress: { planned_candidates: 5, attempted_candidates: 1, valid_candidates: 1 } }); return true;
    }
    if (url.pathname.endsWith('/trials')) { await json({ items: bundle.trials.slice(0, 1) }); return true; }
    return false;
  });
  await page.locator('#saved-runs button').first().click();
  await page.locator('#cancel-run').click();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.match(await page.locator('#result-note').innerText(), /Partial evidence only/);
  assert.equal(await page.locator('#comparison-panel').isVisible(), false);
  assert.equal(await page.locator('#trial-rows tr').count(), 1);
  await page.locator('#retry-run').click();
  await page.waitForFunction(() => document.getElementById('run-id').textContent === 'fresh');
  assert.equal(retried, true);
});

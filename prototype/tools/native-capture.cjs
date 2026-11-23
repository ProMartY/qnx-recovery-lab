/* Observe one owned QNX runner. No browser endpoint can launch a process. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function createNativeCapture(root, workRoot) {
  const artifacts = path.join(root, 'prototype/artifacts');
  const monitor = path.join(root, 'prototype/tools/native-monitor.html');
  const source = path.join(root, 'prototype/src/recovery_lab.c');
  const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
  const metadata = JSON.parse(await fs.readFile(path.join(workRoot, 'build-metadata.json'), 'utf8'));
  assert.equal(metadata.config.scenario, 'all');
  assert.equal(metadata.config.fault_at, 8);
  assert.equal(metadata.config.watchdog_ms, 700);
  assert.equal(metadata.config.restart_limit, 2);
  assert.equal(sha(await fs.readFile(source)), metadata.source_sha256, 'Rebuild the native image after changing C source.');
  let child = null, runId = null, exitCode = null, began = null, finished = null;
  let serial = '', livePrefix = '', stdout = '', report = null, completed = null, validated = false, failure = false;
  let startedAt = null;
  const observations = [];
  const monitorBytes = await fs.readFile(monitor);
  const observerBytes = await fs.readFile(__filename);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${server.address().port}`) {
        response.writeHead(403); response.end(); return;
      }
      const pathname = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(monitorBytes);
      } else if (pathname === '/font.woff2') {
        response.setHeader('Content-Type', 'font/woff2');
        response.end(await fs.readFile(path.join(root, 'prototype/demo/fonts/inter-tight-latin-wght-normal.woff2')));
      } else if (pathname === '/state') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await snapshot()));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end('Native observer could not read this run.'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  async function refresh() {
    if (began === null) return;
    if (!runId) {
      const header = stdout.match(/^RECOVERY_HOST_RUN (\{[^\r\n]*\})\r?$/m);
      if (header) {
        const owned = JSON.parse(header[1]);
        assert(/^\d{8}-\d{6}-\d{3}$/.test(owned.run_id));
        assert.equal(owned.scenario, 'all');
        runId = owned.run_id;
      }
    }
    if (runId) {
      for (const filename of [path.join(workRoot, `guest-${runId}.log`), path.join(artifacts, `guest-${runId}.log`)]) {
        try {
          const candidate = await fs.readFile(filename, 'utf8');
          if (candidate.length >= serial.length) serial = candidate;
          if (filename.startsWith(workRoot + path.sep) && candidate.length >= livePrefix.length) livePrefix = candidate.slice(0, candidate.lastIndexOf('\n') + 1);
          break;
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  async function snapshot() {
    await refresh();
    const lines = serial.slice(0, serial.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean);
    const events = [];
    let environment = null, config = null;
    for (const line of lines) {
      if (line.startsWith('RECOVERY_EVENT ')) events.push(JSON.parse(line.slice(15)));
      if (line.startsWith('RECOVERY_ENV ')) environment = JSON.parse(line.slice(13));
      if (line.startsWith('RECOVERY_CONFIG ')) config = JSON.parse(line.slice(16));
    }
    const lastEventLines = new Set(lines.map((line,index) => line.startsWith('RECOVERY_EVENT ') ? index : -1).filter(index => index >= 0).slice(-2));
    const state = {
      phase: began === null ? 'ready' : validated ? 'passed' : failure || (exitCode !== null && exitCode !== 0) ? 'failed' : exitCode === 0 || lines.includes('RECOVERY_RUN_EXIT=0') ? 'verifying' : environment ? 'running' : 'booting',
      elapsed: began === null ? 0 : ((finished ?? performance.now()) - began) / 1000,
      run_id: runId, environment, config, event_count: events.length,
      current: events.at(-1) ?? null,
      summaries: events.filter(event => event.event === 'summary'),
      last_rejection: events.findLast(event => event.event === 'rejected') ?? null,
      last_recovery: events.findLast(event => event.event === 'resumed') ?? null,
      serial_tail: lines.filter((line,index) => /^(RECOVERY_ENV |RECOVERY_CONFIG |RECOVERY_LAB_EXIT=|RECOVERY_RUN_EXIT=)/.test(line) || lastEventLines.has(index)),
      guest_exit: lines.includes('RECOVERY_LAB_EXIT=0') && lines.includes('RECOVERY_RUN_EXIT=0') ? 0 : null,
      host_exit: exitCode, verified: validated,
    };
    const previous = observations.at(-1);
    if (began !== null && (!previous || previous.phase !== state.phase || previous.event_count !== state.event_count)) {
      observations.push({at_seconds:state.elapsed,phase:state.phase,event_count:state.event_count,current:state.current});
    }
    return state;
  }
  function start() {
    assert.equal(child, null, 'A capture session may start only once.');
    startedAt = new Date().toISOString();
    began = performance.now();
    child = spawn('pwsh', ['-NoProfile', '-File', path.join(root, 'prototype/run-lab.ps1'), '-SkipBuild', '-Scenario', 'all', '-FaultAt', '8', '-WatchdogMs', '700', '-RestartLimit', '2', '-WorkRoot', workRoot], {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { stdout += bytes.toString('utf8'); });
    completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', async code => {
        exitCode = code; finished = performance.now();
        try {
          await refresh();
          assert.equal(code, 0, 'The owned QNX runner failed. See work/native-run-host.log.');
          assert(runId, 'The owned runner did not identify its immutable report.');
          const raw = await fs.readFile(path.join(artifacts, `run-${runId}.json`));
          report = JSON.parse(raw);
          assert.equal(report.environment.os, 'QNX');
          assert.equal(report.environment.release, '8.0.0');
          assert.equal(report.scenarios.length, 7);
          assert.equal(new Set(report.scenarios.map(row => row.scenario)).size, 7);
          assert(report.scenarios.every(row => row.passed === true && row.output === 0 && row.invalid_outputs === 0));
          const outcomes = report.scenarios.map(row => row.outcome).sort();
          assert.deepEqual(outcomes, ['contained','healthy','recovered','recovered','recovered','recovered','recovered']);
          assert.equal(report.evidence.source_sha256, metadata.source_sha256);
          for (const key of ['binary_sha256','boot_sha256','disk_sha256']) assert.equal(report.evidence[key], metadata[key]);
          const state = await snapshot();
          assert.equal(state.guest_exit, 0);
          const finalSerial = await fs.readFile(path.join(artifacts, report.evidence.console));
          assert.equal(sha(finalSerial), report.evidence.console_sha256);
          assert.equal(finalSerial.toString('utf8').split(/\r?\n/).filter(line => line === 'RECOVERY_LAB_EXIT=0').length, 1);
          assert.equal(finalSerial.toString('utf8').split(/\r?\n/).filter(line => line === 'RECOVERY_RUN_EXIT=0').length, 1);
          assert(livePrefix.includes('RECOVERY_EVENT '), 'No live guest events were observed before console finalization.');
          const liveCounts = observations.filter(item => item.phase === 'running' && item.event_count > 0).map(item => item.event_count);
          assert(new Set(liveCounts).size >= 2, 'The observer did not receive increasing event counts while the guest was running.');
          assert(finalSerial.toString('utf8').startsWith(livePrefix), 'Frozen console differs from the observed live prefix.');
          const attempt = JSON.parse(await fs.readFile(path.join(artifacts, 'latest-attempt.json'), 'utf8'));
          assert.equal(attempt.run_id, runId);
          assert.equal(attempt.status, 'passed');
          validated = true;
          await fs.writeFile(path.join(root, 'work/native-run-host.log'), stdout);
          resolve(await snapshot());
        } catch (error) {
          report = null; failure = true;
          await fs.writeFile(path.join(root, 'work/native-run-host.log'), stdout).catch(() => {});
          reject(error);
        }
      });
    });
    // Attach immediately; the recording orchestrator awaits this promise after its first hold.
    completed.catch(() => {});
    return completed;
  }
  async function receipt() {
    await completed;
    const raw = await fs.readFile(path.join(artifacts, `run-${runId}.json`));
    return {schema_version:1,kind:'new QNX guest execution observed during browser capture',started_at:startedAt,run_file:`run-${runId}.json`,run_sha256:sha(raw),console_file:report.evidence.console,console_sha256:report.evidence.console_sha256,observed_live_prefix_sha256:sha(Buffer.from(livePrefix)),observed_live_lines:livePrefix.split('\n').length-1,source_file:report.evidence.source_snapshot,source_sha256:report.evidence.source_sha256,binary_sha256:report.evidence.binary_sha256,boot_sha256:report.evidence.boot_sha256,config:report.config,environment:report.environment,event_count:report.events.length,scenario_count:report.scenarios.length,guest_exit:0,host_exit:exitCode,monitor_sha256:sha(monitorBytes),observer_sha256:sha(observerBytes),observations};
  }
  async function close() {
    // Let run-lab's own finally block stop its QEMU child and remove its disk copy.
    if (completed) await completed.catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
  return {url:`http://127.0.0.1:${server.address().port}/`,start,snapshot,receipt,close};
}
module.exports = {createNativeCapture};

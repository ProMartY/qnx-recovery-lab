/* Record the real demo UI in an isolated headless Chrome, without desktop access. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const { createNativeCapture } = require('./native-capture.cjs');
const root = path.resolve(__dirname, '../..');
const localBrowserCache = path.join(root, 'work/browser-cache');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(path.join(localBrowserCache, 'ffmpeg-1013'))) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowserCache;
}
const { chromium } = require(require.resolve('playwright', { paths:[path.join(root,'work/viewer-check'), root] }));

function stamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}

(async () => {
  const folder = path.join(root,'prototype/demo');
  const media = path.join(folder,'media');
  await fs.mkdir(media,{recursive:true});
  const manifest = JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'));
  assert(['index.html','demo.css','demo.js'].every(name => manifest.assets?.[name]), 'Rebuild the demo manifest before recording.');
  for (const name of Object.keys(manifest.assets ?? {})) {
    const receipt = manifest.assets?.[name];
    const raw = await fs.readFile(path.join(folder,name));
    assert(receipt, `Missing demo asset receipt: ${name}. Rebuild the demo first.`);
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),receipt.sha256,`Demo UI changed after its manifest: ${name}. Rebuild before recording.`);
  }
  const data = {};
  for (const role of ['baseline','no_restarts']) {
    const record = manifest.recordings[role];
    const raw = await fs.readFile(path.join(folder,record.file));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),record.sha256);
    data[role] = JSON.parse(raw);
  }
  const native = process.argv.includes('--native') ? await createNativeCapture(root,path.resolve(root,process.env.QNX_CAPTURE_WORK_ROOT || 'work/qnx-recovery-vm')) : null;
  let nativeSection = null;
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:path.join(root,'work/demo-recording'),size:{width:1440,height:1000},fps:25}});
  const page = await context.newPage();
  const video = page.video();
  const candidateVideo = path.join(root,'work/demo-recording',`candidate-${Date.now()}.webm`);
  const started = performance.now();
  const captions = [];
  const errors = [];
  const now = () => (performance.now() - started) / 1000;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:8764/') || (native && route.request().url().startsWith(native.url)) ? route.continue() : route.abort());
  async function hold(text,seconds) {
    const start=now();
    await page.waitForTimeout(seconds*1000);
    captions.push({start,end:now(),text,...await page.evaluate(()=>window.recoveryDemo?.getState() ?? {section:'native',native:window.nativeCaptureState})});
  }
  async function seek(kind, occurrence=0, predicate=()=>true) {
    const state=await page.evaluate(()=>window.recoveryDemo.getState());
    const events=data[state.mode].events.filter(event=>event.scenario===state.scenario);
    const candidates=events.map((event,index)=>({event,index})).filter(item=>item.event.event===kind&&predicate(item.event));
    assert(candidates[occurrence],`Missing ${state.mode}/${state.scenario}/${kind}/${occurrence}`);
    const index=candidates[occurrence].index;
    await page.locator('#eventScrubber').evaluate((input,index)=>{input.value=String(index);input.dispatchEvent(new Event('input',{bubbles:true}));},index);
    const actual=await page.evaluate(()=>window.recoveryDemo.getState());
    assert.equal(actual.eventIndex,index);
    assert.equal(await page.locator('#outputValue').textContent(),String(events[index].output));
    await page.evaluate(()=>scrollTo(0,0));
  }
  try {
    if (native) {
      console.log('Recording a new native QNX guest execution');
      await page.goto(native.url);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => window.nativeCaptureState?.phase === 'ready');
      const start = now();
      await hold('This is a new execution of the native C program in QNX 8 under QEMU. The browser observes the live guest serial stream.',3);
      const runStart = now();
      const completed = native.start();
      await page.waitForFunction(() => ['passed','failed'].includes(window.nativeCaptureState?.phase),{},{timeout:115000});
      await completed;
      assert.equal(await page.evaluate(() => window.nativeCaptureState.phase),'passed');
      assert.equal(await page.evaluate(() => window.nativeCaptureError ?? null),null);
      captions.push({start:runStart,end:now(),text:'QEMU boots QNX. The guest runs seven scenarios; the host then checks the raw console, event invariants and source digests.',section:'native',native:await native.snapshot()});
      await hold('All seven native scenarios passed, including zero-output containment after the restart budget was exhausted. Both guest and host exited successfully.',7);
      await page.screenshot({path:path.join(root,'prototype/artifacts/native-run-overview.png')});
      nativeSection = {start,end:now(),...await native.receipt()};
    }
    await page.goto('http://127.0.0.1:8764/demo/');
    await page.waitForFunction(()=>window.recoveryDemo?.getState().ready);
    console.log('Recording healthy validation');
    await hold('Recovery Lab replays native QNX 8 recordings. The worker proposes values; the supervisor owns the simulated output.',5);
    await seek('proposal',0,event=>event.seq===1);
    await hold('The first fresh proposal is accepted, but output remains zero.',2);
    await seek('proposal',0,event=>event.seq===2);
    await hold('The second proposal still keeps the output at zero.',2);
    await seek('validated');
    await hold('The third fresh proposal completes validation and releases a valid output.',4);

    console.log('Recording invalid command and recovery');
    await page.locator('#chapter-validation').click();
    await page.locator('#variant-invalid').click();
    await seek('fault_injected');
    await hold('The worker now announces an injected out-of-range command.',3);
    await seek('rejected');
    await hold('Proposed output 999 is rejected. The supervisor holds the accepted output at zero.',5);
    await seek('hold');
    await hold('The hold is a separate recorded decision, even when events share a timestamp.',3);
    await seek('worker_started',0,event=>event.generation===2);
    await hold('A replacement worker starts as generation 2. Output remains zero.',3);
    await seek('proposal',0,event=>event.generation===2&&event.seq===1);
    await hold('The replacement must provide fresh proposal one.',2);
    await seek('proposal',0,event=>event.generation===2&&event.seq===2);
    await hold('Fresh proposal two still does not release the output.',2);
    await seek('resumed');
    await hold('Fresh proposal three restores the output. The guest timestamp records the observed recovery.',5);
    await page.locator('#recordedAssessment').scrollIntoViewIfNeeded();
    const assessment = await page.evaluate(() => window.recoveryDemo.getAssessment('invalid'));
    const measured = assessment.baseline.cycles[0];
    await hold(`In this recording: ${measured.noticeToHoldMs} ms from fault notice to hold, then ${measured.holdToResumeMs} ms to validated resume. No restarts means lockout.`,8);

    console.log('Recording sequence and generation validation');
    await page.locator('#variant-replay').click();
    await seek('fault_injected');
    await hold('Range checking alone is not enough. This injection repeats an old sequence number.',2);
    await seek('rejected');
    await hold('The duplicate sequence is rejected even though its numeric value is within range.',5);
    await seek('hold');
    await hold('The replayed command never reaches the simulated output.',3);
    await page.locator('#chapter-generation').click();
    await seek('fault_injected');
    await hold('Next, the active worker deliberately sends generation zero.',2);
    await seek('rejected');
    await hold('Received generation zero does not match active generation one. The message is rejected and output is zero.',5);
    await seek('resumed');
    await hold('The validated replacement can resume output.',3);

    console.log('Recording bounded restarts');
    await page.locator('#chapter-budget').click();
    await seek('fault_injected');
    await hold('Repeated crashes exercise the restart budget.',3);
    await seek('worker_exit');
    await hold('The guest records the worker exit with code 42.',2);
    await seek('hold');
    await hold('The supervisor holds zero before restarting.',3);
    await seek('restart');
    await hold('A restart consumes one unit of the budget.',2);
    await seek('resumed');
    await hold('Fresh validation permits the replacement to run.',2);
    await seek('hold',1);
    await hold('A second crash repeats the containment and recovery path.',2);
    await seek('hold',2);
    await hold('The third crash arrives after both permitted restarts have been used.',3);
    await seek('locked_out');
    await hold('The budget is exhausted. The supervisor stays locked out at zero.',5);
    await page.screenshot({path:path.join(root,'prototype/artifacts/demo-lockout.png')});

    console.log('Recording no-restart policy and evidence');
    await page.locator('#mode-no-restarts').click();
    await hold('The second recording keeps the same fault sequence and watchdog, with no restarts allowed.',4);
    await page.locator('#chapter-validation').click();
    await page.locator('#variant-invalid').click();
    await seek('rejected');
    await hold('Under that policy, the first rejected command holds zero without creating a replacement.',5);
    await seek('locked_out');
    await hold('The first detected fault ends in containment: generation one, zero restarts, output zero.',4);
    await page.locator('#evidenceToggle').click();
    await page.locator('#evidence').scrollIntoViewIfNeeded();
    await hold('Both recordings contain seven checked scenarios. Raw guest logs, source snapshots and digests are included. Output is simulated; QEMU timing is not a hardware guarantee.',8);
    assert.deepEqual(errors,[]);
  } finally { await context.close(); await video.saveAs(candidateVideo); await browser.close(); if(native) await native.close(); }
  // Encoding/closing time is not part of the movie. Measure the completed media itself.
  const metadataHtml = candidateVideo + '.html';
  await fs.writeFile(metadataHtml,`<!doctype html><meta charset="utf-8"><video src="${path.basename(candidateVideo)}" preload="auto"></video>`);
  const metadataBrowser = await chromium.launch({channel:'chrome',headless:true});
  let duration;
  try {
    const metadataPage = await metadataBrowser.newPage();
    await metadataPage.goto(pathToFileURL(metadataHtml).href);
    await metadataPage.waitForFunction(() => Number.isFinite(document.querySelector('video').duration));
    duration = await metadataPage.locator('video').evaluate(media => media.duration);
    assert(duration > 0 && duration < 180, 'Capture exceeds the submission video limit. Previous published media was retained.');
  } finally { await metadataBrowser.close(); }
  const vtt='WEBVTT\n\n'+captions.map((item,index)=>`${index+1}\n${stamp(item.start)} --> ${stamp(item.end)}\n${item.text}\n`).join('\n');
  await fs.copyFile(candidateVideo,path.join(media,'demo.webm'));
  if(nativeSection){
    nativeSection.duration_seconds=duration;
    nativeSection.video_sha256=crypto.createHash('sha256').update(await fs.readFile(candidateVideo)).digest('hex');
    nativeSection.recorder_sha256=crypto.createHash('sha256').update(await fs.readFile(__filename)).digest('hex');
    await fs.writeFile(path.join(root,'prototype/artifacts/demo-native-capture.json'),JSON.stringify(nativeSection,null,2)+'\n');
  }
  await fs.writeFile(path.join(media,'demo.vtt'),vtt,'utf8');
  await fs.writeFile(path.join(root,'prototype/artifacts/demo-video-timeline.json'),JSON.stringify({schema_version:1,recorded_at:new Date().toISOString(),kind:nativeSection?'new native QNX run followed by archived-event UI replay':'real browser UI capture',duration_seconds:duration,viewport:{width:1440,height:1000},ui_assets:manifest.assets,recordings:manifest.recordings,...nativeSection?{native:nativeSection}:{},captions},null,2)+'\n');
  console.log(`Saved actual recording (${duration.toFixed(2)} seconds), captions and event timeline.`);
})().catch(error=>{console.error(error);process.exitCode=1;});

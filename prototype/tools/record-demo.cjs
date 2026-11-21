/* Record the real demo UI in an isolated headless Chrome, without desktop access. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
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
  const data = {};
  for (const role of ['baseline','no_restarts']) {
    const record = manifest.recordings[role];
    const raw = await fs.readFile(path.join(folder,record.file));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),record.sha256);
    data[role] = JSON.parse(raw);
  }
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:path.join(root,'work/demo-recording'),size:{width:1440,height:1000},fps:25}});
  const page = await context.newPage();
  const video = page.video();
  const started = performance.now();
  const captions = [];
  const errors = [];
  const now = () => (performance.now() - started) / 1000;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:8764/') ? route.continue() : route.abort());
  async function hold(text,seconds) {
    const start=now();
    await page.waitForTimeout(seconds*1000);
    captions.push({start,end:now(),text,...await page.evaluate(()=>window.recoveryDemo.getState())});
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
  } finally { await context.close(); await video.saveAs(path.join(media,'demo.webm')); await browser.close(); }
  const vtt='WEBVTT\n\n'+captions.map((item,index)=>`${index+1}\n${stamp(item.start)} --> ${stamp(item.end)}\n${item.text}\n`).join('\n');
  await fs.writeFile(path.join(media,'demo.vtt'),vtt,'utf8');
  await fs.writeFile(path.join(root,'prototype/artifacts/demo-video-timeline.json'),JSON.stringify({schema_version:1,recorded_at:new Date().toISOString(),kind:'real browser UI capture',viewport:{width:1440,height:1000},recordings:manifest.recordings,captions},null,2)+'\n');
  console.log(`Saved actual demo UI recording (${now().toFixed(1)} seconds wall time), captions and event timeline.`);
})().catch(error=>{console.error(error);process.exitCode=1;});

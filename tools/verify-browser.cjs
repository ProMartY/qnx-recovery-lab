/* Run after npm ci and npm run serve. Chrome is launched in an isolated context. */
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname,'..');
const base = 'http://127.0.0.1:8764/';
const reportFile = path.join(root,'work/browser-verification.json');
const presented = [['healthy','healthy'],['validation','invalid'],['validation','replay'],['generation','wrong_generation'],['budget','crash_loop']];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const demoState = page => page.evaluate(() => window.recoveryDemo.getState());
const demoReady = page => page.waitForFunction(() => window.recoveryDemo?.getState().ready);
const cleanEvent = event => {const {sourceIndex,...value} = event;return value;};

(async () => {
  const report = {schema_version:1,kind:'isolated Chrome browser verification',status:'running',started_at:new Date().toISOString(),checks:[],accessibility:[]};
  let browser;
  let stage = 'initialization';
  const contexts = [];
  const pageErrors = [];
  const externalRequests = [];
  const recordings = {};
  const raw = {};
  let chromium;
  let axePath;
  let manifest;
  async function check(name,run) {stage=name;await run();report.checks.push({name,passed:true});}
  async function newPage(options = {}) {
    const context = await browser.newContext(options);
    contexts.push(context);
    await context.route('**/*',route => {
      const url = route.request().url();
      if (/^https?:/.test(url) && !url.startsWith(base)) {externalRequests.push(new URL(url).origin);return route.abort();}
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror',error => pageErrors.push(error.name));
    page.setDefaultTimeout(15000);
    return page;
  }
  await fs.mkdir(path.dirname(reportFile),{recursive:true});
  await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  try {
    await check('browser dependencies',async () => {
      ({chromium} = require('playwright'));
      axePath = require.resolve('axe-core/axe.min.js');
    });
    await check('pinned recording bytes',async () => {
      manifest = JSON.parse(await fs.readFile(path.join(root,'prototype/demo/manifest.json'),'utf8'));
      report.recordings = {};
      for (const [mode,name] of [['baseline','baseline'],['no_restarts','no-restarts']]) {
        raw[mode] = await fs.readFile(path.join(root,`prototype/demo/data/${name}.json`));
        assert.equal(digest(raw[mode]),manifest.recordings[mode].sha256,'Recording digest differs from its manifest pin');
        recordings[mode] = JSON.parse(raw[mode]);
        report.recordings[mode] = {sha256:digest(raw[mode]),events:recordings[mode].events.length};
      }
      browser = await chromium.launch({channel:'chrome',headless:true});
      report.browser = browser.version();
    });
    const demo = await newPage({viewport:{width:1440,height:1000}});
    await check('227 presented event rows',async () => {
      await demo.goto(base+'demo/');
      await demoReady(demo);
      let count = 0;
      for (const mode of ['baseline','no_restarts']) {
        await demo.locator(mode === 'baseline' ? '#mode-baseline' : '#mode-no-restarts').click();
        for (const [chapter,scenario] of presented) {
          await demo.locator(`#chapter-${chapter}`).click();
          if (chapter === 'validation') await demo.locator(`#variant-${scenario}`).click();
          const events = recordings[mode].events.filter(event => event.scenario === scenario);
          for (const [index,event] of events.entries()) {
            await demo.locator('#eventScrubber').evaluate((input,value) => {input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},index);
            const state = await demoState(demo);
            assert.equal(state.mode,mode);assert.equal(state.scenario,scenario);assert.equal(state.eventIndex,index);
            assert.deepEqual(cleanEvent(state.event),event);
            assert.equal(await demo.locator('#outputValue').textContent(),String(event.output));
            assert.equal((await demo.locator('#supervisorState').textContent()).toLowerCase(),event.state.replaceAll('_',' '));
            assert.equal(await demo.locator('#workerGeneration').textContent(),`G${event.generation}`);
            if (['validating','holding','locked_out','stopped'].includes(event.state)) assert.equal(event.output,0);
            count++;
          }
        }
      }
      assert.equal(count,227);report.presented_events=count;
    });
    await check('message packets stop at the supervisor gate',async () => {
      await demo.locator('#mode-baseline').click();
      await demo.locator('#chapter-validation').click();
      await demo.locator('#variant-invalid').click();
      const events = recordings.baseline.events.filter(event => event.scenario === 'invalid');
      const index = events.findIndex(event => event.event === 'rejected');
      await demo.locator('#eventScrubber').evaluate((input,value) => {input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},index);
      assert.equal(await demo.locator('#gateStatus').textContent(),'REJECT');
      assert.match(await demo.locator('#packetLabel').textContent(),/999/);
      assert(await demo.locator('#signalRoute').evaluate(route => {
        const marker = document.getElementById('packetMarker');
        return Number(marker.getAttribute('cx')) < route.getPointAtLength(route.getTotalLength()).x;
      }));
      assert.equal(await demo.locator('#outputValue').textContent(),'0');
    });
    await check('20 actual-event tour steps and controls',async () => {
      await demo.clock.install();
      await demo.evaluate(() => {window.qaTour=[];window.addEventListener('demo:step',event => {if(event.detail.touring)window.qaTour.push(event.detail);});});
      await demo.locator('#tourToggle').click();
      assert.equal((await demoState(demo)).tourIndex,0);
      await demo.locator('#tourTransportToggle').click();
      await demo.clock.runFor(15000);
      assert.equal((await demoState(demo)).tourIndex,0);assert.equal((await demoState(demo)).touring,false);
      await demo.locator('#tourToggle').click();
      await demo.clock.runFor(150000);
      const final = await demoState(demo);
      assert.equal(final.tourCompleted,true);assert.equal(final.touring,false);assert.equal(final.mode,'no_restarts');
      assert.equal(final.event.event,'locked_out');assert.equal(final.event.output,0);
      const steps = new Map((await demo.evaluate(() => window.qaTour)).map(value => [value.tourIndex,value]));
      assert.equal(steps.size,20);
      for (const value of steps.values()) assert.deepEqual(cleanEvent(value.event),recordings[value.mode].events.filter(event => event.scenario === value.scenario)[value.eventIndex]);
      assert.equal(steps.get(12).event.received_generation,0);
      await demo.locator('#tourToggle').click();
      await demo.locator('#chapter-generation').click();
      assert.equal((await demoState(demo)).tourIndex,-1);assert.equal((await demoState(demo)).touring,false);
      await demo.clock.runFor(10000);assert.equal((await demoState(demo)).chapter,'generation');
      await demo.locator('#tourTransportToggle').click();await demo.keyboard.press('Escape');
      assert.equal((await demoState(demo)).touring,false);report.tour_steps=steps.size;
    });
    const viewer = await newPage({viewport:{width:1440,height:1000}});
    await check('viewer pinned deep link, held output and safe imports',async () => {
      const filename = manifest.recordings.baseline.source_trace;
      assert.match(filename,/^run-\d{8}-\d{6}-\d{3}\.json$/);
      assert.equal(digest(await fs.readFile(path.join(root,'prototype/artifacts',filename))),digest(raw.baseline));
      const events = recordings.baseline.events.filter(event => event.scenario === 'wrong_generation');
      const hold = events.findIndex(event => event.event === 'hold');assert(hold>=0);
      const query = new URLSearchParams({trace:filename,scenario:'wrong_generation',event:String(hold)});
      await viewer.goto(base+'viewer/?'+query);
      await viewer.waitForFunction(() => document.querySelector('#stateValue').textContent === 'holding');
      assert.equal(await viewer.locator('#outputValue').textContent(),'0');
      assert.equal(await viewer.locator('#eventPosition').textContent(),`Event ${hold+1} / ${events.length}`);
      const imported = structuredClone(recordings.baseline);
      imported.environment.machine = '<img src=x onerror="window.importExecuted=true">';
      await viewer.locator('#fileInput').setInputFiles({name:'qa-import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
      await viewer.waitForFunction(() => document.querySelector('#sourceName').textContent.startsWith('qa-import.json'));
      assert.equal(await viewer.locator('#machineValue img').count(),0);
      assert.equal(await viewer.locator('#machineValue').textContent(),imported.environment.machine);
      assert.equal(await viewer.evaluate(() => Boolean(window.importExecuted)),false);
      await viewer.locator('#fileInput').setInputFiles({name:'qa-invalid.json',mimeType:'application/json',buffer:Buffer.from('{"schema_version":99}')});
      await viewer.getByText(/Could not import trace/).waitFor();
      await viewer.goto(base+'viewer/?'+query);
      await viewer.waitForFunction(() => document.querySelector('#stateValue').textContent === 'holding');
    });
    const video = await newPage({viewport:{width:1440,height:1000}});
    await check('video metadata and captions',async () => {
      await video.goto(base+'demo/video.html');
      await video.waitForFunction(() => {const media=document.querySelector('video');return media.readyState>=1&&Number.isFinite(media.duration)&&media.duration>0;});
      const metadata = await video.locator('video').evaluate(media => ({duration_seconds:media.duration,width:media.videoWidth,height:media.videoHeight,captions:media.textTracks.length,error:Boolean(media.error)}));
      assert(metadata.width>0&&metadata.height>0);assert.equal(metadata.captions,1);assert.equal(metadata.error,false);
      report.video=metadata;
    });
    await check('WCAG 2 and 2.1 A/AA plus responsive bounds',async () => {
      await demo.goto(base+'demo/');await demoReady(demo);
      for (const [name,page] of [['demo',demo],['viewer',viewer],['video',video]]) {
        await page.addScriptTag({path:axePath});
        for (const width of [1440,390]) {
          await page.setViewportSize({width,height:1000});
          await page.evaluate(() => document.fonts.ready);
          assert(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),`${name} overflows at ${width}`);
          const violations = await page.evaluate(async () => (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(item => ({id:item.id,nodes:item.nodes.length})));
          report.accessibility.push({page:name,width,violations});
          assert.deepEqual(violations,[],`${name} has accessibility violations at ${width}`);
        }
      }
    });
    await check('standalone offline file without network requests',async () => {
      const offline = await newPage({viewport:{width:390,height:1000}});
      let requests=0;
      await offline.route(/^https?:/,route => {requests++;return route.abort();});
      await offline.goto(pathToFileURL(path.join(root,'prototype/demo/offline.html')).href);
      await demoReady(offline);
      await offline.evaluate(() => document.fonts.ready);
      assert(await offline.evaluate(() => Array.from(document.fonts).some(face => face.family.includes('Inter Tight') && face.status === 'loaded')),'Offline font did not load');
      assert.equal((await demoState(offline)).tourCount,20);
      assert(await offline.locator('#inspectEvent').isHidden());
      await offline.locator('#chapter-budget').click();await offline.locator('#mode-no-restarts').click();
      await offline.locator('#eventScrubber').press('End');
      assert.equal((await demoState(offline)).event.outcome,'contained');assert.equal(await offline.locator('#outputValue').textContent(),'0');
      assert.equal(requests,0);report.offline_http_requests=requests;
    });
    await check('no script errors or external requests',async () => {assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);});
    report.status='passed';
    console.log(`Browser verification passed: ${report.presented_events} event rows, ${report.tour_steps} tour steps, ${report.accessibility.length} accessibility/viewport checks.`);
  } catch (error) {
    report.status='failed';report.failure={check:stage,type:error.name};process.exitCode=1;
    console.error(`Browser verification failed during ${stage}: ${error.message}`);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    if (browser) await browser.close();
    report.completed_at=new Date().toISOString();report.page_errors=pageErrors.length;report.external_requests=externalRequests.length;
    await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  }
})().catch(error => {console.error(`Browser verification could not finish: ${error.name}`);process.exitCode=1;});

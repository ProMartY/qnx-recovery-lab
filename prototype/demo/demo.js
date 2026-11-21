(() => {
  'use strict';
  const CHAPTERS = {
    healthy: { number:'01', title:'Three fresh proposals.', subtitle:'Healthy startup', scenario:'healthy' },
    validation: { number:'02', title:'A message has to pass.', subtitle:'Range and sequence checks', scenario:'invalid' },
    generation: { number:'03', title:'Fresh workers have identities.', subtitle:'Reject a generation mismatch', scenario:'wrong_generation' },
    budget: { number:'04', title:'A restart is a limited resource.', subtitle:'Repeated worker crashes', scenario:'crash_loop' }
  };
  const MODES = ['baseline','no_restarts'];
  const dom = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), element => [element.id,element]));
  const bundled = Boolean(window.RECOVERY_DEMO_DATA);
  let recordings = null;
  let manifest = {};
  let mode = 'baseline';
  let chapter = 'healthy';
  let variant = 'invalid';
  let events = [];
  let moments = [];
  let eventIndex = 0;
  let playing = false;
  let timer = null;
  let momentButtons = [];

  function element(tag,className,text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }
  function text(value,fallback = '—') {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : fallback;
  }
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US',{maximumFractionDigits:3}) : '—'; }
  function human(value) { return text(value).replaceAll('_',' '); }
  function scenario() { return chapter === 'validation' ? variant : CHAPTERS[chapter].scenario; }
  function currentTrace() { return recordings?.[mode]; }
  function currentEvent() { return events[eventIndex]; }
  function summary() { return currentTrace()?.scenarios.find(item => item?.scenario === scenario()); }
  function configValue(key) { return summary()?.[key] ?? currentTrace()?.config?.[key]; }
  function notice(message) { dom.dataNotice.textContent = message; dom.dataNotice.hidden = !message; }
  function announce(message) { dom.announcer.textContent = message; }
  function validateTrace(trace) {
    if (!trace || trace.schema_version !== 1 || !Array.isArray(trace.events) || !Array.isArray(trace.scenarios)) throw new Error('A recording has an unsupported trace schema.');
    if (trace.events.length > 100000 || !trace.events.every(event => event && typeof event.scenario === 'string' && typeof event.event === 'string' && typeof event.state === 'string' && Number.isFinite(event.t_ms) && event.t_ms >= 0)) throw new Error('A recording contains invalid event data.');
    return trace;
  }
  function isMoment(event) {
    if (['start','worker_started','validated','fault_injected','rejected','hold','worker_exit','restart','resumed','locked_out','summary'].includes(event.event)) return true;
    return event.event === 'proposal' && event.reason === 'accepted' && event.state === 'validating' && (event.seq === 1 || event.seq === 2);
  }
  function eventTitle(event) {
    if (!event) return 'Choose a recorded event.';
    switch (event.event) {
      case 'start': return 'Begin with a held output.';
      case 'worker_started': return `Start worker generation ${number(event.generation)}.`;
      case 'proposal': return event.state === 'validating' ? `Accept fresh proposal ${number(event.seq)} of 3.` : `Accept sequence ${number(event.seq)}.`;
      case 'validated': return 'Three fresh proposals release the output.';
      case 'fault_injected': return ({invalid:'Inject an out-of-range command.',replay:'Replay the prior sequence.',wrong_generation:'Send a message from generation 0.',crash_loop:'Inject another worker crash.',crash:'Inject a worker crash.',stall:'Stop worker progress.'})[event.scenario] ?? 'Record the injected fault.';
      case 'rejected': return event.reason === 'generation' ? `Reject received generation ${number(event.received_generation)}.` : event.reason === 'sequence' ? `Reject duplicate sequence ${number(event.seq)}.` : `Reject proposed output ${number(event.proposed_output)}.`;
      case 'hold': return `Hold simulated output at ${number(event.output)}.`;
      case 'worker_exit': return 'Observe the worker exit.';
      case 'restart': return 'Restart after the worker is reaped.';
      case 'resumed': return 'Fresh validation restores the output.';
      case 'locked_out': return 'The restart budget is exhausted.';
      case 'scenario_complete': return 'Complete the recorded scenario.';
      case 'summary': return 'Read the recorded assessment.';
      default: return `${human(event.event)}.`;
    }
  }
  function eventDescription(event) {
    if (!event) return 'The chapter needs a matching recorded scenario.';
    const output = number(event.output);
    const generation = number(event.generation);
    switch (event.event) {
      case 'start': return `The scenario begins in ${human(event.state)} with simulated output ${output}.`;
      case 'worker_started': return `Worker generation ${generation} begins fresh validation. Accepted output is ${output}.`;
      case 'proposal': return `The supervisor accepts sequence ${number(event.seq)}. ${event.state === 'validating' ? 'Fresh proposals accumulate before output is released.' : `The accepted output is ${output}.`}`;
      case 'validated': return `Three fresh proposals have validated generation ${generation}. The supervisor releases simulated output ${output}.`;
      case 'fault_injected': return `The worker announces the ${human(event.scenario)} injection. This event still records accepted output ${output}; the next events show the supervisor's decision.`;
      case 'rejected': return `The supervisor rejects the message for ${human(event.reason)}. ${typeof event.received_generation === 'number' ? `Received generation ${number(event.received_generation)}, active generation ${generation}. ` : ''}Accepted output is ${output}.`;
      case 'hold': return `Output is held at ${output} while the supervisor applies its restart policy. Detection reason: ${human(event.reason)}.`;
      case 'worker_exit': return `The supervisor records ${human(event.reason)}. Accepted output at this event is ${output}.`;
      case 'restart': return `The previous worker has been reaped. Generation ${generation} must earn output through three fresh proposals.`;
      case 'resumed': return `Three fresh proposals validated generation ${generation}. Accepted output resumes at ${output}.`;
      case 'locked_out': return `The configured restart budget is exhausted. The supervisor contains the fault with simulated output ${output}.`;
      case 'scenario_complete': return `The scenario reaches its completion event with accepted output ${output}.`;
      case 'summary': return `The recorded assessment ${event.passed === true ? 'passed' : event.passed === false ? 'failed' : 'is unreported'}${typeof event.outcome === 'string' ? ` with outcome ${human(event.outcome)}` : ''}. Restarts ${number(event.restarts)}, accepted proposals ${number(event.accepted)}, rejected proposals ${number(event.rejected)}.`;
      default: return `State ${human(event.state)}, worker generation ${generation}, simulated output ${output}.`;
    }
  }
  function pause() {
    playing = false;
    clearTimeout(timer);
    timer = null;
    dom.playToggle.textContent = '▶ Play chapter';
    dom.playToggle.setAttribute('aria-pressed','false');
  }
  function moveMoment(direction) {
    const target = direction > 0 ? moments.find(index => index > eventIndex) : moments.findLast(index => index < eventIndex);
    if (target !== undefined) setIndex(target);
    return target !== undefined;
  }
  function playStep() {
    if (!playing) return;
    if (!moveMoment(1)) { pause(); return; }
    timer = setTimeout(playStep,1000);
  }
  function freshCount(event) {
    if (!event) return 0;
    const accepted = new Set();
    let completed = false;
    for (const item of events.slice(0,eventIndex + 1)) {
      if (item.generation !== event.generation) continue;
      if (item.event === 'proposal' && item.reason === 'accepted') accepted.add(item.seq);
      if (item.event === 'validated' || item.event === 'resumed') completed = true;
    }
    return completed ? 3 : Math.min(3,accepted.size);
  }
  function renderMoments() {
    dom.momentList.replaceChildren();
    momentButtons = [];
    for (const index of moments) {
      const event = events[index];
      const button = element('button','',eventTitle(event));
      button.type = 'button';
      button.dataset.eventIndex = String(index);
      button.append(element('time','',`${number(event.t_ms)} ms`));
      button.addEventListener('click',() => { pause(); setIndex(index); });
      const item = element('li');
      item.append(button);
      dom.momentList.append(item);
      momentButtons.push({button,index});
    }
    dom.momentCount.textContent = `${moments.length} moments`;
  }
  function chooseContext(nextMode,nextChapter,nextVariant,preserveMoment = false) {
    const prior = currentEvent();
    const occurrence = prior ? events.slice(0,eventIndex + 1).filter(event => event.event === prior.event).length - 1 : 0;
    pause();
    mode = nextMode;
    chapter = nextChapter;
    variant = nextVariant;
    events = (currentTrace()?.events ?? []).filter(event => event.scenario === scenario()).map((event,index) => ({...event,sourceIndex:index})).sort((a,b) => a.t_ms - b.t_ms || a.sourceIndex - b.sourceIndex);
    moments = events.map((event,index) => isMoment(event) ? index : -1).filter(index => index >= 0);
    eventIndex = 0;
    if (preserveMoment && prior) {
      const matches = events.map((event,index) => event.event === prior.event ? index : -1).filter(index => index >= 0);
      if (matches.length) eventIndex = matches[Math.min(occurrence,matches.length - 1)];
      else if (prior.event === 'resumed' || prior.event === 'restart') eventIndex = Math.max(0,events.findIndex(event => event.event === 'locked_out'));
    }
    for (const [id] of Object.entries(CHAPTERS)) {
      const button = dom[`chapter-${id}`];
      button.disabled = !recordings;
      if (id === chapter) button.setAttribute('aria-current','step');
      else button.removeAttribute('aria-current');
    }
    dom['mode-baseline'].setAttribute('aria-pressed',String(mode === 'baseline'));
    dom['mode-no-restarts'].setAttribute('aria-pressed',String(mode === 'no_restarts'));
    dom.validationVariants.hidden = chapter !== 'validation';
    dom['variant-invalid'].setAttribute('aria-pressed',String(variant === 'invalid'));
    dom['variant-replay'].setAttribute('aria-pressed',String(variant === 'replay'));
    dom.chapterEyebrow.textContent = `Chapter ${CHAPTERS[chapter].number} · ${CHAPTERS[chapter].subtitle}`;
    dom.chapterTitle.textContent = CHAPTERS[chapter].title;
    dom.scenarioLabel.textContent = `Scenario · ${human(scenario())}`;
    dom.eventScrubber.max = String(Math.max(0,events.length - 1));
    dom.eventScrubber.disabled = !events.length;
    const environment = currentTrace()?.environment ?? {};
    dom.environmentLabel.textContent = `${text(environment.os,'QNX')} ${text(environment.release,'8')} guest · ${text(environment.emulator,'runtime unreported')}`;
    renderMoments();
    renderEvent();
    if (recordings) notice(events.length ? '' : 'This recording does not contain the selected scenario. Choose another chapter or recording.');
    announce(`${mode === 'baseline' ? 'Baseline' : 'No restarts'} recording. ${CHAPTERS[chapter].subtitle}.`);
  }
  function renderEvent() {
    const event = currentEvent();
    if (!event) return;
    const state = event.state;
    const held = ['validating','holding','locked_out'].includes(state);
    dom.architecture.dataset.tone = event.event === 'rejected' ? 'rejected' : held ? 'hold' : state === 'running' ? 'valid' : 'neutral';
    dom.supervisorState.textContent = human(state);
    dom.workerGeneration.textContent = `G${number(event.generation)}`;
    const messageGeneration = typeof event.received_generation === 'number' ? `received G${number(event.received_generation)}` : `active G${number(event.generation)}`;
    dom.workerMessage.textContent = `Sequence ${number(event.seq)} · ${messageGeneration}${['proposal','rejected'].includes(event.event) && typeof event.proposed_output === 'number' ? ` · proposed ${number(event.proposed_output)}` : ''}`;
    const fresh = freshCount(event);
    for (const [index,dot] of Array.from(dom.validationDots.children).entries()) dot.classList.toggle('filled',index < fresh);
    dom.validationDots.setAttribute('aria-label',`${fresh} of 3 fresh proposals recorded in generation ${number(event.generation)}`);
    const restarts = events.slice(0,eventIndex + 1).filter(item => item.event === 'restart').length;
    dom.restartUsage.textContent = `${restarts} / ${number(configValue('restart_limit'))}`;
    dom.outputValue.textContent = number(event.output);
    dom.outputState.textContent = state === 'locked_out' ? 'Locked out' : state === 'running' ? 'Valid output' : state === 'holding' ? 'Output held' : state === 'validating' ? 'Fresh validation' : state === 'stopped' ? 'Scenario complete' : human(state);
    dom.outputExplanation.textContent = state === 'locked_out' ? 'Restart budget exhausted.' : state === 'validating' ? 'Three fresh proposals required.' : state === 'holding' ? 'Supervisor retains control.' : state === 'running' ? 'Validated numeric command.' : 'Recorded final output.';
    dom.guestTime.textContent = `Guest time · ${number(event.t_ms)} ms`;
    dom.eventName.textContent = human(event.event);
    dom.eventReason.textContent = text(event.reason,'');
    dom.eventPosition.textContent = `${eventIndex + 1} / ${events.length}`;
    dom.momentTitle.textContent = eventTitle(event);
    dom.momentDescription.textContent = eventDescription(event);
    dom.eventScrubber.value = String(eventIndex);
    dom.eventScrubber.setAttribute('aria-valuetext',`Event ${eventIndex + 1} of ${events.length}, ${human(event.event)}, guest time ${number(event.t_ms)} milliseconds`);
    dom.previousEvent.disabled = eventIndex <= 0;
    dom.nextEvent.disabled = eventIndex >= events.length - 1;
    dom.previousMoment.disabled = !moments.some(index => index < eventIndex);
    dom.nextMoment.disabled = !moments.some(index => index > eventIndex);
    dom.playToggle.disabled = moments.length < 2;
    const activeMoment = moments.findLast(index => index <= eventIndex);
    for (const item of momentButtons) {
      if (item.index === activeMoment) item.button.setAttribute('aria-current','step');
      else item.button.removeAttribute('aria-current');
    }
    const activeButton = momentButtons.find(item => item.index === activeMoment)?.button;
    if (activeButton) {
      const bounds = dom.momentList.getBoundingClientRect();
      const row = activeButton.getBoundingClientRect();
      if (row.bottom > bounds.bottom) dom.momentList.scrollTop += row.bottom - bounds.bottom;
      else if (row.top < bounds.top) dom.momentList.scrollTop -= bounds.top - row.top;
    }
    const metadata = manifest.recordings?.[mode];
    const filename = metadata?.source_trace ?? metadata?.source_file;
    const canInspect = !bundled && typeof filename === 'string' && /^run-\d{8}-\d{6}-\d{3}\.json$/.test(filename);
    dom.inspectEvent.hidden = !canInspect;
    if (canInspect) dom.inspectEvent.href = `../viewer/?${new URLSearchParams({trace:filename,scenario:scenario(),event:String(eventIndex)})}`;
    window.dispatchEvent(new CustomEvent('demo:step',{detail:getState()}));
  }
  function setIndex(index) {
    if (!events.length) return;
    eventIndex = Math.max(0,Math.min(events.length - 1,index));
    renderEvent();
  }
  function getState() {
    const event = currentEvent();
    return {ready:Boolean(recordings),mode,chapter,scenario:scenario(),eventIndex,eventCount:events.length,momentCount:moments.length,playing,event:event ? {...event} : null};
  }
  function renderEvidence() {
    dom.evidenceRecords.replaceChildren();
    const totals = [];
    for (const key of MODES) {
      const trace = recordings[key];
      const metadata = manifest.recordings?.[key] ?? {};
      const verified = metadata.evidence?.verified === true;
      const title = key === 'baseline' ? 'Baseline' : 'No restarts';
      const result = element('section','evidence-record');
      result.dataset.mode = key;
      result.append(element('h3','',title));
      const passed = trace.scenarios.filter(item => item?.passed === true).length;
      const contained = trace.scenarios.filter(item => item?.passed === true && item?.outcome === 'contained').length;
      const status = element('p','evidence-result',`${passed} / ${trace.scenarios.length} checks passed · ${contained} contained`);
      if (passed !== trace.scenarios.length) status.style.color = 'var(--coral)';
      result.append(status,element('p','',`${trace.events.length} recorded events · ${verified ? 'verification metadata present' : 'verification metadata unreported'}`));
      const details = element('dl');
      for (const [label,value] of [
        ['QNX guest',[text(trace.environment?.os,''),text(trace.environment?.release,''),text(trace.environment?.machine,'')].filter(Boolean).join(' ')],
        ['Runtime',trace.environment?.emulator],
        ['Recorded at',trace.recorded_at],
        ['Source trace',metadata.source_trace ?? metadata.source_file],
        ['Trace SHA-256',metadata.sha256],
        ['Console log',metadata.evidence?.console_log ?? trace.evidence?.console],
        ['Console SHA-256',metadata.evidence?.console_sha256],
        ['Source SHA-256',metadata.evidence?.source_sha256 ?? trace.evidence?.source_sha256],
        ['Binary SHA-256',trace.evidence?.binary_sha256],
        ['Recorded configuration',`fault_at ${number(trace.config?.fault_at)} · watchdog ${number(trace.config?.watchdog_ms)} ms · restart limit ${number(trace.config?.restart_limit)}`]
      ]) {
        const row = element('div');
        row.append(element('dt','',label),element('dd','',text(value,'Unreported')));
        details.append(row);
      }
      result.append(details);
      dom.evidenceRecords.append(result);
      totals.push(`${title} ${trace.events.length} events`);
    }
    dom.evidenceTotals.textContent = totals.join(' · ');
    dom.baselineLimit.textContent = `${number(recordings.baseline.config?.restart_limit)} restarts allowed`;
    dom.boundaryLimit.textContent = `${number(recordings.no_restarts.config?.restart_limit)} restarts allowed`;
  }
  async function fetchJSON(path) {
    const response = await fetch(path,{cache:'no-store'});
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
    return response.json();
  }
  async function initialize() {
    try {
      let data;
      if (bundled) {
        data = window.RECOVERY_DEMO_DATA;
        manifest = window.RECOVERY_DEMO_MANIFEST ?? {};
      } else {
        const loaded = await Promise.all([fetchJSON('./manifest.json'),fetchJSON('./data/baseline.json'),fetchJSON('./data/no-restarts.json')]);
        manifest = loaded[0];
        data = {baseline:loaded[1],no_restarts:loaded[2]};
      }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The demo manifest is invalid.');
      recordings = {baseline:validateTrace(data?.baseline),no_restarts:validateTrace(data?.no_restarts)};
      dom['mode-baseline'].disabled = false;
      dom['mode-no-restarts'].disabled = false;
      renderEvidence();
      chooseContext(mode,chapter,variant);
      window.dispatchEvent(new CustomEvent('demo:ready',{detail:getState()}));
    } catch (error) {
      recordings = null;
      notice(`Recorded evidence could not be loaded. ${error.message} Open the generated offline demo, or serve this folder with its manifest and data files.`);
      dom.momentTitle.textContent = 'Recorded evidence is unavailable.';
      dom.momentDescription.textContent = 'The presentation needs the verified demo recordings.';
    }
  }
  for (const id of Object.keys(CHAPTERS)) dom[`chapter-${id}`].addEventListener('click',() => chooseContext(mode,id,variant));
  dom['mode-baseline'].addEventListener('click',() => chooseContext('baseline',chapter,variant,true));
  dom['mode-no-restarts'].addEventListener('click',() => chooseContext('no_restarts',chapter,variant,true));
  for (const id of ['invalid','replay']) dom[`variant-${id}`].addEventListener('click',() => chooseContext(mode,chapter,id));
  dom.previousMoment.addEventListener('click',() => {pause();moveMoment(-1);});
  dom.nextMoment.addEventListener('click',() => {pause();moveMoment(1);});
  dom.previousEvent.addEventListener('click',() => {pause();setIndex(eventIndex - 1);});
  dom.nextEvent.addEventListener('click',() => {pause();setIndex(eventIndex + 1);});
  dom.eventScrubber.addEventListener('input',() => {pause();setIndex(Number(dom.eventScrubber.value));});
  dom.playToggle.addEventListener('click',() => {
    if (playing) {pause();return;}
    if (!moments.some(index => index > eventIndex)) setIndex(0);
    playing = true;
    dom.playToggle.textContent = 'Ⅱ Pause chapter';
    dom.playToggle.setAttribute('aria-pressed','true');
    timer = setTimeout(playStep,1000);
  });
  document.addEventListener('keydown',event => {
    if (!recordings || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,select,textarea')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault();pause();moveMoment(event.key === 'ArrowRight' ? 1 : -1);}
    if (event.code === 'Space' && !event.target.closest('button,a,summary')) {event.preventDefault();dom.playToggle.click();}
  });
  document.addEventListener('visibilitychange',() => {if (document.hidden) pause();});
  window.recoveryDemo = Object.freeze({getState});
  initialize();
})();

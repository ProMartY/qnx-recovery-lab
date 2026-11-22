(() => {
  'use strict';
  const CHAPTERS = {
    healthy: { number:'01', title:'Three fresh proposals.', subtitle:'Healthy startup', scenario:'healthy' },
    validation: { number:'02', title:'A message has to pass.', subtitle:'Range and sequence checks', scenario:'invalid' },
    generation: { number:'03', title:'Fresh workers have identities.', subtitle:'Reject a generation mismatch', scenario:'wrong_generation' },
    budget: { number:'04', title:'A restart is a limited resource.', subtitle:'Repeated worker crashes', scenario:'crash_loop' }
  };
  const MODES = ['baseline','no_restarts'];
  const TOUR = [
    ['baseline','healthy','start','Begin with zero output'],
    ['baseline','healthy','proposal','Fresh proposal one',event => event.seq === 1],
    ['baseline','healthy','proposal','Fresh proposal two',event => event.seq === 2],
    ['baseline','healthy','validated','Three proposals earn the output'],
    ['baseline','validation','fault_injected','Announce an invalid command'],
    ['baseline','validation','rejected','Reject the proposed command'],
    ['baseline','validation','hold','Hold zero before recovery'],
    ['baseline','validation','restart','Spend one restart'],
    ['baseline','validation','proposal','Replacement proposal one',event => event.generation === 2 && event.seq === 1],
    ['baseline','validation','proposal','Replacement proposal two',event => event.generation === 2 && event.seq === 2],
    ['baseline','validation','resumed','Fresh validation restores output'],
    ['baseline','generation','fault_injected','Announce a generation mismatch'],
    ['baseline','generation','rejected','Reject generation zero'],
    ['baseline','generation','resumed','Validate the replacement identity'],
    ['baseline','budget','worker_exit','Observe an actual worker exit'],
    ['baseline','budget','restart','Apply the bounded restart policy'],
    ['baseline','budget','resumed','Validate a replacement worker'],
    ['baseline','budget','locked_out','Contain repeated crashes'],
    ['no_restarts','validation','rejected','Compare the no-restart recording'],
    ['no_restarts','validation','locked_out','Contain the first detected fault']
  ];
  const dom = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), element => [element.id,element]));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bundled = Boolean(window.RECOVERY_DEMO_DATA);
  if (bundled && dom.fullViewerLink) dom.fullViewerLink.hidden = true;
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
  let tourSteps = [];
  let touring = false;
  let tourIndex = -1;
  let tourTimer = null;
  let tourCompleted = false;

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
    renderPlaybackPace();
  }
  function presentationDelay(event,isTour = false) {
    const words = eventDescription(event).split(/\s+/).length;
    const readingTime = Math.round(words / 4 * 1000);
    const minimum = reducedMotion.matches ? 4500 : isTour ? 2600 : 1800;
    return Math.min(reducedMotion.matches ? 7500 : 5500,Math.max(minimum,readingTime));
  }
  function renderPlaybackPace() {
    if (!dom.playbackPace) return;
    dom.playbackPace.textContent = touring ? 'Tour pace · time to read each step' : reducedMotion.matches ? 'Presentation pace · slower reading pauses' : 'Presentation pace · adaptive reading pauses';
    dom.playbackPace.title = 'Presentation pauses do not represent elapsed guest time. Guest timestamps are copied from the recording.';
  }
  function renderTourControls() {
    for (const button of [dom.tourToggle,dom.tourTransportToggle].filter(Boolean)) {
      button.disabled = !tourSteps.length;
      button.textContent = touring ? 'Pause guided tour' : tourCompleted ? 'Replay guided tour' : tourIndex >= 0 ? 'Resume guided tour' : 'Start guided tour';
      button.setAttribute('aria-pressed',String(touring));
    }
    if (dom.tourProgress) {
      dom.tourProgress.textContent = !recordings ? 'Tour unavailable until evidence loads.' : !tourSteps.length ? 'Tour needs both complete recordings.' : tourCompleted ? `Tour complete · ${tourSteps.length} recorded moments` : tourIndex < 0 ? `${tourSteps.length} recorded moments · ready when you are` : `${touring ? 'Tour' : 'Paused'} ${tourIndex + 1} / ${tourSteps.length} · ${tourSteps[tourIndex].label}`;
    }
    renderPlaybackPace();
  }
  function pauseTour(reset = false) {
    touring = false;
    clearTimeout(tourTimer);
    tourTimer = null;
    if (reset) { tourIndex = -1; tourCompleted = false; }
    renderTourControls();
  }
  function manualNavigation() {
    pause();
    pauseTour(true);
  }
  function buildTour() {
    tourSteps = [];
    for (const [recording,nextChapter,kind,label,predicate] of TOUR) {
      const nextScenario = nextChapter === 'validation' ? 'invalid' : CHAPTERS[nextChapter].scenario;
      const candidates = recordings[recording].events.filter(event => event.scenario === nextScenario).map((event,index) => ({...event,sourceIndex:index})).sort((a,b) => a.t_ms - b.t_ms || a.sourceIndex - b.sourceIndex);
      const index = candidates.findIndex(event => event.event === kind && (!predicate || predicate(event)));
      if (index < 0) { tourSteps = []; break; }
      tourSteps.push({mode:recording,chapter:nextChapter,index,label});
    }
    renderTourControls();
  }
  function showTourStep() {
    const step = tourSteps[tourIndex];
    if (!step) return;
    if (mode !== step.mode || chapter !== step.chapter || (chapter === 'validation' && variant !== 'invalid')) chooseContext(step.mode,step.chapter,'invalid',false,true,step.index);
    else setIndex(step.index);
    renderTourControls();
    announce(`Guided tour, step ${tourIndex + 1} of ${tourSteps.length}. ${step.label}. ${eventTitle(currentEvent())}`);
  }
  function scheduleTourStep() {
    tourTimer = setTimeout(() => {
      if (!touring) return;
      if (tourIndex >= tourSteps.length - 1) {
        tourCompleted = true;
        pauseTour();
        announce('Guided tour complete. Both recorded restart policies have been shown.');
        return;
      }
      tourIndex++;
      showTourStep();
      scheduleTourStep();
    },presentationDelay(currentEvent(),true));
  }
  function toggleTour() {
    if (!tourSteps.length) return;
    if (touring) { pauseTour(); return; }
    pause();
    if (tourCompleted || tourIndex < 0) {
      tourIndex = 0;
      tourCompleted = false;
    }
    touring = true;
    showTourStep();
    scheduleTourStep();
  }
  function moveMoment(direction) {
    const target = direction > 0 ? moments.find(index => index > eventIndex) : moments.findLast(index => index < eventIndex);
    if (target !== undefined) setIndex(target);
    return target !== undefined;
  }
  function playStep() {
    if (!playing) return;
    if (!moveMoment(1)) { pause(); return; }
    timer = setTimeout(playStep,presentationDelay(currentEvent()));
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
      button.addEventListener('click',() => { manualNavigation(); setIndex(index); });
      const item = element('li');
      item.append(button);
      dom.momentList.append(item);
      momentButtons.push({button,index});
    }
    dom.momentCount.textContent = `${moments.length} moments`;
  }
  function chooseContext(nextMode,nextChapter,nextVariant,preserveMoment = false,fromTour = false,nextEventIndex = null) {
    const prior = currentEvent();
    const occurrence = prior ? events.slice(0,eventIndex + 1).filter(event => event.event === prior.event).length - 1 : 0;
    pause();
    if (!fromTour) pauseTour(true);
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
    if (Number.isFinite(nextEventIndex) && events.length) eventIndex = Math.max(0,Math.min(events.length - 1,Math.trunc(nextEventIndex)));
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
    for (const value of ['invalid','replay']) dom[`variant-${value}`].disabled = !recordings || !currentTrace().events.some(event => event.scenario === value);
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
    if (!event) { renderEmpty(); return; }
    const state = event.state;
    const held = ['validating','holding','locked_out'].includes(state);
    dom.architecture.dataset.tone = event.event === 'rejected' ? 'rejected' : held ? 'hold' : state === 'running' ? 'valid' : 'neutral';
    renderGraph(event);
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
    if (dom.eventCounterLabel) dom.eventCounterLabel.textContent = `Event ${eventIndex + 1} of ${events.length}`;
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
    else dom.inspectEvent.removeAttribute('href');
    renderPlaybackPace();
    window.dispatchEvent(new CustomEvent('demo:step',{detail:getState()}));
  }
  function renderEmpty(title = 'No recorded events in this chapter.',description = 'Choose another chapter or recording to inspect its evidence.') {
    dom.architecture.dataset.tone = 'neutral';
    renderGraph(null);
    dom.supervisorState.textContent = 'No recorded event';
    dom.workerGeneration.textContent = 'G—';
    dom.workerMessage.textContent = 'No recorded message selected.';
    for (const dot of dom.validationDots.children) dot.classList.remove('filled');
    dom.validationDots.setAttribute('aria-label','Fresh proposals unreported');
    dom.restartUsage.textContent = '— / —';
    dom.outputValue.textContent = '—';
    dom.outputState.textContent = 'Awaiting evidence';
    dom.outputExplanation.textContent = 'No recorded output selected.';
    dom.guestTime.textContent = 'Guest time · —';
    dom.eventName.textContent = '—';
    dom.eventReason.textContent = '';
    dom.eventPosition.textContent = '0 / 0';
    if (dom.eventCounterLabel) dom.eventCounterLabel.textContent = 'Event 0 of 0';
    dom.momentTitle.textContent = title;
    dom.momentDescription.textContent = description;
    dom.eventScrubber.value = '0';
    dom.eventScrubber.max = '0';
    dom.eventScrubber.setAttribute('aria-valuetext','No recorded events available');
    for (const id of ['previousEvent','nextEvent','previousMoment','nextMoment','playToggle','eventScrubber']) dom[id].disabled = true;
    dom.inspectEvent.hidden = true;
    dom.inspectEvent.removeAttribute('href');
    window.dispatchEvent(new CustomEvent('demo:step',{detail:getState()}));
  }
  function renderGraph(event) {
    const packet = event && ['proposal','rejected','validated','resumed'].includes(event.event);
    const rejected = event?.event === 'rejected';
    const signal = !packet ? 'none' : rejected ? 'rejected' : event.state === 'running' ? 'accepted' : 'held';
    dom.architecture.dataset.event = event?.event ?? 'none';
    dom.architecture.dataset.state = event?.state ?? 'unavailable';
    dom.architecture.dataset.signal = signal;
    const receivedGeneration = event?.received_generation ?? event?.generation;
    if (dom.liveSequence) dom.liveSequence.textContent = event ? `SEQ ${number(event.seq)} / G${number(receivedGeneration)}` : 'SEQ — / G—';
    if (dom.packetLabel) {
      dom.packetLabel.textContent = packet ? `${rejected ? '× ' : ''}seq ${number(event.seq)} / G${number(receivedGeneration)} / proposed ${number(event.proposed_output)}` : '';
      dom.packetLabel.style.visibility = packet ? 'visible' : 'hidden';
      dom.packetLabel.dataset.signal = signal;
    }
    if (dom.gateStatus) {
      dom.gateStatus.textContent = !event ? 'NO EVIDENCE' : rejected ? 'REJECT' : signal === 'accepted' ? 'PASS' : event.state === 'locked_out' ? 'LOCKED OUT' : ['validating','holding','failed'].includes(event.state) ? 'HOLD' : event.state === 'stopped' ? 'STOPPED' : 'WAIT';
      dom.gateStatus.dataset.signal = signal;
      dom.gateStatus.dataset.reason = event?.reason ?? '';
    }
    const route = dom.signalRoute;
    const marker = dom.packetMarker;
    if (route) {
      const ratio = Number.parseFloat(route.dataset.gateRatio);
      // A blocked packet needs an explicit gate location to avoid drawing past it.
      const fraction = signal === 'accepted' ? 1 : packet && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 0;
      route.setAttribute('pathLength','100');
      route.style.strokeDasharray = `${fraction * 100} 100`;
      route.style.strokeDashoffset = '0';
      route.style.visibility = fraction > 0 ? 'visible' : 'hidden';
      route.dataset.signal = signal;
      if (marker) {
        marker.dataset.signal = signal;
        marker.style.visibility = 'hidden';
        if (fraction > 0 && typeof route.getTotalLength === 'function') {
          const length = route.getTotalLength();
          if (length > 0) {
            const point = route.getPointAtLength(length * fraction);
            marker.setAttribute('cx',String(point.x));
            marker.setAttribute('cy',String(point.y));
            marker.style.visibility = 'visible';
          }
        }
      }
    } else if (marker) marker.style.visibility = 'hidden';
    if (dom.currentOutputMeter) {
      const output = Number.isFinite(event?.output) ? event.output : 0;
      const configuredMaximum = Number.parseFloat(dom.currentOutputMeter.dataset.maxOutput);
      const maximum = configuredMaximum > 0 ? configuredMaximum : 60;
      dom.currentOutputMeter.dataset.output = event ? String(event.output) : '';
      dom.currentOutputMeter.style.setProperty('--output-fraction',String(Math.max(0,Math.min(1,output / maximum))));
    }
  }
  function renderRecordingCounts() {
    const traces = recordings ? Object.values(recordings) : [];
    if (dom.heroEventCount) dom.heroEventCount.textContent = traces.length ? number(traces.reduce((total,trace) => total + trace.events.length,0)) : '—';
    if (dom.heroScenarioCount) dom.heroScenarioCount.textContent = traces.length ? number(new Set(traces.flatMap(trace => trace.events.map(event => event.scenario))).size) : '—';
  }
  function setIndex(index) {
    if (!events.length || !Number.isFinite(index)) return;
    eventIndex = Math.max(0,Math.min(events.length - 1,Math.trunc(index)));
    renderEvent();
  }
  function getState() {
    const event = currentEvent();
    return {ready:Boolean(recordings),mode,chapter,scenario:scenario(),eventIndex,eventCount:events.length,momentCount:moments.length,playing,event:event ? {...event} : null,touring,tourIndex,tourCount:tourSteps.length,tourCompleted};
  }
  function renderEvidence() {
    renderRecordingCounts();
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),10000);
    try {
      const response = await fetch(path,{cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function initialize() {
    dom.architecture.setAttribute('aria-busy','true');
    for (const id of ['mode-baseline','mode-no-restarts','variant-invalid','variant-replay',...Object.keys(CHAPTERS).map(key => `chapter-${key}`)]) dom[id].disabled = true;
    renderEmpty('Recorded evidence is loading.','The demonstration reads the bundled QNX guest recordings.');
    renderRecordingCounts();
    renderTourControls();
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
      buildTour();
      chooseContext(mode,chapter,variant);
      dom.architecture.setAttribute('aria-busy','false');
      window.dispatchEvent(new CustomEvent('demo:ready',{detail:getState()}));
    } catch (error) {
      pause();
      pauseTour(true);
      recordings = null;
      manifest = {};
      events = [];
      moments = [];
      eventIndex = 0;
      tourSteps = [];
      dom.momentList.replaceChildren();
      momentButtons = [];
      dom.momentCount.textContent = '0 moments';
      dom.evidenceRecords.replaceChildren();
      dom.evidenceTotals.textContent = 'Evidence unavailable';
      dom.baselineLimit.textContent = 'Restarts unreported';
      dom.boundaryLimit.textContent = 'Restarts unreported';
      dom.environmentLabel.textContent = 'QNX evidence unavailable';
      dom.scenarioLabel.textContent = 'Scenario · —';
      renderRecordingCounts();
      for (const id of ['mode-baseline','mode-no-restarts','variant-invalid','variant-replay',...Object.keys(CHAPTERS).map(key => `chapter-${key}`)]) dom[id].disabled = true;
      renderEmpty('Recorded evidence is unavailable.','The presentation needs both verified demo recordings. Reload after restoring the manifest and data files.');
      renderTourControls();
      dom.architecture.setAttribute('aria-busy','false');
      notice(`Recorded evidence could not be loaded. ${error.message} Open the generated offline demo, or serve this folder with its manifest and data files.`);
    }
  }
  for (const id of Object.keys(CHAPTERS)) dom[`chapter-${id}`].addEventListener('click',() => chooseContext(mode,id,variant));
  dom['mode-baseline'].addEventListener('click',() => chooseContext('baseline',chapter,variant,true));
  dom['mode-no-restarts'].addEventListener('click',() => chooseContext('no_restarts',chapter,variant,true));
  for (const id of ['invalid','replay']) dom[`variant-${id}`].addEventListener('click',() => chooseContext(mode,chapter,id));
  dom.previousMoment.addEventListener('click',() => {manualNavigation();moveMoment(-1);});
  dom.nextMoment.addEventListener('click',() => {manualNavigation();moveMoment(1);});
  dom.previousEvent.addEventListener('click',() => {manualNavigation();setIndex(eventIndex - 1);});
  dom.nextEvent.addEventListener('click',() => {manualNavigation();setIndex(eventIndex + 1);});
  dom.eventScrubber.addEventListener('input',() => {manualNavigation();setIndex(Number(dom.eventScrubber.value));});
  dom.playToggle.addEventListener('click',() => {
    if (playing) {pause();return;}
    pauseTour(true);
    if (!moments.some(index => index > eventIndex)) setIndex(0);
    playing = true;
    dom.playToggle.textContent = 'Ⅱ Pause chapter';
    dom.playToggle.setAttribute('aria-pressed','true');
    timer = setTimeout(playStep,presentationDelay(currentEvent()));
  });
  dom.tourToggle?.addEventListener('click',toggleTour);
  dom.tourTransportToggle?.addEventListener('click',toggleTour);
  document.addEventListener('keydown',event => {
    if (event.key === 'Escape' && (playing || touring)) {event.preventDefault();pause();pauseTour();announce('Presentation playback paused.');return;}
    if (!recordings || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,select,textarea')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault();manualNavigation();moveMoment(event.key === 'ArrowRight' ? 1 : -1);}
    if (event.code === 'Space' && !event.target.closest('button,a,summary')) {event.preventDefault();dom.playToggle.click();}
  });
  document.addEventListener('visibilitychange',() => {if (document.hidden) {pause();pauseTour();}});
  reducedMotion.addEventListener('change',() => {pause();pauseTour();});
  window.recoveryDemo = Object.freeze({getState});
  initialize();
})();

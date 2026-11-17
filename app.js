const VF = Vex.Flow;
const $ = id => document.getElementById(id);
const child = (node, name) => [...(node?.children || [])].find(item => item.tagName === name);
const children = (node, name) => [...(node?.children || [])].filter(item => item.tagName === name);
const value = (node, name) => child(node, name)?.textContent?.trim();
const durationCodes = { whole:'w', half:'h', quarter:'q', eighth:'8', '16th':'16', '32nd':'32', '64th':'64', measure:'w' };
const lengths = { whole:4, half:2, quarter:1, eighth:.5, '16th':.25, '32nd':.125, '64th':.0625 };
const pitchNames = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];
const spellings = [{name:'c',tpc:14,semitone:0},{name:'d',tpc:16,semitone:2},{name:'e',tpc:18,semitone:4},{name:'f',tpc:13,semitone:5},{name:'g',tpc:15,semitone:7},{name:'a',tpc:17,semitone:9},{name:'b',tpc:19,semitone:11}];
const accidentals = {accidentalSharp:'#',accidentalFlat:'b',accidentalNatural:'n',accidentalDoubleSharp:'##',accidentalDoubleFlat:'bb'};
const keyNames = { '-7':'Cb','-6':'Gb','-5':'Db','-4':'Ab','-3':'Eb','-2':'Bb','-1':'F',0:'C',1:'G',2:'D',3:'A',4:'E',5:'B',6:'F#',7:'C#' };
let lessons = [], visible = [], selected = null, phase = 0, parsed = null;
let audioContext, musicBus, metronomeBus, snareBuffer;
let oscillators = [], timers = [], highlights = [], playing = false, originalBpm = 90;
let timbre = 'voice';
let cue = {measure:0,offset:0,note:false}, noteHits = [], measureBoxes = [], cueLine = null;

function noteKey(midi) { return `${pitchNames[midi % 12]}/${Math.floor(midi / 12) - 1}`; }
function writtenNote(note) {
  const base = spellings.find(item => Number.isFinite(note.tpc) && (note.tpc-item.tpc)%7===0 && Math.abs((note.tpc-item.tpc)/7)<=2);
  if (!base) return noteKey(note.midi);
  const alteration=(note.tpc-base.tpc)/7;
  const octave=(note.midi-base.semitone-alteration)/12-1;
  if (!Number.isInteger(octave)) return noteKey(note.midi);
  return `${base.name}${alteration>0?'#'.repeat(alteration):'b'.repeat(-alteration)}/${octave}`;
}
function fileUrl(path) { return path.split('/').map(encodeURIComponent).join('/'); }

function readScore(bytes) {
  const files = fflate.unzipSync(new Uint8Array(bytes));
  const name = Object.keys(files).find(name => name.toLowerCase().endsWith('.mscx'));
  if (!name) throw new Error('O arquivo MSCZ não contém uma partitura MSCX.');
  const xml = new TextDecoder().decode(files[name]);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('O XML da partitura está inválido.');
  const score = doc.querySelector('Score');
  if (!score) throw new Error('Partitura não encontrada no MSCZ.');
  const staffNodes = children(score, 'Staff').filter(item => children(item, 'Measure').length);
  if (!staffNodes.length) throw new Error('Esta partitura não contém pautas convencionais.');
  const partStaves = children(score, 'Part').flatMap(part => children(part, 'Staff'));
  const title = [...doc.querySelectorAll('metaTag')].find(item => item.getAttribute('name') === 'workTitle')?.textContent || selected?.title || 'Partitura';
  const staves = staffNodes.map((staff, staffIndex) => {
    const partStaff = partStaves.find(item => item.getAttribute('id') === staff.getAttribute('id')) || partStaves[staffIndex];
    const staffType = child(partStaff, 'StaffType');
    const percussion = staffType?.getAttribute('group') === 'percussion' || /PERC/i.test(value(partStaff, 'defaultClef') || '');
    const lines = percussion ? (Number(value(staffType, 'lines')) || 1) : 5;
    let clef = percussion ? 'percussion' : 'treble', tempo = 90, time = [4,4], key = 'C';
    return children(staff, 'Measure').map(measure => {
      const voices = children(measure, 'voice').map(voice => {
        const events = [];
        events.tuplets = [];
        let activeTuplet = null;
        let voiceOffset = 0;
        for (const item of voice.children) {
        if (item.tagName === 'Tuplet') {
          activeTuplet = {normal:Number(value(item,'normalNotes')) || 2,actual:Number(value(item,'actualNotes')) || 3,indices:[]};
          events.tuplets.push(activeTuplet);
          continue;
        }
        if (item.tagName === 'endTuplet') { activeTuplet = null; continue; }
        if (item.tagName === 'TimeSig') time = [Number(value(item,'sigN')) || 4, Number(value(item,'sigD')) || 4];
        if (item.tagName === 'KeySig') key = keyNames[value(item,'concertKey')] || 'C';
        if (item.tagName === 'Tempo') tempo = Math.round((Number(value(item,'tempo')) || 1.5)*60);
        if (item.tagName === 'Clef') {
          const sign = value(item,'concertClefType') || value(item,'subtype') || '';
          clef = percussion || /percussion|perc/i.test(sign) ? 'percussion' : /bass|fclef|^F$/i.test(sign) ? 'bass' : /alto|cclef|^C$/i.test(sign) ? 'alto' : 'treble';
        }
        if (!['Chord','Rest'].includes(item.tagName)) continue;
        const type = value(item,'durationType') || 'quarter';
        if (!durationCodes[type]) continue;
        const dots = Math.min(2, Number(value(item,'dots')) || 0);
        const notes = children(item,'Note').map(note => ({midi:value(note,'pitch')==null?NaN:Number(value(note,'pitch')),tpc:value(note,'tpc')==null?NaN:Number(value(note,'tpc')),accidental:accidentals[value(child(note,'Accidental'),'subtype')]})).filter(note => Number.isFinite(note.midi));
        const pitches = notes.map(note => note.midi);
        const length = (type === 'measure' ? time[0]*4/time[1] : lengths[type]) * (dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1) * (activeTuplet ? activeTuplet.normal/activeTuplet.actual : 1);
        if (activeTuplet) activeTuplet.indices.push(events.length);
        events.push({ rest:item.tagName === 'Rest', code:durationCodes[type], dots, length, pitches, notes, stem:value(item,'StemDirection'), offset:voiceOffset });
        voiceOffset += length;
        }
        return events;
      });
      return { voices, events:voices[0] || [], time:[...time], key, tempo, clef, percussion, lines };
    });
  });
  return { title, staves, measures:Math.max(...staves.map(staff => staff.length)) };
}

function draw(data) {
  const host = $('score'); host.replaceChildren(); highlights = []; noteHits = []; measureBoxes = []; cueLine = null;
  const width = Math.max(240, host.clientWidth - 16);
  const perRow = Math.max(1, Math.min(6, Math.floor(width / 300)));
  const cellWidth = Math.floor((width - 20) / perRow);
  const rowHeight = 110 + data.staves.length * 100;
  const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
  renderer.resize(width, Math.ceil(data.measures/perRow)*rowHeight + 25);
  const context = renderer.getContext();
  let symbols = 0;
  for (let index = 0; index < data.measures; index++) {
    const row = Math.floor(index/perRow), col = index%perRow;
    const x = 10 + col*cellWidth, top = 35 + row*rowHeight;
    for (let staffIndex=0; staffIndex<data.staves.length; staffIndex++) {
      const measure = data.staves[staffIndex][index];
      if (!measure) continue;
      const y = top + staffIndex*100;
      const stave = new VF.Stave(x,y,cellWidth);
      if (measure.percussion) stave.setNumLines(measure.lines);
      if (col === 0) stave.addClef(measure.clef);
      if (index === 0 || measure.time.join('/') !== data.staves[staffIndex][index-1]?.time.join('/')) stave.addTimeSignature(measure.time.join('/'));
      if (col === 0 && measure.key !== 'C') stave.addKeySignature(measure.key);
      stave.setContext(context).draw();
      const voiceData = measure.voices.map((events, voiceIndex) => {
        const notes = events.map(event => {
          const keys = event.rest ? ['b/4'] : measure.percussion ? ['b/4'] : event.notes.map(writtenNote);
          if (!keys.length) return null;
          const note = new VF.StaveNote({clef:measure.clef,keys,duration:event.code+(event.rest?'r':'')+'d'.repeat(event.dots)});
          if (!event.rest && measure.voices.length > 1) note.setStemDirection(voiceIndex % 2 ? -1 : 1);
          else if (!event.rest && event.stem) note.setStemDirection(event.stem === 'down' ? -1 : 1);
          if (!event.rest && !measure.percussion) event.notes.forEach((source,i) => { if (source.accidental) note.addModifier(new VF.Accidental(source.accidental),i); });
          return note;
        }).filter(Boolean);
        if (!notes.length) return null;
        const voice = new VF.Voice({num_beats:measure.time[0],beat_value:measure.time[1]}).setStrict(false);
        voice.addTickables(notes);
        const tuplets = events.tuplets.map(group => {
          const members=group.indices.map(index=>notes[index]).filter(Boolean);
          return members.length > 1 ? new VF.Tuplet(members,{num_notes:group.actual,notes_occupied:group.normal}) : null;
        }).filter(Boolean);
        return {voice,notes,events,beams:VF.Beam.generateBeams(notes),tuplets};
      }).filter(Boolean);
      if (voiceData.length) {
        const voices = voiceData.map(item => item.voice);
        new VF.Formatter().joinVoices(voices).format(voices,cellWidth-(col===0?125:55));
        for (const item of voiceData) {
          item.voice.draw(context,stave);
          item.beams.forEach(beam => beam.setContext(context).draw());
          item.tuplets.forEach(tuplet => tuplet.setContext(context).draw());
          item.notes.forEach((note,noteIndex) => {
            const event=item.events[noteIndex];
            if (event?.pitches.length) noteHits.push({measure:index,offset:event.offset,x:note.getAbsoluteX(),y:y-20});
          });
          symbols += item.notes.length;
        }
      }
    }
    const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
    rect.setAttribute('x',x+2); rect.setAttribute('y',top-2);
    rect.setAttribute('width',cellWidth-4); rect.setAttribute('height',data.staves.length*100-12);
    rect.setAttribute('rx',5); rect.setAttribute('fill','transparent');
    const svg = host.querySelector('svg'); svg.insertBefore(rect,svg.firstChild);
    highlights.push(rect);
    measureBoxes.push({x:x+2,y:top-2,width:cellWidth-4,height:data.staves.length*100-12});
  }
  const svg=host.querySelector('svg');
  for (const [index,box] of measureBoxes.entries()) {
    const hit=document.createElementNS('http://www.w3.org/2000/svg','rect');
    Object.entries(box).forEach(([name,value])=>hit.setAttribute(name,value));
    hit.setAttribute('fill','transparent'); hit.setAttribute('class','measure-hit');
    hit.setAttribute('tabindex','0'); hit.setAttribute('role','button');
    hit.setAttribute('aria-label',`Começar no compasso ${index+1}`);
    hit.addEventListener('click',()=>selectCue(index,0));
    hit.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectCue(index,0);}});
    svg.append(hit);
  }
  for (const hitInfo of noteHits) {
    const hit=document.createElementNS('http://www.w3.org/2000/svg','rect');
    hit.setAttribute('x',hitInfo.x-14); hit.setAttribute('y',hitInfo.y);
    hit.setAttribute('width',28); hit.setAttribute('height',100);
    hit.setAttribute('fill','transparent'); hit.setAttribute('class','note-hit');
    hit.setAttribute('tabindex','0'); hit.setAttribute('role','button');
    hit.setAttribute('aria-label',`Começar na nota do compasso ${hitInfo.measure+1}`);
    hit.addEventListener('click',event=>{event.stopPropagation();selectCue(hitInfo.measure,hitInfo.offset,true);});
    hit.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectCue(hitInfo.measure,hitInfo.offset,true);}});
    svg.append(hit);
  }
  for (const [index,box] of measureBoxes.entries()) {
    const number=document.createElementNS('http://www.w3.org/2000/svg','text');
    number.setAttribute('x',box.x+5); number.setAttribute('y',box.y-8);
    number.setAttribute('class','measure-number'); number.textContent=index+1;
    svg.append(number);
  }
  cueLine=document.createElementNS('http://www.w3.org/2000/svg','line');
  cueLine.setAttribute('class','seek-line'); cueLine.setAttribute('visibility','hidden');
  svg.append(cueLine);
  return symbols;
}

function renderCue() {
  if (!parsed) return;
  highlights.forEach((rect,index)=>rect.setAttribute('fill',index===cue.measure?'#dbeafb':'transparent'));
  $('measure-select').value=cue.measure+1;
  $('resume-detail').textContent=`de ${parsed.measures}${cue.note?' · nota selecionada':''}`;
  const hit=cue.note?noteHits.find(item=>item.measure===cue.measure&&Math.abs(item.offset-cue.offset)<1e-6):null;
  if (cueLine) {
    cueLine.setAttribute('visibility',hit?'visible':'hidden');
    if (hit) {
      const box=measureBoxes[cue.measure];
      cueLine.setAttribute('x1',hit.x); cueLine.setAttribute('x2',hit.x);
      cueLine.setAttribute('y1',box.y); cueLine.setAttribute('y2',box.y+box.height);
    }
  }
}

function selectCue(measure,offset=0,note=false) {
  if (!parsed) return;
  const resume=playing;
  if (resume) stop();
  cue={measure:Math.min(parsed.measures-1,Math.max(0,measure)),offset:Math.max(0,offset),note};
  renderCue();
  if (resume) play();
}

function stop() {
  timers.forEach(clearTimeout); timers=[];
  oscillators.forEach(osc => { try { osc.stop(); } catch {} }); oscillators=[];
  playing=false; $('play').textContent='▶ Reproduzir'; $('time').textContent='0:00';
  renderCue();
}

function ensureAudio() {
  audioContext ||= new AudioContext();
  if (!musicBus) {
    musicBus=audioContext.createGain(); musicBus.connect(audioContext.destination);
    metronomeBus=audioContext.createGain(); metronomeBus.connect(audioContext.destination);
    const count=Math.ceil(audioContext.sampleRate*.14);
    snareBuffer=audioContext.createBuffer(1,count,audioContext.sampleRate);
    const samples=snareBuffer.getChannelData(0);
    for (let i=0;i<count;i++) samples[i]=Math.random()*2-1;
  }
  updateVolumes();
  audioContext.resume();
}

function updateVolumes() {
  $('music-value').textContent=`${$('music-volume').value}%`;
  $('metro-value').textContent=`${$('metro-volume').value}%`;
  if (!audioContext || !musicBus) return;
  musicBus.gain.setTargetAtTime(Number($('music-volume').value)/100,audioContext.currentTime,.01);
  metronomeBus.gain.setTargetAtTime($('metronome').checked?Number($('metro-volume').value)/100:0,audioContext.currentTime,.01);
}

function updateMetronome() {
  const active=$('metronome').checked;
  $('metro-label').textContent=active?'Ligado':'Desligado';
  $('metro-summary').textContent=active?'Ligado':'Desligado';
  updateVolumes();
}

function currentBpm() { return Math.min(240,Math.max(30,Number($('bpm').value)||originalBpm)); }
function changeBpm(value) {
  const wasPlaying=playing;
  if (wasPlaying) stop();
  $('bpm').value=Math.min(240,Math.max(30,Math.round(Number(value)||originalBpm)));
  $('tempo-summary').textContent=`${$('bpm').value} BPM`;
  if (wasPlaying) play();
}

function scheduleNote(pitch,at,duration,percussion,chordSize) {
  const gain=audioContext.createGain();
  if (percussion) {
    const durationSeconds=Math.max(.12,Number(duration)||0);
    const osc=audioContext.createOscillator();
    const filter=audioContext.createBiquadFilter();
    osc.type='triangle'; osc.frequency.value=220;
    filter.type='lowpass'; filter.frequency.value=1400; filter.Q.value=.4;
    const level=.08/Math.max(1,chordSize);
    const attack=Math.min(.035,Math.max(.01,durationSeconds*.1));
    const release=Math.min(.12,Math.max(.05,durationSeconds*.2));
    gain.gain.setValueAtTime(0,at);
    gain.gain.linearRampToValueAtTime(level,at+attack);
    gain.gain.setValueAtTime(level,at+Math.max(attack,durationSeconds-release));
    gain.gain.linearRampToValueAtTime(0,at+durationSeconds);
    osc.connect(filter).connect(gain).connect(musicBus);
    osc.start(at); osc.stop(at+durationSeconds+.04); oscillators.push(osc);
  } else {
    const durationSeconds=Math.max(.12,Number(duration)||0);
    const osc=audioContext.createOscillator();
    const harmony=audioContext.createOscillator();
    const type=timbre==='piano'?'triangle':timbre==='flute'?'sine':timbre==='violin'?'sawtooth':'triangle';
    osc.type=type; harmony.type=timbre==='piano'?'sine':timbre==='flute'?'sine':timbre==='violin'?'triangle':'square';
    const frequency=440*2**((pitch-69)/12);
    osc.frequency.value=frequency; harmony.frequency.value=frequency*2;
    const filter=audioContext.createBiquadFilter();
    filter.type='lowpass'; filter.frequency.value=timbre==='flute'?3600:timbre==='piano'?3200:timbre==='violin'?2200:1500; filter.Q.value=timbre==='voice'?1.1:.3;
    const sustain=.075/Math.max(1,chordSize);
    const attack=Math.min(.06,Math.max(.018,durationSeconds*.08));
    const release=Math.min(.18,Math.max(.08,durationSeconds*.16));
    const releaseStart=Math.max(attack,durationSeconds-release);
    gain.gain.setValueAtTime(0,at);
    gain.gain.linearRampToValueAtTime(sustain,at+attack);
    gain.gain.setValueAtTime(sustain,at+releaseStart);
    gain.gain.linearRampToValueAtTime(0,at+durationSeconds);
    const harmonyGain=audioContext.createGain(); harmonyGain.gain.value=timbre==='voice'?.08:timbre==='flute'?.04:timbre==='violin'?.12:.2;
    osc.connect(filter); harmony.connect(harmonyGain).connect(filter);
    filter.connect(gain).connect(musicBus);
    osc.start(at); harmony.start(at);
    osc.stop(at+durationSeconds+.05); harmony.stop(at+durationSeconds+.05);
    oscillators.push(osc,harmony);
  }
}

function scheduleClick(at,accent) {
  const osc=audioContext.createOscillator(),gain=audioContext.createGain();
  osc.type='sine'; osc.frequency.value=accent?1320:880;
  gain.gain.setValueAtTime(accent?.14:.085,at);
  gain.gain.exponentialRampToValueAtTime(.001,at+.055);
  osc.connect(gain).connect(metronomeBus); osc.start(at); osc.stop(at+.06);
  oscillators.push(osc);
}

function play() {
  if (playing) { stop(); return; }
  if (!parsed) return;
  ensureAudio();
  const tempoRatio=currentBpm()/originalBpm;
  const leadTime=.35;
  const baseTime=audioContext.currentTime+leadTime;
  let seconds=0;
  playing=true; $('play').textContent='■ Interromper';
  for (let index=cue.measure;index<parsed.measures;index++) {
    const first=parsed.staves[0][index]; if (!first) continue;
    const start=seconds, quarterSeconds=60/(first.tempo*tempoRatio);
    const beatLength=4/first.time[1];
    const voiceLengths=parsed.staves.flatMap(staff=>(staff[index]?.voices||[]).map(events=>events.reduce((sum,event)=>sum+event.length,0)));
    const measureLength=(voiceLengths.length?Math.max(...voiceLengths):0) || first.time[0]*beatLength;
    const startOffset=index===cue.measure?Math.min(cue.offset,measureLength):0;
    const tickCount=Math.ceil(measureLength/beatLength-1e-6);
    for (let beat=0;beat<tickCount;beat++) {
      const beatOffset=beat*beatLength;
      if (beatOffset+1e-6>=startOffset) scheduleClick(baseTime+start+(beatOffset-startOffset)*quarterSeconds,beat===0);
    }
    timers.push(setTimeout(() => {
      highlights.forEach(rect => rect.setAttribute('fill','transparent'));
      highlights[index]?.setAttribute('fill','#f7d5d5');
      highlights[index]?.scrollIntoView({block:'nearest',behavior:'smooth'});
      $('time').textContent=`${Math.floor(start/60)}:${String(Math.floor(start%60)).padStart(2,'0')}`;
    },(start+leadTime)*1000));
    for (const staff of parsed.staves) {
      const measure=staff[index]; if (!measure) continue;
      for (const events of measure.voices) {
        let cursor=0;
        for (const event of events) {
          const eventEnd=cursor+event.length;
          if (eventEnd>startOffset+1e-6) {
            const audibleStart=Math.max(cursor,startOffset);
            const duration=(eventEnd-audibleStart)*quarterSeconds;
            const at=baseTime+start+(audibleStart-startOffset)*quarterSeconds;
            const pitches=event.pitches.length?event.pitches:(!event.rest&&measure.percussion?[60]:[]);
            for (const pitch of pitches) scheduleNote(pitch,at,duration,measure.percussion,pitches.length);
          }
          cursor=eventEnd;
        }
      }
    }
    seconds+=(measureLength-startOffset)*quarterSeconds;
  }
  timers.push(setTimeout(stop,(seconds+leadTime+.1)*1000));
}

function renderList() {
  const term=$('search').value.trim().toLocaleLowerCase('pt-BR');
  visible=lessons.filter(item => (!phase || item.phase===phase) && (!term || `${item.title} ${item.phase}`.toLocaleLowerCase('pt-BR').includes(term)));
  $('lessons').replaceChildren();
  for (const item of visible) {
    const button=document.createElement('button'); button.type='button'; button.textContent=item.title;
    button.classList.toggle('active',item===selected);
    button.addEventListener('click',()=>selectLesson(item)); $('lessons').append(button);
  }
  $('count').textContent=lessons.length;
}

function renderPhases() {
  const phases=[0,...new Set(lessons.map(item=>item.phase).filter(Boolean))].sort((a,b)=>a-b);
  $('phases').replaceChildren();
  for (const number of phases) {
    const button=document.createElement('button'); button.textContent=number?`Fase ${number}`:'Todas';
    button.classList.toggle('active',phase===number);
    button.addEventListener('click',()=>{phase=number;renderPhases();renderList();});
    $('phases').append(button);
  }
}

async function selectLesson(item) {
  stop(); parsed=null; selected=item; renderList();
  $('breadcrumb').textContent=item.phase?`Fase ${item.phase}`:'Partitura avulsa';
  $('phase-summary').textContent=item.phase?`Fase ${item.phase}`:'Avulsa';
  $('title').textContent=item.title;
  $('download').hidden=!item.path;
  if (item.path) $('download').href=fileUrl(item.path);
  $('play').disabled=$('stop').disabled=true;
  $('status').textContent='Lendo o arquivo MSCZ…';
  try {
    const bytes=item.file ? await item.file.arrayBuffer() : await (async()=>{
      const response=await fetch(fileUrl(item.path));
      if (!response.ok) throw new Error(`Arquivo não encontrado (${response.status}).`);
      return response.arrayBuffer();
    })();
    const data=readScore(bytes); const symbols=draw(data); parsed=data;
    cue={measure:0,offset:0,note:false};
    $('measure-select').max=data.measures;
    $('measure-select').disabled=false;
    renderCue();
    originalBpm=data.staves[0]?.[0]?.tempo || 90;
    $('original-tempo').textContent=`Original: ${originalBpm} BPM`;
    changeBpm(originalBpm);
    $('status').textContent=`${data.measures} compassos · ${data.staves.length} pauta(s) · ${symbols} símbolos. Áudio sintetizado no navegador.`;
    $('play').disabled=$('stop').disabled=false;
  } catch(error) {
    $('measure-select').disabled=true;
    $('score').replaceChildren(); $('status').textContent=`Não foi possível abrir esta partitura: ${error.message}`;
  }
}

async function init() {
  const response=await fetch('catalog.json');
  if (!response.ok) throw new Error('Catálogo não encontrado. Abra este site pelo Live Server.');
  lessons=await response.json();
  renderPhases(); renderList();
  $('search').addEventListener('input',renderList);
  $('play').addEventListener('click',play); $('stop').addEventListener('click',stop);
  const chooseTypedMeasure=()=>{
    if (!$('measure-select').value) return;
    const index=Math.min(parsed?.measures||1,Math.max(1,Math.round(Number($('measure-select').value)||1)))-1;
    selectCue(index);
    highlights[index]?.scrollIntoView({block:'nearest',behavior:'smooth'});
  };
  $('measure-select').addEventListener('input',chooseTypedMeasure);
  $('measure-select').addEventListener('change',chooseTypedMeasure);
  $('bpm').addEventListener('change',()=>changeBpm($('bpm').value));
  $('bpm-down').addEventListener('click',()=>changeBpm(currentBpm()-5));
  $('bpm-up').addEventListener('click',()=>changeBpm(currentBpm()+5));
  $('metronome').addEventListener('change',updateMetronome);
  $('music-volume').addEventListener('input',updateVolumes);
  $('metro-volume').addEventListener('input',updateVolumes);
  $('timbre').addEventListener('change',()=>{
    const wasPlaying=playing;
    if (wasPlaying) stop();
    timbre=$('timbre').value;
    if (wasPlaying) play();
  });
  updateMetronome();
  $('previous').addEventListener('click',()=>{const i=visible.indexOf(selected);if(i>0)selectLesson(visible[i-1]);});
  $('next').addEventListener('click',()=>{const i=visible.indexOf(selected);if(i<visible.length-1)selectLesson(visible[i+1]);});
  $('local-file').addEventListener('change',event=>{
    for (const file of event.target.files) lessons.push({title:file.name.replace(/\.mscz$/i,''),phase:0,file});
    renderPhases(); renderList(); selectLesson(lessons.at(-1));
  });
  $('fullscreen').addEventListener('click',async()=>{
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  });
  $('toggle-settings').addEventListener('click',()=>{
    const collapsed=$('viewer').classList.toggle('settings-collapsed');
    $('toggle-settings').setAttribute('aria-expanded',String(!collapsed));
    $('toggle-settings').textContent=collapsed?'⚙ Mostrar configurações':'⚙ Configurações';
    $('toggle-settings').title=collapsed?'Expandir configurações':'Recolher configurações';
  });
  document.addEventListener('fullscreenchange',()=>document.body.classList.toggle('projecting',!!document.fullscreenElement));
  document.addEventListener('fullscreenchange',()=>{
    if (document.fullscreenElement) {
      $('viewer')?.scrollTo({top:0,left:0});
      $('score')?.scrollTo({top:0,left:0});
    }
  });
  let resizeTimer;
  window.addEventListener('resize',()=>{
    if (!parsed) return;
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{draw(parsed);renderCue();},120);
  });
  if (lessons.length) await selectLesson(lessons[0]);
}
init().catch(error=>$('status').textContent=error.message);

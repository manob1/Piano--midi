(() => {
'use strict';

/* ============================== CONSTANTS ============================== */
const NOTE_MIN = 21;   // A0
const NOTE_MAX = 108;  // C8
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FALL_TIME = 2.4; // seconds a falling note takes to travel from top to keybed
const SCHEDULE_LOOKAHEAD = 0.35; // seconds - how far ahead we create Web Audio nodes
const SCHEDULER_INTERVAL = 25; // ms

const OCT_COLORS = ['#eaa63f', '#8a6bff', '#ff6f91', '#4fd1c5'];

function isBlackNote(n){ return NOTE_NAMES[n % 12].includes('#'); }
function noteName(n){ return NOTE_NAMES[n % 12] + (Math.floor(n/12) - 1); }
function midiToFreq(n){ return 440 * Math.pow(2, (n - 69) / 12); }
function colorForNote(n){ return OCT_COLORS[Math.floor(n/12) % OCT_COLORS.length]; }
function fmtTime(s){
  if(!isFinite(s) || s<0) s=0;
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return m + ':' + String(sec).padStart(2,'0');
}

/* ============================== DOM REFS ============================== */
const $ = sel => document.querySelector(sel);
const whitekeysEl = $('#whitekeys');
const blackkeysEl = $('#blackkeys');
const keybedEl = $('#keybed');
const canvas = $('#fallcanvas');
const ctx2d = canvas.getContext('2d');
const stagewrap = $('#stagewrap');
const stageinner = $('#stageinner');

/* ============================== KEY LAYOUT ============================== */
let WHITE_W = 40, BLACK_W = 24, TOTAL_WIDTH = 0;
const keyMeta = new Map(); // note -> {x, width, isWhite, el}

function readCssPx(varName){
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return parseFloat(raw) || 0;
}

function buildKeyboard(){
  whitekeysEl.innerHTML = '';
  blackkeysEl.innerHTML = '';
  keyMeta.clear();
  WHITE_W = readCssPx('--white-w');
  BLACK_W = readCssPx('--black-w');
  let whiteIndex = 0;
  const showLabels = $('#labelsToggle').checked;

  for(let n = NOTE_MIN; n <= NOTE_MAX; n++){
    const black = isBlackNote(n);
    let x, width;
    if(!black){
      x = whiteIndex * WHITE_W;
      width = WHITE_W;
    } else {
      x = whiteIndex * WHITE_W - BLACK_W/2;
      width = BLACK_W;
    }
    const el = document.createElement('div');
    el.className = 'key ' + (black ? 'black' : 'white');
    el.style.left = x + 'px';
    el.style.width = width + 'px';
    el.dataset.note = n;
    if(showLabels){
      const isC = (n % 12 === 0);
      const lbl = document.createElement('span');
      lbl.className = 'label';
      lbl.textContent = (!black && isC) ? noteName(n) : (black ? '' : '');
      el.appendChild(lbl);
    }
    (black ? blackkeysEl : whitekeysEl).appendChild(el);
    keyMeta.set(n, {x, width, isWhite: !black, el});
    if(!black) whiteIndex++;
  }
  TOTAL_WIDTH = whiteIndex * WHITE_W;
  keybedEl.style.width = TOTAL_WIDTH + 'px';
  whitekeysEl.style.width = TOTAL_WIDTH + 'px';
  blackkeysEl.style.width = TOTAL_WIDTH + 'px';
  stageinner.style.width = TOTAL_WIDTH + 'px';
  canvas.width = TOTAL_WIDTH;
  canvas.style.width = TOTAL_WIDTH + 'px';
}

/* ============================== AUDIO ENGINE ============================== */
let audioCtx = null;
let dryGain, reverbSend, convolver, compressor, masterOut;

function ensureAudio(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterOut = audioCtx.createGain();
  masterOut.gain.value = 0.75;

  compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 22;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  dryGain = audioCtx.createGain();
  dryGain.gain.value = 1;
  reverbSend = audioCtx.createGain();
  reverbSend.gain.value = 0.16;

  convolver = audioCtx.createConvolver();
  convolver.buffer = makeImpulse(2.1, 2.6);

  dryGain.connect(compressor);
  reverbSend.connect(convolver);
  convolver.connect(compressor);
  compressor.connect(masterOut);
  masterOut.connect(audioCtx.destination);
}

function makeImpulse(duration, decay){
  const rate = audioCtx.sampleRate;
  const len = Math.floor(rate * duration);
  const buf = audioCtx.createBuffer(2, len, rate);
  for(let ch=0; ch<2; ch++){
    const data = buf.getChannelData(ch);
    for(let i=0;i<len;i++){
      data[i] = (Math.random()*2-1) * Math.pow(1 - i/len, decay);
    }
  }
  return buf;
}

let hammerBuffer = null;
function makeHammerBuffer(){
  const rate = audioCtx.sampleRate;
  const len = Math.floor(rate * 0.06);
  const buf = audioCtx.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  for(let i=0;i<len;i++){
    data[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 2.2);
  }
  return buf;
}

function playVoice(note, velocity, startTime, stopTime){
  ensureAudio();
  if(!hammerBuffer) hammerBuffer = makeHammerBuffer();
  const freq = midiToFreq(note);
  const t0 = startTime;
  const vel = Math.max(0.05, Math.min(1, velocity));

  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  const baseCut = Math.min(9200, 900 + freq*3.1);
  filter.frequency.setValueAtTime(baseCut * 1.5, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(500, baseCut*0.45), t0 + 1.3);
  filter.Q.value = 0.6;

  const osc1 = audioCtx.createOscillator(); osc1.type = 'triangle'; osc1.frequency.value = freq;
  const osc2 = audioCtx.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = freq*2.003;
  const osc3 = audioCtx.createOscillator(); osc3.type = 'sine'; osc3.frequency.value = freq*4.0;

  const g1 = audioCtx.createGain(); g1.gain.value = 0.60;
  const g2 = audioCtx.createGain(); g2.gain.value = 0.20;
  const g3 = audioCtx.createGain(); g3.gain.value = 0.03 + vel*0.06;

  osc1.connect(g1); osc2.connect(g2); osc3.connect(g3);
  const vGain = audioCtx.createGain();
  g1.connect(filter); g2.connect(filter); g3.connect(filter);
  filter.connect(vGain);
  vGain.connect(dryGain);
  vGain.connect(reverbSend);

  const peak = Math.min(1, 0.16 + vel*0.95);
  const sustainLevel = peak * 0.34;
  vGain.gain.setValueAtTime(0.0001, t0);
  vGain.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
  vGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainLevel), t0 + 0.35);

  osc1.start(t0); osc2.start(t0); osc3.start(t0);

  const noiseSrc = audioCtx.createBufferSource();
  noiseSrc.buffer = hammerBuffer;
  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'highpass'; noiseFilter.frequency.value = 1400;
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(vel*0.16, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
  noiseSrc.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(dryGain);
  noiseSrc.start(t0);

  let stopped = false;
  function stop(atTime, release){
    if(stopped) return;
    stopped = true;
    const rel = release || 0.3;
    const g = vGain.gain;
    const at = Math.max(atTime, t0 + 0.001);
    g.cancelScheduledValues(at);
    g.setValueAtTime(Math.min(sustainLevel, peak), at);
    g.exponentialRampToValueAtTime(0.0001, at + rel);
    const stopAt = at + rel + 0.05;
    try{ osc1.stop(stopAt); osc2.stop(stopAt); osc3.stop(stopAt); }catch(e){}
  }

  if(stopTime){ stop(stopTime, 0.22); }

  return { stop, note };
}

/* ============================== LIVE PLAY STATE ============================== */
const activeLiveVoices = new Map();   // note -> voice
const sustainedVoices = new Map();    // note -> voice (ringing past key release)
let spaceHeld = false;

function isSustainActive(){ return $('#sustainToggle').checked || spaceHeld; }

function noteOnLive(note, velocity=0.85, source='live'){
  ensureAudio();
  if(audioCtx.state === 'suspended') audioCtx.resume();
  if(activeLiveVoices.has(note)) return;
  if(sustainedVoices.has(note)){
    sustainedVoices.get(note).stop(audioCtx.currentTime, 0.05);
    sustainedVoices.delete(note);
  }
  const voice = playVoice(note, velocity, audioCtx.currentTime, null);
  activeLiveVoices.set(note, voice);
  pressKeyVisual(note, velocity);
  bumpStats(note);
}

function noteOffLive(note){
  const voice = activeLiveVoices.get(note);
  releaseKeyVisual(note);
  if(!voice) return;
  activeLiveVoices.delete(note);
  if(isSustainActive()){
    sustainedVoices.set(note, voice);
  } else {
    voice.stop(audioCtx.currentTime, 0.35);
  }
}

function flushSustain(){
  sustainedVoices.forEach(v => v.stop(audioCtx.currentTime, 0.5));
  sustainedVoices.clear();
}

/* ============================== VISUAL EFFECTS ============================== */
function pressKeyVisual(note, velocity=0.8){
  const meta = keyMeta.get(note);
  if(!meta) return;
  meta.el.classList.add('active');
  spawnEffects(meta, note, velocity);
}
function releaseKeyVisual(note){
  const meta = keyMeta.get(note);
  if(!meta) return;
  meta.el.classList.remove('active');
}

function spawnEffects(meta, note, velocity){
  const color = colorForNote(note);
  const cx = meta.x + meta.width/2;

  const pool = document.createElement('div');
  pool.className = 'glowpool';
  pool.style.left = cx + 'px';
  pool.style.setProperty('--pool-color', hexToRgba(color, 0.5));
  keybedEl.appendChild(pool);
  pool.addEventListener('animationend', () => pool.remove());

  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  ripple.style.left = cx + 'px';
  ripple.style.setProperty('--r-color', hexToRgba(color, 0.8));
  keybedEl.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());

  if($('#labelsToggle').checked){
    const tag = document.createElement('div');
    tag.className = 'notefloat';
    tag.textContent = noteName(note);
    tag.style.left = cx + 'px';
    tag.style.color = color;
    keybedEl.appendChild(tag);
    tag.addEventListener('animationend', () => tag.remove());
  }

  const n = 5 + Math.round(velocity*4);
  for(let i=0;i<n;i++){
    const p = document.createElement('div');
    p.className = 'particle';
    const angle = (Math.random()*Math.PI) + Math.PI; // upward spread
    const dist = 26 + Math.random()*40;
    p.style.left = cx + 'px';
    p.style.setProperty('--tx', (Math.cos(angle)*dist).toFixed(1)+'px');
    p.style.setProperty('--ty', (Math.sin(angle)*dist).toFixed(1)+'px');
    p.style.setProperty('--p-color', color);
    keybedEl.appendChild(p);
    p.addEventListener('animationend', () => p.remove());
  }
}

function hexToRgba(hex, a){
  const v = hex.replace('#','');
  const r = parseInt(v.substring(0,2),16), g = parseInt(v.substring(2,4),16), b = parseInt(v.substring(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ============================== POINTER (MOUSE + TOUCH) INPUT ============================== */
const activePointers = new Map(); // pointerId -> note

function attachPointerHandlers(){
  const bed = keybedEl;
  bed.addEventListener('pointerdown', e => {
    const note = noteFromEvent(e);
    if(note==null) return;
    e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, note);
    const vel = 0.6 + Math.random()*0.3;
    noteOnLive(note, vel);
  });
  bed.addEventListener('pointermove', e => {
    if(!activePointers.has(e.pointerId)) return;
    const note = noteFromEvent(e);
    const prev = activePointers.get(e.pointerId);
    if(note!=null && note!==prev){
      noteOffLive(prev);
      activePointers.set(e.pointerId, note);
      noteOnLive(note, 0.7);
    }
  });
  function release(e){
    const note = activePointers.get(e.pointerId);
    if(note!=null) noteOffLive(note);
    activePointers.delete(e.pointerId);
  }
  bed.addEventListener('pointerup', release);
  bed.addEventListener('pointercancel', release);
  bed.addEventListener('pointerleave', e => { if(e.pointerType==='mouse') release(e); });
  bed.addEventListener('contextmenu', e => e.preventDefault());
}

function noteFromEvent(e){
  const target = e.target.closest('.key');
  if(target && target.dataset.note != null) return parseInt(target.dataset.note, 10);
  return null;
}

/* ============================== COMPUTER KEYBOARD INPUT ============================== */
const KEY_OFFSETS = { A:0, W:1, S:2, E:3, D:4, F:5, T:6, G:7, Y:8, H:9, U:10, J:11, K:12, O:13, L:14 };
let octaveBase = 60; // C4
const heldChars = new Set();

function updateOctaveLabel(){
  $('#octLabel').textContent = 'Octave ' + (Math.floor(octaveBase/12) - 1);
}

function attachKeyboardHandlers(){
  window.addEventListener('keydown', e => {
    if(e.target.tagName==='INPUT' || e.target.tagName==='SELECT') return;
    if(e.code === 'Space'){
      e.preventDefault();
      if(!spaceHeld){ spaceHeld = true; }
      return;
    }
    if(e.key === 'ArrowLeft'){ shiftOctave(-1); return; }
    if(e.key === 'ArrowRight'){ shiftOctave(1); return; }
    const ch = e.key.toUpperCase();
    if(KEY_OFFSETS.hasOwnProperty(ch) && !heldChars.has(ch)){
      heldChars.add(ch);
      const note = octaveBase + KEY_OFFSETS[ch];
      if(note>=NOTE_MIN && note<=NOTE_MAX) noteOnLive(note, 0.9);
    }
  });
  window.addEventListener('keyup', e => {
    if(e.code === 'Space'){
      spaceHeld = false;
      if(!$('#sustainToggle').checked) flushSustain();
      return;
    }
    const ch = e.key.toUpperCase();
    if(KEY_OFFSETS.hasOwnProperty(ch)){
      heldChars.delete(ch);
      const note = octaveBase + KEY_OFFSETS[ch];
      noteOffLive(note);
    }
  });
}

function shiftOctave(dir){
  const next = octaveBase + dir*12;
  if(next < 24 || next > 84) return;
  octaveBase = next;
  updateOctaveLabel();
}

$('#octDown').addEventListener('click', () => shiftOctave(-1));
$('#octUp').addEventListener('click', () => shiftOctave(1));
$('#sustainToggle').addEventListener('change', () => { if(!isSustainActive()) flushSustain(); });

/* ============================== MIDI PARSER ============================== */
function parseMidi(arrayBuffer){
  const view = new DataView(arrayBuffer);
  let pos = 0;
  const readU32 = () => { const v = view.getUint32(pos); pos+=4; return v; };
  const readU16 = () => { const v = view.getUint16(pos); pos+=2; return v; };
  const readU8  = () => { const v = view.getUint8(pos); pos+=1; return v; };
  const readStr = len => { let s=''; for(let i=0;i<len;i++) s += String.fromCharCode(readU8()); return s; };
  const readVLQ = () => {
    let value=0, b;
    do{ b = readU8(); value = (value<<7) | (b & 0x7f); } while(b & 0x80);
    return value;
  };

  if(readStr(4) !== 'MThd') throw new Error('Not a valid MIDI file');
  readU32();
  const format = readU16();
  const numTracks = readU16();
  const division = readU16();
  let ticksPerBeat = (division & 0x8000) ? 480 : division;

  const rawOnOff = [];
  const tempoEvents = [];

  for(let t=0; t<numTracks; t++){
    const id = readStr(4);
    const len = readU32();
    const trackEnd = pos + len;
    if(id !== 'MTrk'){ pos = trackEnd; continue; }
    let tick = 0;
    let running = null;
    while(pos < trackEnd){
      const delta = readVLQ();
      tick += delta;
      let status = view.getUint8(pos);
      if(status & 0x80){ pos++; running = status; } else { status = running; }
      const type = status & 0xf0;

      if(status === 0xff){
        const metaType = readU8();
        const mlen = readVLQ();
        if(metaType === 0x51 && mlen === 3){
          const usPerBeat = (readU8()<<16) | (readU8()<<8) | readU8();
          tempoEvents.push({tick, usPerBeat});
        } else {
          pos += mlen;
        }
      } else if(status === 0xf0 || status === 0xf7){
        const slen = readVLQ();
        pos += slen;
      } else if(type === 0x90){
        const note = readU8(), vel = readU8();
        if(vel === 0) rawOnOff.push({tick, kind:'off', note});
        else rawOnOff.push({tick, kind:'on', note, velocity: vel/127});
      } else if(type === 0x80){
        const noteOff = readU8(); readU8();
        rawOnOff.push({tick, kind:'off', note: noteOff});
      } else if(type===0xa0 || type===0xb0 || type===0xe0){
        pos += 2;
      } else if(type===0xc0 || type===0xd0){
        pos += 1;
      } else {
        pos = trackEnd; // unknown/corrupt - bail this track
      }
    }
    pos = trackEnd;
  }

  tempoEvents.sort((a,b)=>a.tick-b.tick);
  if(tempoEvents.length===0 || tempoEvents[0].tick>0) tempoEvents.unshift({tick:0, usPerBeat:500000});

  const segs = [];
  let cumSec = 0;
  for(let i=0;i<tempoEvents.length;i++){
    segs.push({tick: tempoEvents[i].tick, sec: cumSec, usPerBeat: tempoEvents[i].usPerBeat});
    const next = tempoEvents[i+1];
    if(next) cumSec += (next.tick - tempoEvents[i].tick) * tempoEvents[i].usPerBeat / 1e6 / ticksPerBeat;
  }
  function tickToSeconds(tick){
    let seg = segs[0];
    for(let i=0;i<segs.length;i++){ if(segs[i].tick<=tick) seg = segs[i]; else break; }
    return seg.sec + (tick - seg.tick) * seg.usPerBeat / 1e6 / ticksPerBeat;
  }

  const openStacks = new Map(); // note -> array of {tick, velocity}
  const notes = [];
  rawOnOff.sort((a,b)=>a.tick-b.tick);
  for(const ev of rawOnOff){
    if(ev.kind==='on'){
      if(!openStacks.has(ev.note)) openStacks.set(ev.note, []);
      openStacks.get(ev.note).push({tick: ev.tick, velocity: ev.velocity});
    } else {
      const stack = openStacks.get(ev.note);
      if(stack && stack.length){
        const start = stack.shift();
        if(ev.tick > start.tick){
          notes.push({ note: ev.note, start: tickToSeconds(start.tick), duration: tickToSeconds(ev.tick)-tickToSeconds(start.tick), velocity: start.velocity });
        }
      }
    }
  }
  notes.sort((a,b)=>a.start-b.start);
  const duration = notes.reduce((m,n)=>Math.max(m, n.start+n.duration), 0);
  return { notes, duration, trackCount: numTracks };
}

/* ============================== DEMO SONGS (public-domain melodies) ============================== */
function buildDemo(seq, q){
  let t = 0;
  const notes = [];
  for(const [note, beats] of seq){
    const dur = beats * q;
    if(note != null) notes.push({ note, start: t, duration: dur*0.92, velocity: 0.75 });
    t += dur;
  }
  return { notes, duration: t };
}
const DEMOS = [
  {
    title: 'Twinkle, Twinkle, Little Star',
    subtitle: 'Traditional · C major',
    build: () => buildDemo([
      [60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],
      [65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2]
    ], 0.45)
  },
  {
    title: 'Ode to Joy (opening)',
    subtitle: 'Beethoven · public domain · C major',
    build: () => buildDemo([
      [64,1],[64,1],[65,1],[67,1],
      [67,1],[65,1],[64,1],[62,1],
      [60,1],[60,1],[62,1],[64,1],
      [64,1.5],[62,0.5],[62,2]
    ], 0.45)
  },
  {
    title: 'C Major Scale',
    subtitle: 'Warm-up · up and down',
    build: () => buildDemo([
      [60,1],[62,1],[64,1],[65,1],[67,1],[69,1],[71,1],[72,1],
      [71,1],[69,1],[67,1],[65,1],[64,1],[62,1],[60,2]
    ], 0.32)
  }
];

/* ============================== PLAYBACK STATE ============================== */
let currentSong = null;
let currentSongLabel = '';
let playing = false;
let anchorSongTime = 0;
let anchorCtxTime = 0;
let tempoScale = 1.0;
let nextNoteIndex = 0;
let scheduledVoices = [];
let pendingVisualTimers = [];
let schedulerHandle = null;
let rafHandle = null;
const ghostActiveNotes = new Set();

function ctxTimeForSongTime(songTime){
  return anchorCtxTime + (songTime - anchorSongTime) / tempoScale;
}
function currentSongTime(){
  if(!audioCtx) return anchorSongTime;
  return anchorSongTime + (audioCtx.currentTime - anchorCtxTime) * tempoScale;
}

function loadSong(song, label){
  stopPlayback();
  currentSong = song;
  currentSongLabel = label;
  $('#songName').textContent = label;
  const mins = fmtTime(song.duration);
  $('#songMeta').textContent = song.notes.length + ' notes · ' + mins + ' total';
  $('#seek').max = Math.max(1, song.duration);
  $('#seek').value = 0;
  $('#timeTotal').textContent = fmtTime(song.duration);
  $('#timeCur').textContent = '0:00';
  bumpSongStat();
  switchView('play');
}

function startPlayback(){
  if(!currentSong || !currentSong.notes.length) return;
  ensureAudio();
  if(audioCtx.state === 'suspended') audioCtx.resume();
  playing = true;
  anchorCtxTime = audioCtx.currentTime + 0.05;
  anchorSongTime = parseFloat($('#seek').value) || 0;
  nextNoteIndex = firstIndexAtOrAfter(currentSong.notes, anchorSongTime);
  setPlayIcon(true);
  if(schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(schedulerTick, SCHEDULER_INTERVAL);
  if(!rafHandle) rafHandle = requestAnimationFrame(renderLoop);
}

function pausePlayback(){
  playing = false;
  setPlayIcon(false);
  if(schedulerHandle){ clearInterval(schedulerHandle); schedulerHandle = null; }
  clearScheduledAudio();
}

function stopPlayback(){
  pausePlayback();
  anchorSongTime = 0;
  if($('#seek')) $('#seek').value = 0;
  if($('#timeCur')) $('#timeCur').textContent = '0:00';
  ghostActiveNotes.forEach(n => releaseKeyVisual(n));
  ghostActiveNotes.clear();
}

function restartPlayback(){
  const wasPlaying = playing;
  stopPlayback();
  if(wasPlaying || currentSong) startPlayback();
}

function clearScheduledAudio(){
  scheduledVoices.forEach(v => { try{ v.stop(audioCtx.currentTime, 0.04); }catch(e){} });
  scheduledVoices = [];
  pendingVisualTimers.forEach(id => clearTimeout(id));
  pendingVisualTimers = [];
}

function firstIndexAtOrAfter(notes, t){
  let lo=0, hi=notes.length;
  while(lo<hi){ const mid=(lo+hi)>>1; if(notes[mid].start < t) lo=mid+1; else hi=mid; }
  return lo;
}

function schedulerTick(){
  if(!playing || !currentSong) return;
  const now = audioCtx.currentTime;
  const notes = currentSong.notes;
  while(nextNoteIndex < notes.length){
    const note = notes[nextNoteIndex];
    const ctxStart = ctxTimeForSongTime(note.start);
    if(ctxStart > now + SCHEDULE_LOOKAHEAD) break;
    const ctxEnd = ctxTimeForSongTime(note.start + note.duration);
    const voice = playVoice(note.note, note.velocity || 0.75, Math.max(ctxStart, now), Math.max(ctxEnd, ctxStart+0.05));
    scheduledVoices.push(voice);
    scheduleVisual(note.note, ctxStart, ctxEnd, now);
    bumpStats(note.note);
    nextNoteIndex++;
  }
  if(nextNoteIndex >= notes.length){
    const last = notes[notes.length-1];
    const lastEnd = last ? ctxTimeForSongTime(last.start+last.duration) : now;
    if(now > lastEnd + 0.4){ pausePlayback(); }
  }
}

function scheduleVisual(note, ctxStart, ctxEnd, now){
  const delayOn = Math.max(0, (ctxStart-now)*1000);
  const delayOff = Math.max(30, (ctxEnd-now)*1000);
  const idOn = setTimeout(() => { pressKeyVisual(note, 0.8); ghostActiveNotes.add(note); }, delayOn);
  const idOff = setTimeout(() => { releaseKeyVisual(note); ghostActiveNotes.delete(note); }, delayOff);
  pendingVisualTimers.push(idOn, idOff);
}

function setPlayIcon(isPlaying){
  const svg = $('#playIcon');
  svg.innerHTML = isPlaying
    ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

/* ============================== FALLING NOTES RENDER LOOP ============================== */
function renderLoop(){
  rafHandle = requestAnimationFrame(renderLoop);
  const h = canvas.height;
  ctx2d.clearRect(0,0,canvas.width,h);
  if(!playing || !currentSong){ return; }
  const now = audioCtx.currentTime;
  const pxPerSec = h / FALL_TIME;

  // update seek / time labels
  const t = currentSongTime();
  $('#timeCur').textContent = fmtTime(Math.max(0,t));
  const seekEl = $('#seek');
  if(document.activeElement !== seekEl){
    seekEl.value = Math.min(parseFloat(seekEl.max||0), Math.max(0,t));
    const pct = (seekEl.value/(seekEl.max||1))*100;
    seekEl.style.setProperty('--val', pct+'%');
  }

  const notes = currentSong.notes;
  // draw a reasonable window around now
  for(let i=0;i<notes.length;i++){
    const nd = notes[i];
    const ctxStart = ctxTimeForSongTime(nd.start);
    const ctxEnd = ctxTimeForSongTime(nd.start+nd.duration);
    if(ctxEnd < now - 0.05) continue;
    if(ctxStart > now + FALL_TIME + 0.1) break;
    const meta = keyMeta.get(nd.note);
    if(!meta) continue;
    const yBottom = h - (ctxStart-now)*pxPerSec;
    const yTop = h - (ctxEnd-now)*pxPerSec;
    const top = Math.max(-20, yTop);
    const bottom = Math.min(h+20, yBottom);
    if(bottom < top) continue;
    const color = colorForNote(nd.note);
    const cx = meta.x + meta.width/2;
    const w = Math.max(6, meta.width*0.62);
    const grad = ctx2d.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, hexToRgba(color, 0.15));
    grad.addColorStop(1, hexToRgba(color, 0.85));
    ctx2d.fillStyle = grad;
    roundRect(ctx2d, cx-w/2, top, w, Math.max(4,bottom-top), 5);
    ctx2d.fill();
    ctx2d.shadowColor = color;
    ctx2d.shadowBlur = 10;
    ctx2d.fillRect(cx-w/2, Math.max(top,bottom-3), w, 3);
    ctx2d.shadowBlur = 0;
  }
}
function roundRect(c, x, y, w, h, r){
  c.beginPath();
  c.moveTo(x+r, y);
  c.arcTo(x+w, y, x+w, y+h, r);
  c.arcTo(x+w, y+h, x, y+h, r);
  c.arcTo(x, y+h, x, y, r);
  c.arcTo(x, y, x+w, y, r);
  c.closePath();
}

/* ============================== STATS ============================== */
let statNotes=0; const statKeys = new Set(); let statSongs=0; let sessionStart=null;
function bumpStats(note){
  statNotes++; statKeys.add(note);
  if(!sessionStart) sessionStart = Date.now();
  $('#statNotes').textContent = statNotes;
  $('#statKeysUsed').textContent = statKeys.size;
}
function bumpSongStat(){ statSongs++; $('#statSongs').textContent = statSongs; }
setInterval(() => {
  if(sessionStart) $('#statTime').textContent = fmtTime((Date.now()-sessionStart)/1000);
}, 1000);

/* ============================== UI WIRING ============================== */
function switchView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view===name));
  $('#view-'+name).classList.add('active');
}
$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if(btn) switchView(btn.dataset.view);
});

$('#btnPlay').addEventListener('click', () => {
  if(!currentSong){ return; }
  if(playing) pausePlayback(); else startPlayback();
});
$('#btnRestart').addEventListener('click', restartPlayback);

$('#seek').addEventListener('input', () => {
  const t = parseFloat($('#seek').value);
  $('#timeCur').textContent = fmtTime(t);
  const pct = (t/(parseFloat($('#seek').max)||1))*100;
  $('#seek').style.setProperty('--val', pct+'%');
});
$('#seek').addEventListener('change', () => {
  const wasPlaying = playing;
  const t = parseFloat($('#seek').value);
  pausePlayback();
  ghostActiveNotes.forEach(n => releaseKeyVisual(n));
  ghostActiveNotes.clear();
  anchorSongTime = t;
  if(wasPlaying) startPlayback();
});

$('#tempo').addEventListener('input', () => {
  const val = parseInt($('#tempo').value,10);
  $('#tempoVal').textContent = val+'%';
  $('#tempo').style.setProperty('--val', ((val-50)/150*100)+'%');
  if(playing){
    anchorSongTime = currentSongTime();
    anchorCtxTime = audioCtx.currentTime;
  }
  tempoScale = val/100;
});

$('#volume').addEventListener('input', () => {
  const val = parseInt($('#volume').value,10);
  $('#volume').style.setProperty('--val', val+'%');
  ensureAudio();
  masterOut.gain.value = val/100;
});

$('#labelsToggle').addEventListener('change', buildKeyboard);

/* ---- upload ---- */
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
dropzone.addEventListener('click', () => fileInput.click());
['dragover','dragenter'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if(f) handleMidiFile(f);
});
fileInput.addEventListener('change', () => {
  if(fileInput.files[0]) handleMidiFile(fileInput.files[0]);
});

function handleMidiFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const song = parseMidi(reader.result);
      if(!song.notes.length) throw new Error('No playable notes found in this file.');
      loadSong(song, file.name.replace(/\.(mid|midi)$/i,''));
      autoFitOctaveView(song);
    } catch(err){
      $('#songName').textContent = 'Could not read that file';
      $('#songMeta').textContent = String(err.message || err);
    }
  };
  reader.onerror = () => {
    $('#songName').textContent = 'Could not read that file';
    $('#songMeta').textContent = 'The file could not be loaded.';
  };
  reader.readAsArrayBuffer(file);
}

function autoFitOctaveView(song){
  if(!song.notes.length) return;
  let sum=0;
  song.notes.forEach(n => sum += n.note);
  const avg = sum / song.notes.length;
  const targetOct = Math.round(avg/12)*12;
  if(targetOct>=24 && targetOct<=84) { octaveBase = targetOct; updateOctaveLabel(); }
  requestAnimationFrame(() => {
    const meta = keyMeta.get(Math.round(avg));
    if(meta) stagewrap.scrollLeft = Math.max(0, meta.x - stagewrap.clientWidth/2);
  });
}

/* ---- demos ---- */
const demolist = $('#demolist');
DEMOS.forEach(d => {
  const el = document.createElement('div');
  el.className = 'demoitem';
  el.innerHTML = `<div><div class="t">${d.title}</div><div class="s">${d.subtitle}</div></div><div class="badge">Play</div>`;
  el.addEventListener('click', () => {
    const song = d.build();
    loadSong(song, d.title);
    autoFitOctaveView(song);
  });
  demolist.appendChild(el);
});

/* ============================== INIT ============================== */
function init(){
  buildKeyboard();
  attachPointerHandlers();
  attachKeyboardHandlers();
  updateOctaveLabel();
  $('#volume').style.setProperty('--val','75%');
  $('#tempo').style.setProperty('--val','33.3%');
  window.addEventListener('resize', debounce(buildKeyboard, 200));
  // unlock audio context on first user gesture (mobile requirement)
  const unlock = () => { ensureAudio(); if(audioCtx.state==='suspended') audioCtx.resume(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock, {once:true});
}
function debounce(fn, ms){ let h; return (...a)=>{ clearTimeout(h); h=setTimeout(()=>fn(...a), ms); }; }

init();
})();

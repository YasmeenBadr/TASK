import {TimeViewer, drawSpectrum, drawSpectrogram} from './viewers.js';
import {EQScheme} from './eq.js';

const fileInput=document.getElementById('fileInput');
const btnGenerate=document.getElementById('btnGenerate');
const modeSelect=document.getElementById('modeSelect');
const scaleSelect=document.getElementById('scaleSelect');
const magSelect=document.getElementById('magSelect');
const btnLoadPreset=document.getElementById('btnLoadPreset');
const btnSavePreset=document.getElementById('btnSavePreset');
const toggleSpec=document.getElementById('toggleSpec');
const toggleSpecGlobal=document.getElementById('toggleSpecGlobal');
const addBand=document.getElementById('addBand');
const applyEqBtn=document.getElementById('applyEq');
const bandsDiv=document.getElementById('bands');

const inputWave=new TimeViewer(document.getElementById('inputWave'));
const outputWave=new TimeViewer(document.getElementById('outputWave'));

const freqInCanvas=document.getElementById('freqIn');
const freqOutCanvas=document.getElementById('freqOut');
const inputSpec=document.getElementById('inputSpec');
const outputSpec=document.getElementById('outputSpec');

let audioCtx=null; let inputSignal=null; let sampleRate=44100; let outputSignal=null;
let applying=false;
let scheme=new EQScheme(sampleRate);
let presetGroups=null; // when non-null, array of {label, windows:[{startHz,widthHz}], gain}
let applyTimer=null;

function syncViews(start, end){ inputWave.setView(start,end); outputWave.setView(start,end); }

// Manual apply mode: we no longer auto-apply during input changes to avoid overlapping requests

async function updateFreqView(signal, which){
  if(!signal) return; const blob = encodeWavPCM16Mono(signal, sampleRate);
  const form=new FormData(); form.append('audio', blob, 'sig.wav');
  const resp=await fetch('/api/spectrum',{method:'POST', body:form}); if(!resp.ok) return;
  const data=await resp.json(); const mags = new Float32Array(data.magnitudes);
  const target = which==='in' ? freqInCanvas : freqOutCanvas;
  if(target) drawSpectrum(target, mags, data.sampleRate, scaleSelect.value, magSelect.value);
}

async function updateSpecs(){ if(!(toggleSpecGlobal?.checked)&&toggleSpecGlobal!==null){ const ctx1=inputSpec.getContext('2d'); const ctx2=outputSpec.getContext('2d'); ctx1.clearRect(0,0,inputSpec.width,inputSpec.height); ctx2.clearRect(0,0,outputSpec.width,outputSpec.height); return; } if(toggleSpec && !toggleSpec.checked){ const ctx1=inputSpec.getContext('2d'); const ctx2=outputSpec.getContext('2d'); ctx1.clearRect(0,0,inputSpec.width,inputSpec.height); ctx2.clearRect(0,0,outputSpec.width,outputSpec.height); return; }
  if(inputSignal){ const mags = await fetchSpectrogram(inputSignal, sampleRate); if(mags) drawSpectrogram(inputSpec, mags, sampleRate); }
  if(outputSignal){ const mags = await fetchSpectrogram(outputSignal, sampleRate); if(mags) drawSpectrogram(outputSpec, mags, sampleRate); }
}

async function updateOutputSpecOnly(){
  if(!(toggleSpecGlobal?.checked)&&toggleSpecGlobal!==null) return;
  if(toggleSpec && !toggleSpec.checked) return;
  if(outputSignal){ const mags = await fetchSpectrogram(outputSignal, sampleRate); if(mags) drawSpectrogram(outputSpec, mags, sampleRate); }
}

async function fetchSpectrogram(signal, sr){
  const blob=encodeWavPCM16Mono(signal, sr);
  // Choose a window that fits the signal: largest power-of-two <= length, capped at 1024
  const maxWin = Math.min(1024, signal.length);
  const pow = Math.floor(Math.log2(Math.max(2, maxWin)));
  const win = 1 << pow;
  const hop = Math.max(1, Math.floor(win/4));
  const form=new FormData();
  form.append('audio', blob, 'sig.wav');
  form.append('win', String(win));
  form.append('hop', String(hop));
  const resp=await fetch('/api/spectrogram',{method:'POST', body:form});
  if(!resp.ok) return null;
  const data=await resp.json();
  return data.magnitudes.map(row=>Float32Array.from(row));
}

function currentBandsFromState(){
  // If we have grouped presets loaded (e.g., Musical Instruments), expand them to bands
  if(presetGroups && presetGroups.length){
    const bands=[];
    for(const g of presetGroups){
      const gain = (typeof g.gain === 'number') ? g.gain : 1;
      for(const w of (g.windows||[])){
        bands.push({startHz:w.startHz, widthHz:w.widthHz, gain});
      }
    }
    return bands;
  }
  // Fallback: generic mode uses manual scheme bands
  return scheme.bands.map(b=>({startHz:b.startHz, widthHz:b.widthHz, gain:b.gain}));
}

async function applyEQ(){ if(!inputSignal) return; 
  if(applying) { console.warn('Apply EQ ignored: already running'); return; }
  const bands = currentBandsFromState();
  const blob = encodeWavPCM16Mono(inputSignal, sampleRate);
  const form = new FormData(); form.append('audio', blob, 'input.wav'); form.append('scheme', JSON.stringify({sampleRate, bands}));
  try{
    applying = true; if(applyEqBtn) applyEqBtn.disabled = true; console.log('Apply EQ: start', {bands});
    const resp = await fetch('/api/process',{method:'POST', body:form});
    if(!resp.ok){ const text = await resp.text().catch(()=>'<no body>'); console.error('Apply EQ failed', resp.status, text); return; }
    const arr = await resp.arrayBuffer();
    await ensureAudioCtx();
    const audioBuf = await audioCtx.decodeAudioData(arr);
    outputSignal = audioBuf.getChannelData(0).slice();
    outputWave.setSignal(outputSignal, sampleRate);
    // Keep the same time window shown as the input, so the change is visible immediately
    syncViews(inputWave.viewStart, inputWave.viewEnd);
    await updateFreqView(outputSignal, 'out');
    // Defer spectrogram drawing so Apply EQ returns faster; only recompute output spectrogram
    setTimeout(()=>{ updateOutputSpecOnly(); }, 0);
    console.log('Apply EQ: done');
  }catch(err){
    console.error('Apply EQ error', err);
  }finally{
    applying = false; if(applyEqBtn) applyEqBtn.disabled = false;
  }
}

// Debounced auto-apply to keep UI responsive while editing sliders
function scheduleApply(){
  if(applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(()=>{ applyEQ(); }, 250);
}

function renderBands(){ bandsDiv.innerHTML='';
 if(presetGroups && presetGroups.length){
   presetGroups.forEach((g,idx)=>{ const div=document.createElement('div'); div.className='band';
     div.innerHTML=`<strong style="grid-column: span 1; color:#e5e7eb">${g.label||('Group '+(idx+1))}</strong>
     <label style="grid-column: span 5;">Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${g.gain??1}"></label>
     <span class="gainVal">${(g.gain??1).toFixed(2)}x</span>`;
     const gainR = div.querySelector('input'); const span=div.querySelector('.gainVal');
     gainR.addEventListener('input',()=>{g.gain=+gainR.value; span.textContent=`${g.gain.toFixed(2)}x`; scheduleApply();});
     bandsDiv.appendChild(div);
   });
   return;
 }
 scheme.bands.forEach((b,idx)=>{ const div=document.createElement('div'); div.className='band';
  div.innerHTML=`<label>Start Hz<input type="number" step="1" value="${b.startHz}"></label>
  <label>Width Hz<input type="number" step="1" value="${b.widthHz}"></label>
  <label>Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${b.gain}"></label>
  <span class="gainVal">${b.gain.toFixed(2)}x</span>
  <button class="remove">Remove</button>`;
  const [startL,widthL,gainR,span,btn] = div.querySelectorAll('input,span,button');
  startL.addEventListener('input',()=>{b.startHz=+startL.value; scheduleApply();});
  widthL.addEventListener('input',()=>{b.widthHz=+widthL.value; scheduleApply();});
  gainR.addEventListener('input',()=>{b.gain=+gainR.value; span.textContent=`${b.gain.toFixed(2)}x`; scheduleApply();});
  btn.addEventListener('click',()=>{scheme.removeBand(idx); renderBands(); scheduleApply();});
  bandsDiv.appendChild(div);
 }); }

function updateModeUI(){
  if(addBand){
    if(modeSelect.value==='generic'){
      addBand.style.display='inline-flex';
      addBand.disabled=false;
    }else{
      addBand.style.display='none';
      addBand.disabled=true;
    }
  }
}

addBand.addEventListener('click',()=>{scheme.addBand(500,500,1); renderBands(); /* manual apply */});

applyEqBtn.addEventListener('click', ()=>{ applyEQ(); });

btnSavePreset.addEventListener('click',()=>{ let dataObj=null; if(modeSelect.value==='generic'){ dataObj=scheme.toJSON(); } else { dataObj={ sliders:(presetGroups||[]).map(g=>({label:g.label, windows:g.windows, gain:g.gain})) }; } const data=JSON.stringify(dataObj, null, 2); const blob=new Blob([data],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`preset_${modeSelect.value}.json`; a.click(); URL.revokeObjectURL(a.href); });

btnLoadPreset.addEventListener('click',()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='application/json'; inp.onchange=async ()=>{ const file=inp.files[0]; if(!file) return; const text=await file.text(); const obj=JSON.parse(text); if(modeSelect.value==='generic'){ scheme=EQScheme.fromJSON(obj); } else { const s=(obj&&obj.sliders)||[]; presetGroups=s.map(x=>({label:x.label, windows:x.windows||[], gain:typeof x.gain==='number'?x.gain:1})); } renderBands(); }; inp.click(); });

scaleSelect.addEventListener('change',()=>{ if(inputSignal) updateFreqView(inputSignal, 'in'); if(outputSignal) updateFreqView(outputSignal, 'out'); });
magSelect.addEventListener('change',()=>{ if(inputSignal) updateFreqView(inputSignal, 'in'); if(outputSignal) updateFreqView(outputSignal, 'out'); });

if(toggleSpec){ toggleSpec.addEventListener('change',()=>updateSpecs()); }
if(toggleSpecGlobal){
  toggleSpecGlobal.addEventListener('change', ()=>{
    if(!toggleSpecGlobal.checked){
      const ctx1=inputSpec.getContext('2d'); const ctx2=outputSpec.getContext('2d');
      ctx1.clearRect(0,0,inputSpec.width,inputSpec.height);
      ctx2.clearRect(0,0,outputSpec.width,outputSpec.height);
    }else{
      // Refresh specs on re-enable
      updateSpecs();
    }
  });
}

modeSelect.addEventListener('change', async ()=>{
  if(modeSelect.value==='generic'){ presetGroups=null; renderBands(); updateModeUI(); if(inputSignal) scheduleApply(); return; }
  try{
    const resp = await fetch('./presets.json');
    const data = await resp.json();
    const p = data[modeSelect.value];
    presetGroups = (p?.sliders||[]).map(s=>({label:s.label, windows:s.windows||[], gain:1}));
  }catch(e){ console.error(e); presetGroups=null; }
  renderBands(); updateModeUI(); if(inputSignal) scheduleApply();
});

fileInput.addEventListener('change', async ()=>{
  const file=fileInput.files[0]; if(!file) return; await ensureAudioCtx(); const arrBuf=await file.arrayBuffer(); const audioBuf=await audioCtx.decodeAudioData(arrBuf); sampleRate=audioBuf.sampleRate; inputSignal=audioBuf.getChannelData(0).slice(); inputWave.setSignal(inputSignal, sampleRate); outputSignal=inputSignal.slice(); outputWave.setSignal(outputSignal, sampleRate); syncViews(0, Math.min(2, inputSignal.length/sampleRate)); await updateFreqView(inputSignal, 'in'); await updateFreqView(outputSignal, 'out'); await updateSpecs(); await applyEQ(); });

btnGenerate.addEventListener('click',async ()=>{
  const dur=5; sampleRate=44100; const N=dur*sampleRate; inputSignal=new Float32Array(N);
  if(modeSelect.value!=='generic' && presetGroups && presetGroups.length){
    const parts=[]; presetGroups.forEach((g)=>{ (g.windows||[]).forEach((w)=>{ const center=Math.max(20, w.startHz + Math.max(0.0,w.widthHz)*0.5); parts.push(center); }); });
    const amp=0.9/Math.max(1, parts.length);
    for(const f of parts){ for(let n=0;n<N;n++){ inputSignal[n]+=amp*Math.sin(2*Math.PI*f*n/sampleRate); } }
  } else {
    const tones=[120,440,880,1500,3000,6000,10000]; const amp=1/tones.length; for(const f of tones){ for(let n=0;n<N;n++){ inputSignal[n]+=amp*Math.sin(2*Math.PI*f*n/sampleRate); } }
  }
  let max=0; for(let n=0;n<N;n++){ const a=Math.abs(inputSignal[n]); if(a>max) max=a; }
  if(max>1e-6){ for(let n=0;n<N;n++) inputSignal[n]/=max; }
  inputWave.setSignal(inputSignal, sampleRate); outputSignal=inputSignal.slice(); outputWave.setSignal(outputSignal, sampleRate); syncViews(0,2); await updateFreqView(inputSignal, 'in'); await updateFreqView(outputSignal, 'out'); await updateSpecs(); await applyEQ(); });

// Playback controls (simple): create BufferSource per play
let inSource=null, outSource=null;
async function ensureAudioCtx(){
  if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') await audioCtx.resume();
}

function playBuffer(signal, rate, which){
  const ctx=audioCtx; const buf=ctx.createBuffer(1, signal.length, sampleRate);
  buf.copyToChannel(signal,0,0);
  const src=ctx.createBufferSource();
  src.buffer=buf; src.playbackRate.value=rate; src.connect(ctx.destination); src.start();
  src.onended = ()=>{ if(which==='in'){ inSource=null; } else { outSource=null; } };
  return src;
}

document.getElementById('inPlay').addEventListener('click', async ()=>{ await ensureAudioCtx(); if(inSource){ try{inSource.stop()}catch(_){} } inSource=playBuffer(inputSignal||new Float32Array([0]), +document.getElementById('inSpeed').value, 'in'); });
document.getElementById('outPlay').addEventListener('click', async ()=>{ await ensureAudioCtx(); if(outSource){ try{outSource.stop()}catch(_){} } outSource=playBuffer(outputSignal||new Float32Array([0]), +document.getElementById('outSpeed').value, 'out'); });

document.getElementById('inPause').addEventListener('click', ()=>{ if(audioCtx) audioCtx.suspend(); });
document.getElementById('outPause').addEventListener('click', ()=>{ if(audioCtx) audioCtx.suspend(); });
document.getElementById('inStop').addEventListener('click', ()=>{ if(inSource){ try{inSource.stop()}catch{} inSource=null; }});
document.getElementById('outStop').addEventListener('click', ()=>{ if(outSource){ try{outSource.stop()}catch{} outSource=null; }});

// Link viewers basic: dragging to zoom/pan
[inputWave.canvas, outputWave.canvas].forEach((cv)=>{
  let dragging=false; let startX=0; cv.addEventListener('mousedown',(e)=>{dragging=true; startX=e.offsetX});
  window.addEventListener('mouseup',()=>dragging=false);
  cv.addEventListener('mousemove',(e)=>{ if(!dragging) return; const c=cv; const frac0=startX/c.width; const frac1=e.offsetX/c.width; const t0=inputWave.viewStart + frac0*(inputWave.viewEnd-inputWave.viewStart); const t1=inputWave.viewStart + frac1*(inputWave.viewEnd-inputWave.viewStart); const ns=Math.min(t0,t1), ne=Math.max(t0,t1); syncViews(ns, ne); });
  cv.addEventListener('wheel',(e)=>{ e.preventDefault(); const center=inputWave.viewStart + (e.offsetX/cv.width)*(inputWave.viewEnd-inputWave.viewStart); const scale=Math.exp(-e.deltaY*0.001); const half=(inputWave.viewEnd-inputWave.viewStart)*0.5/scale; syncViews(Math.max(0, center-half), center+half); }, {passive:false});
});

// Initial state
renderBands(); updateModeUI();

// Helpers: WAV encoder PCM16 mono
function encodeWavPCM16Mono(samples, sr){
  const numChannels=1; const bytesPerSample=2; const blockAlign=numChannels*bytesPerSample; const byteRate=sr*blockAlign; const dataLen=samples.length*bytesPerSample; const buf=new ArrayBuffer(44+dataLen); const view=new DataView(buf);
  function writeStr(off, s){ for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); }
  let off=0; writeStr(off,'RIFF'); off+=4; view.setUint32(off, 36+dataLen, true); off+=4; writeStr(off,'WAVE'); off+=4; writeStr(off,'fmt '); off+=4; view.setUint32(off,16,true); off+=4; view.setUint16(off,1,true); off+=2; view.setUint16(off,numChannels,true); off+=2; view.setUint32(off,sr,true); off+=4; view.setUint32(off,byteRate,true); off+=4; view.setUint16(off,blockAlign,true); off+=2; view.setUint16(off,16,true); off+=2; writeStr(off,'data'); off+=4; view.setUint32(off,dataLen,true); off+=4;
  let idx=off; for(let i=0;i<samples.length;i++){ let s=Math.max(-1, Math.min(1, samples[i])); view.setInt16(idx, s<0? s*0x8000 : s*0x7FFF, true); idx+=2; }
  return new Blob([buf], {type:'audio/wav'});
}


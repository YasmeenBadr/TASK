import {TimeViewer, drawSpectrum, drawSpectrogram} from './viewers.js';
import {encodeWavPCM16Mono, fetchSpectrogram, playBuffer} from './helpers.js';
import {generateSignal} from './signals.js';
import {EQScheme, renderBands} from './eq.js';

// --- UI Element Declarations ---
const fileInput=document.getElementById('fileInput');
const btnGenerate=document.getElementById('btnGenerate');
const modeSelect=document.getElementById('modeSelect');
const scaleSelect=document.getElementById('scaleSelect');
const magSelect=document.getElementById('magSelect');
const btnLoadPreset=document.getElementById('btnLoadPreset');
const btnSavePreset=document.getElementById('btnSavePreset');
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

// --- Global State Variables ---
let audioCtx=null;
let inputSignal=null;
let sampleRate=44100;
let outputSignal=null;
let applying=false;
let scheme=new EQScheme(sampleRate);
let presetGroups=null;
let applyTimer=null;

// NEW: AbortControllers for fetch operations
let specAbortController=null;  // For spectrogram fetches
let freqAbortController=null;  // For spectrum fetches

// --- Utility Functions ---

function syncViews(start, end){ 
    inputWave.setView(start,end); 
    outputWave.setView(start,end); 
}

async function updateFreqView(signal, which){
    if(!signal) return;
    
    // Abort any previous spectrum fetch
    if(freqAbortController){
        freqAbortController.abort();
    }
    
    // Create new abort controller for this fetch and capture locally to avoid races
    const localFreqCtrl = new AbortController();
    freqAbortController = localFreqCtrl;
    
    const blob = encodeWavPCM16Mono(signal, sampleRate);
    const form=new FormData(); 
    form.append('audio', blob, 'sig.wav');
    
    try{
        const resp=await fetch('/api/spectrum',{
            method:'POST', 
            body:form,
            signal: localFreqCtrl.signal
        }); 
        
        if(!resp.ok) return;
        const data=await resp.json(); 
        const mags = new Float32Array(data.magnitudes);
        const target = which==='in' ? freqInCanvas : freqOutCanvas;
        // Only draw if this response matches the latest controller
        if(localFreqCtrl === freqAbortController && target){
            drawSpectrum(target, mags, data.sampleRate, scaleSelect.value, magSelect.value);
        }
    }catch(err){
        if(err.name === 'AbortError'){
            console.log('Spectrum fetch aborted');
            return;
        }
        console.error('Spectrum fetch error:', err);
    }
}

async function updateSpecs(){ 
    if(!(toggleSpecGlobal?.checked)&&toggleSpecGlobal!==null){ 
        // Abort any ongoing spectrogram fetches
        if(specAbortController){
            specAbortController.abort();
            specAbortController = null;
        }
        
        const ctx1=inputSpec.getContext('2d'); 
        const ctx2=outputSpec.getContext('2d'); 
        ctx1.clearRect(0,0,inputSpec.width,inputSpec.height); 
        ctx2.clearRect(0,0,outputSpec.width,outputSpec.height); 
        return; 
    }
    
    // Abort any previous spectrogram fetch before starting new one
    if(specAbortController){
        specAbortController.abort();
    }
    
    // Create new abort controller for these fetches and capture locally to avoid races
    const localSpecCtrl = new AbortController();
    specAbortController = localSpecCtrl;
    
    if(inputSignal){ 
        try{
            const mags = await fetchSpectrogram(inputSignal, sampleRate, localSpecCtrl.signal); 
            if(localSpecCtrl === specAbortController && mags && toggleSpecGlobal && toggleSpecGlobal.checked){
                drawSpectrogram(inputSpec, mags, sampleRate); 
            }
        }catch(err){
            if(err.name === 'AbortError'){
                console.log('Spectrogram fetch (input) aborted');
            }else{
                console.error('Spectrogram fetch (input) error:', err);
            }
        }
    }
    if(outputSignal){ 
        try{
            const mags = await fetchSpectrogram(outputSignal, sampleRate, localSpecCtrl.signal); 
            if(localSpecCtrl === specAbortController && mags && toggleSpecGlobal && toggleSpecGlobal.checked){
                drawSpectrogram(outputSpec, mags, sampleRate); 
            }
        }catch(err){
            if(err.name === 'AbortError'){
                console.log('Spectrogram fetch (output) aborted');
            }else{
                console.error('Spectrogram fetch (output) error:', err);
            }
        }
    }
}

// fetchSpectrogram is imported from helpers.js

function currentBandsFromState(){
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
    return scheme.bands.map(b=>({startHz:b.startHz, widthHz:b.widthHz, gain:b.gain}));
}

async function applyEQ(){ 
    if(!inputSignal) return; 
    if(applying) { console.warn('Apply EQ ignored: already running'); return; }
    const bands = currentBandsFromState();
    const blob = encodeWavPCM16Mono(inputSignal, sampleRate);
    const form = new FormData(); 
    form.append('audio', blob, 'input.wav'); 
    form.append('scheme', JSON.stringify({sampleRate, bands}));
    try{
      applying = true; 
      if(applyEqBtn) applyEqBtn.disabled = true; 
      console.log('Apply EQ: start', {bands});
      const resp = await fetch('/api/process',{method:'POST', body:form});
      if(!resp.ok){ 
          const text = await resp.text().catch(()=>'<no body>'); 
          console.error('Apply EQ failed', resp.status, text); 
          return; 
      }
      const arr = await resp.arrayBuffer();
      await ensureAudioCtx();
      const audioBuf = await audioCtx.decodeAudioData(arr);
      outputSignal = audioBuf.getChannelData(0).slice();
      outputWave.setSignal(outputSignal, sampleRate);
      syncViews(inputWave.viewStart, inputWave.viewEnd);
      await updateFreqView(outputSignal, 'out');
       
      if(toggleSpecGlobal && toggleSpecGlobal.checked){
          await updateSpecs();
      }
       
      console.log('Apply EQ: done');
    }catch(err){
      console.error('Apply EQ error', err);
    }finally{
      applying = false; 
      if(applyEqBtn) applyEqBtn.disabled = false;
    }
}



// renderBands is imported from eq.js and used with (bandsDiv, scheme, presetGroups)

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

// --- Event Listeners for UI Controls ---

addBand.addEventListener('click',()=>{scheme.addBand(500,500,1); renderBands(bandsDiv, scheme, presetGroups);});

applyEqBtn.addEventListener('click', ()=>{ applyEQ(); });

btnSavePreset.addEventListener('click',()=>{ 
    let dataObj=null; 
    if(modeSelect.value==='generic'){ 
        dataObj=scheme.toJSON(); 
    } else { 
        dataObj={ sliders:(presetGroups||[]).map(g=>({label:g.label, windows:g.windows, gain:g.gain})) }; 
    } 
    const data=JSON.stringify(dataObj, null, 2); 
    const blob=new Blob([data],{type:'application/json'}); 
    const a=document.createElement('a'); 
    a.href=URL.createObjectURL(blob); 
    a.download=`preset_${modeSelect.value}.json`; 
    a.click(); 
    URL.revokeObjectURL(a.href); 
});

btnLoadPreset.addEventListener('click',()=>{ 
    const inp=document.createElement('input'); 
    inp.type='file'; 
    inp.accept='application/json'; 
    inp.onchange=async ()=>{ 
        const file=inp.files[0]; 
        if(!file) return; 
        const text=await file.text(); 
        const obj=JSON.parse(text); 
        if(modeSelect.value==='generic'){ 
            scheme=EQScheme.fromJSON(obj); 
        } else { 
            const s=(obj&&obj.sliders)||[]; 
            presetGroups=s.map(x=>({label:x.label, windows:x.windows||[], gain:typeof x.gain==='number'?x.gain:1})); 
        } 
        renderBands(bandsDiv, scheme, presetGroups); 
    }; 
    inp.click(); 
});

scaleSelect.addEventListener('change',()=>{ 
    if(inputSignal) updateFreqView(inputSignal, 'in'); 
    if(outputSignal) updateFreqView(outputSignal, 'out'); 
});

magSelect.addEventListener('change',()=>{ 
    if(inputSignal) updateFreqView(inputSignal, 'in'); 
    if(outputSignal) updateFreqView(outputSignal, 'out'); 
});

if(toggleSpecGlobal){
    toggleSpecGlobal.addEventListener('change', ()=>{
      if(!toggleSpecGlobal.checked){
        // Abort any ongoing spectrogram fetches
        if(specAbortController){
            specAbortController.abort();
            specAbortController = null;
        }
        
        const ctx1=inputSpec.getContext('2d'); 
        const ctx2=outputSpec.getContext('2d');
        ctx1.clearRect(0,0,inputSpec.width,inputSpec.height);
        ctx2.clearRect(0,0,outputSpec.width,outputSpec.height);
      }else{
        updateSpecs();
      }
    });
}

modeSelect.addEventListener('change', async ()=>{
    if(modeSelect.value==='generic'){ 
        presetGroups=null; 
        renderBands(bandsDiv, scheme, presetGroups); 
        updateModeUI(); 
        return; 
    }
    try{
      const resp = await fetch('./presets.json');
      const data = await resp.json();
      const p = data[modeSelect.value];
      presetGroups = (p?.sliders||[]).map(s=>({label:s.label, windows:s.windows||[], gain:1}));
    }catch(e){ 
        console.error(e); 
        presetGroups=null; 
    }
    renderBands(bandsDiv, scheme, presetGroups); 
    updateModeUI(); 
});

fileInput.addEventListener('change', async ()=>{
    const file=fileInput.files[0]; 
    if(!file) return; 
    await ensureAudioCtx(); 
    const arrBuf=await file.arrayBuffer(); 
    const audioBuf=await audioCtx.decodeAudioData(arrBuf); 
    sampleRate=audioBuf.sampleRate; 
    inputSignal=audioBuf.getChannelData(0).slice(); 
    inputWave.setSignal(inputSignal, sampleRate); 
    outputSignal=inputSignal.slice(); 
    outputWave.setSignal(outputSignal, sampleRate); 
    syncViews(0, Math.min(2, inputSignal.length/sampleRate)); 
    await updateFreqView(inputSignal, 'in'); 
    await updateFreqView(outputSignal, 'out'); 
    
    if(toggleSpecGlobal && toggleSpecGlobal.checked) { 
        await updateSpecs(); 
    }
});

btnGenerate.addEventListener('click',async ()=>{
    const dur=5; 
    sampleRate=44100; 
    inputSignal = generateSignal(sampleRate, modeSelect.value, presetGroups, dur);
    inputWave.setSignal(inputSignal, sampleRate); 
    outputSignal=inputSignal.slice(); 
    outputWave.setSignal(outputSignal, sampleRate); 
    syncViews(0,2); 
    await updateFreqView(inputSignal, 'in'); 
    await updateFreqView(outputSignal, 'out'); 
    
    if(toggleSpecGlobal && toggleSpecGlobal.checked) { 
        await updateSpecs(); 
    }
});

// --- Playback Controls ---

let inSource=null, outSource=null;
async function ensureAudioCtx(){
    if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') await audioCtx.resume();
}

// playBuffer is imported from helpers.js

document.getElementById('inPlay').addEventListener('click', async ()=>{ 
    await ensureAudioCtx(); 
    if(inSource){ try{inSource.stop()}catch(_){} } 
    inSource=playBuffer(inputSignal||new Float32Array([0]), +document.getElementById('inSpeed').value, audioCtx, sampleRate); 
    inSource.onended = ()=>{ inSource = null; };
});
document.getElementById('outPlay').addEventListener('click', async ()=>{ 
    await ensureAudioCtx(); 
    if(outSource){ try{outSource.stop()}catch(_){} } 
    outSource=playBuffer(outputSignal||new Float32Array([0]), +document.getElementById('outSpeed').value, audioCtx, sampleRate); 
    outSource.onended = ()=>{ outSource = null; };
});

document.getElementById('inPause').addEventListener('click', ()=>{ if(audioCtx) audioCtx.suspend(); });
document.getElementById('outPause').addEventListener('click', ()=>{ if(audioCtx) audioCtx.suspend(); });

document.getElementById('inStop').addEventListener('click', ()=>{ if(inSource){ try{inSource.stop()}catch{} inSource=null; }});
document.getElementById('outStop').addEventListener('click', ()=>{ if(outSource){ try{outSource.stop()}catch{} outSource=null; }});

// --- Viewer Interaction (Zoom/Pan) ---
[inputWave.canvas, outputWave.canvas].forEach((cv)=>{
    let dragging=false; 
    let startX=0; 
    cv.addEventListener('mousedown',(e)=>{dragging=true; startX=e.offsetX});
    window.addEventListener('mouseup',()=>dragging=false);
    cv.addEventListener('mousemove',(e)=>{ 
        if(!dragging) return; 
        const c=cv; 
        const frac0=startX/c.width; 
        const frac1=e.offsetX/c.width; 
        const t0=inputWave.viewStart + frac0*(inputWave.viewEnd-inputWave.viewStart); 
        const t1=inputWave.viewStart + frac1*(inputWave.viewEnd-inputWave.viewStart); 
        const ns=Math.min(t0,t1), ne=Math.max(t0,t1); 
        syncViews(ns, ne); 
    });
    cv.addEventListener('wheel',(e)=>{ 
        e.preventDefault(); 
        const center=inputWave.viewStart + (e.offsetX/cv.width)*(inputWave.viewEnd-inputWave.viewStart); 
        const scale=Math.exp(-e.deltaY*0.001); 
        const half=(inputWave.viewEnd-inputWave.viewStart)*0.5/scale; 
        syncViews(Math.max(0, center-half), center+half); 
    }, {passive:false});
});

// Initial state
renderBands(bandsDiv, scheme, presetGroups); 
updateModeUI();


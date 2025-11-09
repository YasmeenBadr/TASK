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
let demucsMode = false;
let demucsSeparatedStems = null;

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
function updateMusicModeUI() {
    const mode = modeSelect.value;
    
    // Remove any existing Demucs controls
    const existingToggle = document.querySelector('.demucs-mode-toggle');
    if (existingToggle) existingToggle.remove();
    
    const existingPanel = document.getElementById('demucsControlPanel');
    if (existingPanel) existingPanel.remove();
    
    if (mode !== 'music') return;
    
    // Add Demucs toggle at the top of bands container
    const demucsHTML = `
        <div class="demucs-mode-toggle" style="
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(99, 102, 241, 0.1) 100%);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: all 0.3s ease;
        ">
            <div style="display: flex; align-items: center; gap: 16px;">
                <div style="
                    width: 48px;
                    height: 48px;
                    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">
                    <i class="fas fa-brain" style="color: white; font-size: 1.5rem;"></i>
                </div>
                <div>
                    <h3 style="margin: 0; color: #e5e7eb; font-size: 1.125rem; font-weight: 600;">AI-Powered Separation</h3>
                    <p style="margin: 4px 0 0 0; color: #9ca3af; font-size: 0.875rem;">
                        Use Demucs AI to separate drums, bass, vocals, and other instruments
                    </p>
                </div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" id="demucsModeToggle" />
                <span class="slider"></span>
            </label>
        </div>
        
        <div id="demucsControlPanel" style="display: none; margin-bottom: 20px;">
            <div style="
                text-align: center;
                padding: 32px;
                background: rgba(30, 41, 59, 0.6);
                border-radius: 12px;
                border: 1px solid rgba(148, 163, 184, 0.2);
            ">
                <button id="btnSeparateStems" class="btn-primary" style="
                    padding: 14px 40px;
                    font-size: 1rem;
                    box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.3);
                ">
                    <i class="fas fa-magic"></i>
                    Separate with AI
                </button>
                <p style="color: #9ca3af; margin-top: 16px; font-size: 0.875rem;">
                    <i class="fas fa-info-circle"></i> Processing time: 10-60 seconds depending on audio length
                </p>
            </div>
            
            <div id="demucsStemsContainer" style="margin-top: 20px;"></div>
        </div>
    `;
    
    bandsDiv.insertAdjacentHTML('afterbegin', demucsHTML);
    
    // Setup toggle event
    const toggle = document.getElementById('demucsModeToggle');
    const controlPanel = document.getElementById('demucsControlPanel');
    
    toggle.addEventListener('change', () => {
        demucsMode = toggle.checked;
        controlPanel.style.display = toggle.checked ? 'block' : 'none';
        
        // Hide/show frequency-based controls
        const frequencyBands = bandsDiv.querySelectorAll('.band:not(.demucs-stem-control)');
        frequencyBands.forEach(band => {
            band.style.display = toggle.checked ? 'none' : 'grid';
        });
    });
    
    // Setup separation button
    const btnSeparate = document.getElementById('btnSeparateStems');
    if (btnSeparate) {
        btnSeparate.addEventListener('click', async () => {
            if (!inputSignal) {
                alert('⚠️ Please load an audio file first!');
                return;
            }
            await runDemucsSeparation();
        });
    }
}

function displayDemucsStemsControls(results) {
    const container = document.getElementById('demucsStemsContainer');
    container.innerHTML = '';
    container.style.display = 'block';
    
    // Store gains for mixing
    const stemGains = {};
    
    // Stem icons and colors
    const stemConfig = {
        'drums': { icon: 'fa-drum', color: '#ef4444', label: 'Drums' },
        'bass': { icon: 'fa-guitar', color: '#f59e0b', label: 'Bass' },
        'vocals': { icon: 'fa-microphone', color: '#10b981', label: 'Vocals' },
        'other': { icon: 'fa-sliders-h', color: '#8b5cf6', label: 'Other Instruments' }
    };
    
    results.stemNames.forEach(stemName => {
        stemGains[stemName] = 1.0;
        const config = stemConfig[stemName] || { icon: 'fa-music', color: '#3b82f6', label: stemName };
        
        const stemDiv = document.createElement('div');
        stemDiv.className = 'band demucs-stem-control';
        stemDiv.style.background = 'rgba(30, 41, 59, 0.8)';
        stemDiv.style.border = `1px solid ${config.color}40`;
        stemDiv.style.marginBottom = '12px';
        
        stemDiv.innerHTML = `
            <div style="
                display: flex;
                align-items: center;
                gap: 12px;
                grid-column: span 1;
            ">
                <div style="
                    width: 40px;
                    height: 40px;
                    background: ${config.color}20;
                    border: 2px solid ${config.color};
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">
                    <i class="fas ${config.icon}" style="color: ${config.color}; font-size: 1.25rem;"></i>
                </div>
                <strong style="color: #e5e7eb; font-size: 1rem;">${config.label}</strong>
            </div>
            
            <label style="grid-column: span 3; display: flex; flex-direction: column; gap: 8px;">
                <span style="color: #9ca3af; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">Volume</span>
                <input type="range" 
                       id="gain_${stemName}" 
                       min="0" 
                       max="2" 
                       step="0.01" 
                       value="1.0" 
                       style="width: 100%;">
            </label>
            
            <span class="gainVal" style="
                color: ${config.color};
                font-size: 1.125rem;
                font-weight: 700;
                text-align: center;
            ">1.00x</span>
            
            <button class="btn-secondary" onclick="playDemucsStem('${stemName}')" 
                    style="padding: 10px 20px; white-space: nowrap;">
                <i class="fas fa-play"></i> Play
            </button>
        `;
        
        container.appendChild(stemDiv);
        
        // Add gain control listener
        const gainSlider = document.getElementById(`gain_${stemName}`);
        const gainDisplay = stemDiv.querySelector('.gainVal');
        
        gainSlider.addEventListener('input', () => {
            const gain = parseFloat(gainSlider.value);
            stemGains[stemName] = gain;
            gainDisplay.textContent = `${gain.toFixed(2)}x`;
        });
    });
    
    // Add mix button
    const mixButton = document.createElement('button');
    mixButton.className = 'btn-apply';
    mixButton.style.width = '100%';
    mixButton.style.marginTop = '20px';
    mixButton.style.padding = '14px';
    mixButton.style.fontSize = '1rem';
    mixButton.innerHTML = '<i class="fas fa-magic"></i> Mix All Stems and Load to Output';
    mixButton.onclick = () => mixAllStems(stemGains);
    container.appendChild(mixButton);
}

// Play individual stem
window.playDemucsStem = async function(stemName) {
    if (!demucsSeparatedStems || !demucsSeparatedStems.stems[stemName]) {
        console.error('[Demucs] Stem not found:', stemName);
        return;
    }
    
    try {
        await ensureAudioCtx();
        
        console.log(`[Demucs] Playing ${stemName}...`);
        
        // Decode base64
        const base64Data = demucsSeparatedStems.stems[stemName].data;
        const binaryData = atob(base64Data);
        const arrayBuffer = new ArrayBuffer(binaryData.length);
        const view = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < binaryData.length; i++) {
            view[i] = binaryData.charCodeAt(i);
        }
        
        // Decode and play
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const signal = audioBuffer.getChannelData(0);
        
        // Stop any current playback
        if (outSource) {
            try { outSource.stop(); } catch (_) {}
        }
        
        outSource = playBuffer(signal, 1.0, audioCtx, audioBuffer.sampleRate);
        outSource.onended = () => { outSource = null; };
        
    } catch (error) {
        console.error('[Demucs] Play error:', error);
        alert(`Failed to play ${stemName}: ${error.message}`);
    }
};


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
    
    // ADD THIS LINE:
    updateMusicModeUI();
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

// ============================================================================
// DEMUCS AI SEPARATION
// ============================================================================

// Run Demucs separation
async function runDemucsSeparation() {
    const btnSeparate = document.getElementById('btnSeparateStems');
    const originalHTML = btnSeparate.innerHTML;
    
    try {
        btnSeparate.disabled = true;
        btnSeparate.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI Processing... Please wait';
        
        console.log('[Demucs] Starting 4-stem separation...');
        
        // Encode signal
        const blob = encodeWavPCM16Mono(inputSignal, sampleRate);
        const formData = new FormData();
        formData.append('audio', blob, 'input.wav');
        
        // Call Demucs API
        const startTime = performance.now();
        const response = await fetch('/api/demucs', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Server error: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Separation failed');
        }
        
        const elapsedTime = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`[Demucs] Separation complete in ${elapsedTime}s`, data.stem_names);
        
        // Store results
        demucsSeparatedStems = {
            stems: data.stems,
            stemNames: data.stem_names,
            sampleRate: data.sampleRate,
            processingTime: elapsedTime
        };
        
        // Display stems
        displayDemucsStemsControls(demucsSeparatedStems);
        
        alert(`✅ AI Separation Complete!\n\n` +
              `Processing time: ${elapsedTime}s\n` +
              `Stems separated: ${data.stem_names.join(', ')}\n\n` +
              `Now you can adjust each instrument's volume!`);
        
    } catch (error) {
        console.error('[Demucs] Error:', error);
        alert(`❌ AI Separation Failed\n\n${error.message}\n\n` +
              `Make sure Demucs is installed:\n` +
              `pip install demucs torch torchaudio`);
    } finally {
        btnSeparate.disabled = false;
        btnSeparate.innerHTML = originalHTML;
    }
}

function displayDemucsResults(results) {
    let modal = document.getElementById('demucsModal');
    
    if (!modal) {
        // Create modal
        modal = document.createElement('div');
        modal.id = 'demucsModal';
        modal.className = 'spleeter-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2><i class="fas fa-brain"></i> Demucs AI Separation Results</h2>
                    <button class="close-modal" onclick="closeDemucsModal()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body" id="demucsModalBody">
                </div>
                <div class="modal-footer">
                    <p style="color: var(--text-secondary); font-size: 0.875rem;">
                        <i class="fas fa-clock"></i> Processing time: <strong>${results.processingTime}s</strong>
                    </p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    // Populate stems
    const modalBody = document.getElementById('demucsModalBody');
    modalBody.innerHTML = '';
    
    results.stemNames.forEach(stemName => {
        const stem = results.stems[stemName];
        if (!stem) return;
        
        const stemDiv = document.createElement('div');
        stemDiv.className = 'stem-item';
        
        // Icon based on stem type
        let icon = 'fa-music';
        if (stemName === 'drums') icon = 'fa-drum';
        else if (stemName === 'vocals') icon = 'fa-microphone';
        else if (stemName === 'bass') icon = 'fa-guitar';
        
        stemDiv.innerHTML = `
            <div class="stem-header">
                <h3><i class="fas ${icon}"></i> ${stemName.toUpperCase()}</h3>
                <span class="stem-size">${(stem.size / 1024).toFixed(1)} KB</span>
            </div>
            <div class="stem-actions">
                <button class="btn-primary" onclick="playDemucsStem('${stemName}')">
                    <i class="fas fa-play"></i> Play
                </button>
                <button class="btn-secondary" onclick="loadDemucsStemToOutput('${stemName}')">
                    <i class="fas fa-arrow-right"></i> Load to Output
                </button>
                <button class="btn-secondary" onclick="downloadDemucsStem('${stemName}')">
                    <i class="fas fa-download"></i> Download
                </button>
            </div>
        `;
        modalBody.appendChild(stemDiv);
    });
    
    // Show modal
    modal.style.display = 'flex';
}

window.closeDemucsModal = function() {
    const modal = document.getElementById('demucsModal');
    if (modal) {
        modal.style.display = 'none';
    }
};

window.playDemucsStem = async function(stemName) {
    if (!demucsResults || !demucsResults.stems[stemName]) {
        console.error('Stem not found:', stemName);
        return;
    }
    
    try {
        await ensureAudioCtx();
        
        // Decode base64 to audio buffer
        const base64Data = demucsResults.stems[stemName].data;
        const binaryData = atob(base64Data);
        const arrayBuffer = new ArrayBuffer(binaryData.length);
        const view = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < binaryData.length; i++) {
            view[i] = binaryData.charCodeAt(i);
        }
        
        // Decode audio
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const signal = audioBuffer.getChannelData(0);
        
        // Stop any playing audio
        if (outSource) {
            try { outSource.stop(); } catch (_) {}
        }
        
        // Play
        outSource = playBuffer(signal, 1.0, audioCtx, audioBuffer.sampleRate);
        outSource.onended = () => { outSource = null; };
        
        console.log(`Playing ${stemName}`);
    } catch (error) {
        console.error('Play stem error:', error);
        alert(`Failed to play ${stemName}: ${error.message}`);
    }
};

window.loadDemucsStemToOutput = async function(stemName) {
    if (!demucsResults || !demucsResults.stems[stemName]) {
        console.error('Stem not found:', stemName);
        return;
    }
    
    try {
        await ensureAudioCtx();
        
        // Decode base64
        const base64Data = demucsResults.stems[stemName].data;
        const binaryData = atob(base64Data);
        const arrayBuffer = new ArrayBuffer(binaryData.length);
        const view = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < binaryData.length; i++) {
            view[i] = binaryData.charCodeAt(i);
        }
        
        // Decode audio
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        outputSignal = audioBuffer.getChannelData(0).slice();
        
        // Update output viewer
        outputWave.setSignal(outputSignal, audioBuffer.sampleRate);
        syncViews(inputWave.viewStart, inputWave.viewEnd);
        
        // Update visualizations
        await updateFreqView(outputSignal, 'out');
        
        if (toggleSpecGlobal && toggleSpecGlobal.checked) {
            await updateSpecs();
        }
        
        console.log(`${stemName} loaded to output`);
        alert(`✅ ${stemName} loaded to output viewer`);
    } catch (error) {
        console.error('Load stem error:', error);
        alert(`Failed to load ${stemName}: ${error.message}`);
    }
};

window.downloadDemucsStem = function(stemName) {
    if (!demucsResults || !demucsResults.stems[stemName]) {
        console.error('Stem not found:', stemName);
        return;
    }
    
    try {
        // Decode base64
        const base64Data = demucsResults.stems[stemName].data;
        const binaryData = atob(base64Data);
        const arrayBuffer = new ArrayBuffer(binaryData.length);
        const view = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < binaryData.length; i++) {
            view[i] = binaryData.charCodeAt(i);
        }
        
        // Create blob and download
        const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `demucs_${stemName}.wav`;
        a.click();
        URL.revokeObjectURL(url);
        
        console.log(`Downloaded ${stemName}`);
    } catch (error) {
        console.error('Download stem error:', error);
        alert(`Failed to download ${stemName}: ${error.message}`);
    }
};

// ============================================================================
// COMPARISON FUNCTION
// ============================================================================

async function compareDemucsVsEqualizer() {
    const btn = document.getElementById('btnCompare');
    const originalText = btn ? btn.innerHTML : '';
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Comparing...';
        }
        
        console.log('Starting comparison...');
        
        // Encode signal
        const blob = encodeWavPCM16Mono(inputSignal, sampleRate);
        const formData = new FormData();
        formData.append('audio', blob, 'input.wav');
        
        // Call comparison API
        const response = await fetch('/api/demucs_compare', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Comparison failed: ${response.status}`);
        }
        
        const results = await response.json();
        
        // Display comparison results
        displayComparisonResults(results);
        
    } catch (error) {
        console.error('Comparison error:', error);
        alert(`❌ Comparison failed: ${error.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

function displayComparisonResults(results) {
    const demucsTime = results.demucs?.time || 0;
    const eqTime = results.equalizer?.time || 0;
    const comparison = results.comparison || {};
    
    const message = `
📊 COMPARISON RESULTS
${'='.repeat(50)}

⏱️  PROCESSING TIME:
   Demucs AI:        ${demucsTime.toFixed(2)}s
   Your Equalizer:   ${eqTime.toFixed(2)}s
   
   ➡️  Your equalizer is ${comparison.equalizer_faster_by || 'N/A'} FASTER!
   ⚡ Time saved: ${comparison.time_saved || 'N/A'}

🎵 OUTPUT:
   Demucs:     ${results.demucs?.stems?.length || 0} stems (${results.demucs?.stems?.join(', ') || 'N/A'})
   Equalizer:  ${results.equalizer?.bands || 0} frequency bands

💡 SUMMARY:
   • Demucs: Better quality for music separation
   • Your EQ: Much faster, more flexible control
${'='.repeat(50)}
    `;
    
    alert(message);
    console.log('Comparison results:', results);
}

// ============================================================================
// INITIALIZATION - Add this at the VERY END
// ============================================================================

// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('🎵 Signal Equalizer Initialized');
    
    // Initialize Demucs buttons with safe event listeners
    const btnDemucs = document.getElementById('btnDemucs');
    const btnCompare = document.getElementById('btnCompare');
    
    if (btnDemucs) {
        btnDemucs.addEventListener('click', async () => {
            if (!inputSignal) {
                alert('Please load an audio file first!');
                return;
            }
            await runDemucsSeparation();
        });
        console.log('✅ Demucs button initialized');
    } else {
        console.warn('❌ Demucs button not found');
    }
    
    if (btnCompare) {
        btnCompare.addEventListener('click', async () => {
            if (!inputSignal) {
                alert('Please load an audio file first!');
                return;
            }
            await compareDemucsVsEqualizer();
        });
        console.log('✅ Compare button initialized');
    } else {
        console.warn('❌ Compare button not found');
    }
    
    // Update speed value displays
    const inSpeed = document.getElementById('inSpeed');
    const outSpeed = document.getElementById('outSpeed');
    const inSpeedValue = document.querySelector('#inPlay ~ .speed-control .speed-value');
    const outSpeedValue = document.querySelector('#outPlay ~ .speed-control .speed-value');
    
    if (inSpeed && inSpeedValue) {
        inSpeed.addEventListener('input', () => {
            inSpeedValue.textContent = inSpeed.value + 'x';
        });
    }
    
    if (outSpeed && outSpeedValue) {
        outSpeed.addEventListener('input', () => {
            outSpeedValue.textContent = outSpeed.value + 'x';
        });
    }
    
    // Check Demucs availability on startup
    checkDemucsAvailability();
});

// Check Demucs availability and update button states
async function checkDemucsAvailability() {
    try {
        const response = await fetch('/api/demucs_check');
        const data = await response.json();
        
        const btnDemucs = document.getElementById('btnDemucs');
        const btnCompare = document.getElementById('btnCompare');
        
        if (data.available) {
            console.log('✅ Demucs is available');
            if (btnDemucs) {
                btnDemucs.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                btnDemucs.innerHTML = '<i class="fas fa-brain"></i> Demucs AI (Ready)';
            }
            if (btnCompare) {
                btnCompare.disabled = false;
            }
        } else {
            console.warn('❌ Demucs is not available');
            if (btnDemucs) {
                btnDemucs.style.background = 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';
                btnDemucs.innerHTML = '<i class="fas fa-brain"></i> Demucs AI (Not Installed)';
                btnDemucs.title = 'Install: pip install demucs torch torchaudio';
            }
            if (btnCompare) {
                btnCompare.disabled = true;
            }
        }
    } catch (error) {
        console.error('Failed to check Demucs availability:', error);
    }
}


async function mixAllStems(stemGains) {
    if (!demucsSeparatedStems) return;
    
    try {
        await ensureAudioCtx();
        
        console.log('[Demucs] Mixing stems with gains:', stemGains);
        
        // Decode all stems
        const decodedStems = {};
        for (const stemName of demucsSeparatedStems.stemNames) {
            const base64Data = demucsSeparatedStems.stems[stemName].data;
            const binaryData = atob(base64Data);
            const arrayBuffer = new ArrayBuffer(binaryData.length);
            const view = new Uint8Array(arrayBuffer);
            
            for (let i = 0; i < binaryData.length; i++) {
                view[i] = binaryData.charCodeAt(i);
            }
            
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            decodedStems[stemName] = audioBuffer.getChannelData(0);
        }
        
        // Find max length
        const maxLength = Math.max(...Object.values(decodedStems).map(s => s.length));
        
        // Mix stems with gains
        const mixed = new Float32Array(maxLength);
        for (const [stemName, signal] of Object.entries(decodedStems)) {
            const gain = stemGains[stemName] || 1.0;
            for (let i = 0; i < signal.length; i++) {
                mixed[i] += signal[i] * gain;
            }
        }
        
        // Normalize to prevent clipping
        let maxAbs = 0;
        for (let i = 0; i < mixed.length; i++) {
            maxAbs = Math.max(maxAbs, Math.abs(mixed[i]));
        }
        if (maxAbs > 1.0) {
            for (let i = 0; i < mixed.length; i++) {
                mixed[i] /= maxAbs;
            }
            console.log(`[Demucs] Normalized by factor: ${maxAbs.toFixed(2)}`);
        }
        
        // Set as output
        outputSignal = Array.from(mixed);
        outputWave.setSignal(outputSignal, demucsSeparatedStems.sampleRate);
        syncViews(inputWave.viewStart, inputWave.viewEnd);
        
        // Update visualizations
        await updateFreqView(outputSignal, 'out');
        if (toggleSpecGlobal && toggleSpecGlobal.checked) {
            await updateSpecs();
        }
        
        console.log('[Demucs] Mix complete!');
        alert('✅ Stems mixed successfully!\n\nCheck the Output Signal viewer to see the result.');
        
    } catch (error) {
        console.error('[Demucs] Mix error:', error);
        alert(`Failed to mix stems: ${error.message}`);
    }
}

// Update the existing modeSelect change listener
// FIND THIS in your code and REPLACE IT:
/*
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
*/

// WITH THIS (adds updateMusicModeUI call):
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
    
    // ADD THIS LINE:
    updateMusicModeUI();
});

// Call on initial load
updateMusicModeUI();

// Initial state
renderBands(bandsDiv, scheme, presetGroups); 
updateModeUI();
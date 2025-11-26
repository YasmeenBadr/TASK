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
let voiceAIMode = false;

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
        const spectrogramContainers = document.querySelectorAll('.spectrogram-container');
        
        if(!toggleSpecGlobal.checked){
            // Hide spectrograms
            spectrogramContainers.forEach(container => {
                container.classList.add('hidden');
            });
            
            // Abort ongoing fetches
            if(specAbortController){
                specAbortController.abort();
                specAbortController = null;
            }
            
            // Clear canvases
            const ctx1=inputSpec.getContext('2d'); 
            const ctx2=outputSpec.getContext('2d');
            ctx1.clearRect(0,0,inputSpec.width,inputSpec.height);
            ctx2.clearRect(0,0,outputSpec.width,outputSpec.height);
        }else{
            // Show spectrograms
            spectrogramContainers.forEach(container => {
                container.classList.remove('hidden');
            });
            updateSpecs();
        }
    });
}

// ============================================================================
// MODE SWITCHING - Updated to handle Music and Voices AI modes
// ============================================================================

function updateMusicModeUI() {
    const mode = modeSelect.value;
    
    // Remove any existing AI controls
    const existingToggle = document.querySelector('.demucs-mode-toggle');
    if (existingToggle) existingToggle.remove();
    
    const existingPanel = document.getElementById('demucsControlPanel');
    if (existingPanel) existingPanel.remove();
    
    const existingVoiceToggle = document.querySelector('.voice-ai-toggle');
    if (existingVoiceToggle) existingVoiceToggle.remove();
    
    const existingVoicePanel = document.getElementById('voiceAIControlPanel');
    if (existingVoicePanel) existingVoicePanel.remove();
    
    // Clear AI toggle container
    const aiToggleContainer = document.getElementById('ai-toggle-container');
    if (aiToggleContainer) {
        aiToggleContainer.innerHTML = '';
    }
    
    // Reset modes
    demucsMode = false;
    voiceAIMode = false;
    
    // Handle Music Mode
    if (mode === 'music') {
        setupMusicAIMode();
        return;
    }
    
    // Handle Voices Mode
    if (mode === 'voices') {
        setupVoicesAIMode();
        return;
    }
}

// ============================================================================
// MUSIC AI MODE (Demucs)
// ============================================================================

function setupMusicAIMode() {
    // Add AI toggle to header
    const aiToggleContainer = document.getElementById('ai-toggle-container');
    if (aiToggleContainer) {
        aiToggleContainer.innerHTML = `
            <label class="compact-ai-toggle" id="musicAIToggle">
                <input type="checkbox" id="demucsModeToggle" style="display: none;" />
                <i class="fas fa-brain" style="color: #3b82f6;"></i>
                <span class="toggle-label">AI Separation</span>
                <div class="toggle-switch" style="margin-left: 0.5rem;">
                    <span class="slider"></span>
                </div>
            </label>
        `;
    }

    // Add detailed controls to bands container
    const demucsHTML = `
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
    
    const toggle = document.getElementById('demucsModeToggle');
    const toggleLabel = document.getElementById('musicAIToggle');
    const controlPanel = document.getElementById('demucsControlPanel');
    
    if (toggleLabel) {
        toggleLabel.addEventListener('click', () => {
            const isChecked = !toggle.checked;
            toggle.checked = isChecked;
            demucsMode = isChecked;
            
            // Update toggle appearance
            toggleLabel.classList.toggle('active', isChecked);
            
            // Show/hide control panel
            if (controlPanel) {
                controlPanel.style.display = isChecked ? 'block' : 'none';
            }
            
            // Show/hide frequency bands
            const frequencyBands = bandsDiv.querySelectorAll('.band:not(.demucs-stem-control):not(.voice-ai-stem)');
            frequencyBands.forEach(band => {
                band.style.display = isChecked ? 'none' : 'grid';
            });
        });
    }
    
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

// ============================================================================
// VOICES AI MODE (SpeechBrain SepFormer)
// ============================================================================

function setupVoicesAIMode() {
    // Add AI toggle to header
    const aiToggleContainer = document.getElementById('ai-toggle-container');
    if (aiToggleContainer) {
        aiToggleContainer.innerHTML = `
            <label class="compact-ai-toggle" id="voiceAIToggle">
                <input type="checkbox" id="voiceAIModeToggle" style="display: none;" />
                <i class="fas fa-microphone" style="color: #8b5cf6;"></i>
                <span class="toggle-label">AI Voices</span>
                <div class="toggle-switch" style="margin-left: 0.5rem;">
                    <span class="slider"></span>
                </div>
            </label>
        `;
    }

    // Add detailed controls to bands container
    const voiceAIHTML = `
        <div id="voiceAIControlPanel" style="display: none; margin-bottom: 20px;">
            <div style="margin-bottom: 20px;">
                <p style="color: #e5e7eb; margin-bottom: 12px; font-size: 0.95rem; text-align: center;">
                    <i class="fas fa-info-circle"></i> <strong>2-Stage Separation:</strong> Upload two mixed audio files
                </p>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                    <div class="file-upload-box">
                        <label for="voiceMix1Input" style="cursor: pointer; display: block; text-align: center;">
                            <i class="fas fa-upload" style="font-size: 2rem; color: #a78bfa; margin-bottom: 12px;"></i>
                            <p style="margin: 8px 0; color: #e5e7eb;"><strong>Upload Mix 1</strong></p>
                            <p style="font-size: 0.85rem; color: #9ca3af; margin: 4px 0;">Old Man + Woman</p>
                            <input type="file" id="voiceMix1Input" accept="audio/wav" style="display:none;">
                            <span id="mix1FileName" style="font-size: 0.8rem; color: #10b981; display: none;"></span>
                        </label>
                    </div>
                    <div class="file-upload-box">
                        <label for="voiceMix2Input" style="cursor: pointer; display: block; text-align: center;">
                            <i class="fas fa-upload" style="font-size: 2rem; color: #60a5fa; margin-bottom: 12px;"></i>
                            <p style="margin: 8px 0; color: #e5e7eb;"><strong>Upload Mix 2</strong></p>
                            <p style="font-size: 0.85rem; color: #9ca3af; margin: 4px 0;">Man + Child</p>
                            <input type="file" id="voiceMix2Input" accept="audio/wav" style="display:none;">
                            <span id="mix2FileName" style="font-size: 0.8rem; color: #10b981; display: none;"></span>
                        </label>
                    </div>
                </div>
            </div>
            
            <div style="
                text-align: center;
                padding: 32px;
                background: rgba(30, 41, 59, 0.6);
                border-radius: 12px;
                border: 1px solid rgba(148, 163, 184, 0.2);
            ">
                <button id="btnSeparateVoices" class="btn-primary" style="
                    padding: 14px 40px;
                    font-size: 1rem;
                    box-shadow: 0 4px 6px -1px rgba(139, 92, 246, 0.3);
                ">
                    <i class="fas fa-magic"></i>
                    Separate Voices with AI
                </button>
                <p style="color: #9ca3af; margin-top: 16px; font-size: 0.875rem;">
                    <i class="fas fa-info-circle"></i> Processing time: 15-45 seconds depending on audio length
                </p>
            </div>
            
            <div id="voiceAIStemsContainer" style="margin-top: 20px;"></div>
        </div>
    `;
    
    bandsDiv.insertAdjacentHTML('afterbegin', voiceAIHTML);
    
    // Setup file input listeners
    const mix1Input = document.getElementById('voiceMix1Input');
    const mix2Input = document.getElementById('voiceMix2Input');
    const mix1FileName = document.getElementById('mix1FileName');
    const mix2FileName = document.getElementById('mix2FileName');
    
    if (mix1Input) {
        mix1Input.addEventListener('change', () => {
            if (mix1Input.files[0]) {
                mix1FileName.textContent = '✓ ' + mix1Input.files[0].name;
                mix1FileName.style.display = 'block';
            }
        });
    }
    
    if (mix2Input) {
        mix2Input.addEventListener('change', () => {
            if (mix2Input.files[0]) {
                mix2FileName.textContent = '✓ ' + mix2Input.files[0].name;
                mix2FileName.style.display = 'block';
            }
        });
    }
    
    // Setup toggle event
    const toggle = document.getElementById('voiceAIModeToggle');
    const toggleLabel = document.getElementById('voiceAIToggle');
    const controlPanel = document.getElementById('voiceAIControlPanel');
    
    if (toggleLabel) {
        toggleLabel.addEventListener('click', () => {
            const isChecked = !toggle.checked;
            toggle.checked = isChecked;
            voiceAIMode = isChecked;
            
            // Update toggle appearance
            toggleLabel.classList.toggle('active', isChecked);
            
            // Show/hide control panel
            if (controlPanel) {
                controlPanel.style.display = isChecked ? 'block' : 'none';
            }
            
            // Show/hide frequency bands
            const frequencyBands = bandsDiv.querySelectorAll('.band:not(.voice-ai-stem):not(.demucs-stem-control)');
            frequencyBands.forEach(band => {
                band.style.display = isChecked ? 'none' : 'grid';
            });
            
            // Check SpeechBrain availability when toggled on
            if (isChecked) {
                checkSpeechBrainAvailability();
            }
        });
    }
    
    // Setup separation button
    const btnSeparate = document.getElementById('btnSeparateVoices');
    if (btnSeparate) {
        btnSeparate.addEventListener('click', async () => {
            await runVoiceAISeparation();
        });
    }
    
    // Check SpeechBrain availability
    checkSpeechBrainAvailability();
}

// ============================================================================
// VOICE AI SEPARATION FUNCTION
// ============================================================================

async function runVoiceAISeparation() {
    const btnSeparate = document.getElementById('btnSeparateVoices');
    const mix1Input = document.getElementById('voiceMix1Input');
    const mix2Input = document.getElementById('voiceMix2Input');
    
    if (!mix1Input.files[0] || !mix2Input.files[0]) {
        alert('⚠️ Please upload both mixed audio files!\n\nMix 1: Old Man + Woman\nMix 2: Man + Child');
        return;
    }
    
    const originalHTML = btnSeparate.innerHTML;
    
    try {
        btnSeparate.disabled = true;
        btnSeparate.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI Processing... Please wait';
        
        console.log('[SpeechBrain] Starting 2-stage voice separation...');
        
        const formData = new FormData();
        formData.append('audio1', mix1Input.files[0], 'mix1_old_woman.wav');
        formData.append('audio2', mix2Input.files[0], 'mix2_man_child.wav');
        formData.append('labels', 'Old Man,Woman,Man,Child');
        
        const startTime = performance.now();
        const response = await fetch('/api/speechbrain_separate', {
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
        console.log(`[SpeechBrain] Separation complete in ${elapsedTime}s`, data.stemNames);
        
        // Store results globally (reuse demucs structure)
        demucsSeparatedStems = {
            stems: data.stems,
            stemNames: data.stemNames,
            sampleRate: data.sampleRate,
            processingTime: elapsedTime,
            isVoiceMode: true
        };
        
        // Display voice stems
        displayVoiceAIStemsControls(demucsSeparatedStems);
        
        alert(`✅ Voice Separation Complete!\n\n` +
              `Processing time: ${elapsedTime}s\n` +
              `Speakers separated: ${data.labels.join(', ')}\n\n` +
              `Now you can adjust each speaker's volume!`);
        
    } catch (error) {
        console.error('[SpeechBrain] Error:', error);
        alert(`❌ Voice Separation Failed\n\n${error.message}\n\n` +
              `Make sure SpeechBrain is installed:\n` +
              `pip install speechbrain torchaudio`);
    } finally {
        btnSeparate.disabled = false;
        btnSeparate.innerHTML = originalHTML;
    }
}

function displayVoiceAIStemsControls(results) {
    const container = document.getElementById('voiceAIStemsContainer');
    container.innerHTML = '';
    container.style.display = 'block';
    
    // Initialize global stem gains object
    window.stemGains = {};
    
    // Speaker icons and colors (matching human voices theme)
    const stemConfig = {
        'old_man': { icon: 'fa-user-tie', color: '#6366f1', label: 'Old Man' },
        'woman': { icon: 'fa-user-graduate', color: '#ec4899', label: 'Woman' },
        'man': { icon: 'fa-user', color: '#3b82f6', label: 'Man' },
        'child': { icon: 'fa-child', color: '#10b981', label: 'Child' }
    };
    
    results.stemNames.forEach(stemName => {
        window.stemGains[stemName] = 1.0;
        const config = stemConfig[stemName] || { icon: 'fa-microphone', color: '#8b5cf6', label: stemName };
        
        const stemDiv = document.createElement('div');
        stemDiv.className = 'band voice-ai-stem';
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
            
            <button class="btn-secondary" onclick="playVoiceStem('${stemName}')" 
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
            window.stemGains[stemName] = gain;
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
    mixButton.innerHTML = '<i class="fas fa-magic"></i> Mix All Speakers and Load to Output';
    mixButton.onclick = () => mixAllStems();
    container.appendChild(mixButton);
}

// Play individual voice stem
window.playVoiceStem = async function(stemName) {
    if (!demucsSeparatedStems || !demucsSeparatedStems.stems[stemName]) {
        console.error('[VoiceAI] Stem not found:', stemName);
        return;
    }
    
    try {
        await ensureAudioCtx();
        
        console.log(`[VoiceAI] Playing ${stemName}...`);
        
        // Decode base64
        const base64Data = demucsSeparatedStems.stems[stemName].data;
        const binaryData = atob(base64Data);
        const arrayBuffer = new ArrayBuffer(binaryData.length);
        const view = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < binaryData.length; i++) {
            view[i] = binaryData.charCodeAt(i);
        }
        
        // Decode audio
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        // Play the audio
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        
        // Stop any current playback
        if (outSource) {
            try { outSource.stop(); } catch (_) {}
        }
        
        // Start playing
        source.start();
        outSource = source;
        source.onended = () => { outSource = null; };
        
        console.log(`[VoiceAI] Playing ${stemName} - duration: ${audioBuffer.duration}s`);
        
    } catch (error) {
        console.error('[VoiceAI] Play error:', error);
        alert(`Failed to play ${stemName}: ${error.message}`);
    }
};

async function checkSpeechBrainAvailability() {
    try {
        const response = await fetch('/api/speechbrain_check');
        const data = await response.json();
        
        const btnSeparate = document.getElementById('btnSeparateVoices');
        
        if (data.available) {
            console.log('✅ SpeechBrain is available');
            if (btnSeparate) {
                btnSeparate.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                btnSeparate.innerHTML = '<i class="fas fa-magic"></i> Separate Voices with AI (Ready)';
            }
        } else {
            console.warn('❌ SpeechBrain is not available');
            if (btnSeparate) {
                btnSeparate.style.background = 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';
                btnSeparate.innerHTML = '<i class="fas fa-magic"></i> Separate Voices with AI (Not Installed)';
                btnSeparate.title = 'Install: pip install speechbrain torchaudio';
            }
        }
    } catch (error) {
        console.error('Failed to check SpeechBrain availability:', error);
    }
}

// ============================================================================
// DEMUCS MUSIC SEPARATION
// ============================================================================

function displayDemucsStemsControls(results) {
    const container = document.getElementById('demucsStemsContainer');
    container.innerHTML = '';
    container.style.display = 'block';
    
    // Initialize global stem gains object
    window.stemGains = {};
    
    // Stem icons and colors
    const stemConfig = {
        'drums': { icon: 'fa-drum', color: '#ef4444', label: 'Drums' },
        'bass': { icon: 'fa-guitar', color: '#f59e0b', label: 'Bass' },
        'vocals': { icon: 'fa-microphone', color: '#10b981', label: 'Vocals' },
        'other': { icon: 'fa-sliders-h', color: '#8b5cf6', label: 'Other Instruments' }
    };
    
    results.stemNames.forEach(stemName => {
        window.stemGains[stemName] = 1.0;
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
            window.stemGains[stemName] = gain;
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
    mixButton.onclick = () => mixAllStems();
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
        
        // Decode audio
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        
        // Stop any current playback
        if (outSource) {
            try { outSource.stop(); } catch (_) {}
        }
        
        // Start playing
        source.start();
        outSource = source;
        source.onended = () => { outSource = null; };
        
        console.log(`[Demucs] Playing ${stemName} - duration: ${audioBuffer.duration}s`);
        
    } catch (error) {
        console.error('[Demucs] Play error:', error);
        alert(`Failed to play ${stemName}: ${error.message}`);
    }
};

async function runDemucsSeparation() {
    const btnSeparate = document.getElementById('btnSeparateStems');
    const originalHTML = btnSeparate.innerHTML;
    
    try {
        btnSeparate.disabled = true;
        btnSeparate.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI Processing... Please wait';
        
        console.log('[Demucs] Starting 4-stem separation...');
        
        const blob = encodeWavPCM16Mono(inputSignal, sampleRate);
        const formData = new FormData();
        formData.append('audio', blob, 'input.wav');
        
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
        
        const stemNames = data.stem_names || data.stemNames || Object.keys(data.stems || {});

        demucsSeparatedStems = {
            stems: data.stems,
            stemNames: stemNames,
            sampleRate: data.sampleRate,
            processingTime: elapsedTime
        };

        displayDemucsStemsControls(demucsSeparatedStems);

        alert(`✅ AI Separation Complete!\n\n` +
              `Processing time: ${elapsedTime}s\n` +
              `Stems separated: ${stemNames.join(', ')}\n\n` +
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

// ============================================================================
// MIX ALL STEMS FUNCTION (Works for both Music and Voice modes)
// ============================================================================

async function mixAllStems() {
    if (!demucsSeparatedStems) {
        alert('❌ No stems available. Please run AI separation first.');
        return;
    }
    
    if (!window.stemGains) {
        alert('❌ Stem gains not initialized.');
        return;
    }
    
    try {
        await ensureAudioCtx();
        
        const modeLabel = demucsSeparatedStems.isVoiceMode ? 'VoiceAI' : 'Demucs';
        console.log(`[${modeLabel}] Mixing stems with gains:`, window.stemGains);
        
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
        let activeStemsCount = 0;
        
        for (const [stemName, signal] of Object.entries(decodedStems)) {
            const gain = window.stemGains[stemName];
            
            if (gain === undefined || gain === 0) {
                console.log(`[${modeLabel}] Skipping ${stemName} (gain: ${gain})`);
                continue;
            }
            
            activeStemsCount++;
            console.log(`[${modeLabel}] Mixing ${stemName} with gain: ${gain}`);
            
            for (let i = 0; i < signal.length; i++) {
                mixed[i] += signal[i] * gain;
            }
        }
        
        console.log(`[${modeLabel}] Mixed ${activeStemsCount} active stems`);
        
        // Normalize to prevent clipping
        let maxAbs = 0;
        for (let i = 0; i < mixed.length; i++) {
            maxAbs = Math.max(maxAbs, Math.abs(mixed[i]));
        }
        if (maxAbs > 1.0) {
            for (let i = 0; i < mixed.length; i++) {
                mixed[i] /= maxAbs;
            }
            console.log(`[${modeLabel}] Normalized by factor: ${maxAbs.toFixed(2)}`);
        }
        
        // Set as output
        outputSignal = mixed;
        outputWave.setSignal(outputSignal, demucsSeparatedStems.sampleRate);
        sampleRate = demucsSeparatedStems.sampleRate;
        syncViews(inputWave.viewStart, inputWave.viewEnd);
        
        // Update visualizations
        await updateFreqView(outputSignal, 'out');
        if (toggleSpecGlobal && toggleSpecGlobal.checked) {
            await updateSpecs();
        }
        
        console.log(`[${modeLabel}] Mix complete!`);
        alert(`✅ ${demucsSeparatedStems.isVoiceMode ? 'Speakers' : 'Stems'} mixed successfully!\n\n` +
              `Active ${demucsSeparatedStems.isVoiceMode ? 'speakers' : 'stems'}: ${activeStemsCount}\n` +
              `Total samples: ${mixed.length}\n\n` +
              `Check the Output Signal viewer and click Play to hear the result.`);
        
    } catch (error) {
        console.error('[Mix] Error:', error);
        alert(`❌ Failed to mix: ${error.message}`);
    }
}

// ============================================================================
// MODE SELECTION EVENT LISTENER
// ============================================================================

modeSelect.addEventListener('change', async ()=>{
    if(modeSelect.value==='generic'){ 
        presetGroups=null; 
        renderBands(bandsDiv, scheme, presetGroups); 
        updateModeUI(); 
        updateMusicModeUI();
        return; 
    }
    
    try{
      const resp = await fetch('./presets.json');
      if (!resp.ok) {
        throw new Error(`Failed to load presets: ${resp.status}`);
      }
      const data = await resp.json();
      const p = data[modeSelect.value];
      
      if (!p || !p.sliders) {
        console.error(`No preset found for mode: ${modeSelect.value}`);
        presetGroups = [];
      } else {
        presetGroups = p.sliders.map(s=>({
          label: s.label, 
          windows: s.windows || [], 
          gain: typeof s.gain === 'number' ? s.gain : 1
        }));
        console.log(`Loaded ${presetGroups.length} preset groups for ${modeSelect.value}`);
      }
    }catch(e){ 
        console.error('Failed to load presets:', e); 
        presetGroups=[]; 
    }
    
    renderBands(bandsDiv, scheme, presetGroups); 
    updateModeUI();
    updateMusicModeUI();
});

// ============================================================================
// FILE INPUT AND SIGNAL GENERATION
// ============================================================================

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

// ============================================================================
// PLAYBACK CONTROLS
// ============================================================================

let inSource=null, outSource=null;

async function ensureAudioCtx(){
    if(!audioCtx) {
        audioCtx = new (window.AudioContext||window.webkitAudioContext)();
        console.log('✅ AudioContext created');
    }
    if(audioCtx.state === 'suspended') {
        await audioCtx.resume();
        console.log('✅ AudioContext resumed');
    }
    console.log(`🔊 AudioContext state: ${audioCtx.state}, sampleRate: ${audioCtx.sampleRate}`);
}

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

// ============================================================================
// VIEWER INTERACTION (Zoom/Pan)
// ============================================================================

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
// DEMUCS AVAILABILITY CHECK
// ============================================================================

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

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('🎵 Signal Equalizer Initialized');
    
    checkDemucsAvailability();
});

// Initial state
renderBands(bandsDiv, scheme, presetGroups); 
updateModeUI();
updateMusicModeUI();
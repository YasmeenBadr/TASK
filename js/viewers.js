// Enhanced TimeViewer with linked behavior, zoom, and pan support
export class TimeViewer {
    constructor(canvas, id, onViewChange = null) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.id = id;
        this.onViewChange = onViewChange;
        
        // Signal data
        this.signal = null;
        this.sampleRate = 44100;
        
        // View state
        this.viewStart = 0;
        this.viewEnd = 1;
        this.viewMinDuration = 0.01; // Minimum view duration in seconds
        
        // Interaction state
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartViewStart = 0;
        this.dragStartViewEnd = 0;
        
        // Style - Spotify theme
        this.waveColor = id === 'input' ? '#1DB954' : '#1ed760';
        this.backgroundColor = '#121212';
        this.gridColor = '#282828';
        this.textColor = '#b3b3b3';
        this.cursorColor = '#ffffff';
        this.waveLineWidth = 1.5;
        this.wavePeakColor = '#ffffff';
        this.cursorX = null;
        
        // Setup canvas
        this.setupCanvas();
    }
    
    setupCanvas() {
        const canvas = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        
        // Set display size (CSS pixels)
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        
        // Set actual size in memory (scaled for DPI)
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        
        // Normalize coordinate system to use CSS pixels
        this.ctx.scale(dpr, dpr);
        
        // Add event listeners
        canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
        canvas.addEventListener('mouseleave', () => {
            this.cursorX = null;
            this.draw();
        });
    }
    
    setSignal(sig, sr) {
        this.signal = sig;
        this.sampleRate = sr;
        this.viewStart = 0;
        this.viewEnd = Math.min(5, sig.length / sr); // Default to 5 seconds or signal length
        this.draw();
    }
    
    setView(start, end, skipCallback = false) {
        if (!this.signal) return;
        
        const duration = this.signal.length / this.sampleRate;
        const newStart = Math.max(0, start);
        const newEnd = Math.min(duration, Math.max(newStart + this.viewMinDuration, end));
        
        // Only update if the view has actually changed
        if (Math.abs(this.viewStart - newStart) > 1e-9 || Math.abs(this.viewEnd - newEnd) > 1e-9) {
            this.viewStart = newStart;
            this.viewEnd = newEnd;
            
            // Only trigger callback if not skipped (prevents infinite loop)
            if (this.onViewChange && !skipCallback) {
                this.onViewChange(this.id, this.viewStart, this.viewEnd);
            }
            
            this.draw();
        }
    }
    
    zoom(factor, centerX) {
        if (!this.signal) return;
        
        const duration = this.signal.length / this.sampleRate;
        const centerTime = this.viewStart + (centerX / this.canvas.width) * (this.viewEnd - this.viewStart);
        
        let newWidth = (this.viewEnd - this.viewStart) * factor;
        newWidth = Math.max(this.viewMinDuration, Math.min(duration, newWidth));
        
        const newStart = Math.max(0, centerTime - (centerX / this.canvas.width) * newWidth);
        const newEnd = Math.min(duration, newStart + newWidth);
        
        this.setView(newStart, newEnd);
    }
    
    pan(dx) {
        if (!this.signal) return;
        
        const duration = this.signal.length / this.sampleRate;
        const viewDuration = this.viewEnd - this.viewStart;
        const timePerPixel = viewDuration / this.canvas.width;
        const deltaTime = dx * timePerPixel;
        
        let newStart = this.viewStart - deltaTime;
        let newEnd = this.viewEnd - deltaTime;
        
        // Handle boundaries
        if (newStart < 0) {
            newStart = 0;
            newEnd = Math.min(duration, viewDuration);
        } else if (newEnd > duration) {
            newEnd = duration;
            newStart = Math.max(0, duration - viewDuration);
        }
        
        this.setView(newStart, newEnd);
    }
    
    resetView() {
        if (!this.signal) return;
        const duration = this.signal.length / this.sampleRate;
        this.setView(0, Math.min(5, duration));
    }
    
    // Event handlers
    handleMouseDown(e) {
        this.isDragging = true;
        this.dragStartX = e.offsetX;
        this.dragStartViewStart = this.viewStart;
        this.dragStartViewEnd = this.viewEnd;
        this.canvas.style.cursor = 'grabbing';
    }
    
    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.cursorX = e.clientX - rect.left;
        
        if (this.isDragging) {
            const dx = e.offsetX - this.dragStartX;
            const viewDuration = this.dragStartViewEnd - this.dragStartViewStart;
            const timePerPixel = viewDuration / this.canvas.width;
            const deltaTime = dx * timePerPixel;
            
            this.setView(
                this.dragStartViewStart - deltaTime,
                this.dragStartViewEnd - deltaTime
            );
        }
        
        this.draw();
    }
    
    handleMouseUp() {
        this.isDragging = false;
        this.canvas.style.cursor = 'default';
    }
    
    handleWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1; // Zoom in/out factor
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left; // x position relative to canvas
        this.zoom(delta, x);
    }
    
    // Drawing methods
    draw() {
        const ctx = this.ctx;
        const c = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const width = c.width / dpr;
        const height = c.height / dpr;
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        // Draw background
        ctx.fillStyle = this.backgroundColor;
        ctx.fillRect(0, 0, width, height);
        
        if (!this.signal) return;
        
        const s = this.signal;
        const sr = this.sampleRate;
        const t0 = this.viewStart;
        const t1 = this.viewEnd;
        const i0 = Math.floor(t0 * sr);
        const i1 = Math.min(s.length - 1, Math.ceil(t1 * sr));
        const span = i1 - i0;
        
        // Draw grid lines
        this.drawGrid(width, height);
        
        // Draw waveform with gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, this.waveColor);
        gradient.addColorStop(1, this.wavePeakColor);
        
        // Draw filled waveform
        ctx.fillStyle = gradient;
        ctx.beginPath();
        
        // Move to starting point on the left
        ctx.moveTo(0, height / 2);
        
        // Draw top half of the waveform
        for (let x = 0; x < width; x++) {
            const idx = i0 + Math.floor(span * x / width);
            const y = (0.5 - 0.4 * (s[idx] || 0)) * height;
            ctx.lineTo(x, y);
        }
        
        // Draw bottom half of the waveform in reverse
        for (let x = width - 1; x >= 0; x--) {
            const idx = i0 + Math.floor(span * x / width);
            const y = (0.5 + 0.4 * (s[idx] || 0)) * height;
            ctx.lineTo(x, y);
        }
        
        // Close the path and fill
        ctx.closePath();
        ctx.fill();
        
        // Draw a subtle stroke around the waveform
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        
        // Draw cursor
        if (this.cursorX !== null && this.cursorX >= 0 && this.cursorX <= width) {
            ctx.strokeStyle = this.cursorColor;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(this.cursorX, 0);
            ctx.lineTo(this.cursorX, height);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // Show time at cursor position
            const timeAtCursor = t0 + (this.cursorX / width) * (t1 - t0);
            this.drawTimeMarker(timeAtCursor, this.cursorX, height);
        }
        
        // Draw time markers at bottom
        this.drawTimeMarkers(width, height);
    }
    
    drawGrid(width, height) {
        const ctx = this.ctx;
        const t0 = this.viewStart;
        const t1 = this.viewEnd;
        const duration = t1 - t0;
        
        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 0.5;
        
        // Horizontal grid lines
        for (let y = 0; y <= 1; y += 0.25) {
            const yPos = y * height;
            ctx.beginPath();
            ctx.moveTo(0, yPos);
            ctx.lineTo(width, yPos);
            ctx.stroke();
            
            // Add amplitude labels
            if (y > 0 && y < 1) {
                ctx.fillStyle = this.textColor;
                ctx.font = '10px Arial';
                ctx.textAlign = 'right';
                ctx.fillText((1 - 2 * y).toFixed(1), 30, yPos - 2);
            }
        }
        
        // Vertical time markers
        const timeStep = this.calculateTimeStep(duration, width);
        if (timeStep > 0) {
            const firstTick = Math.ceil(t0 / timeStep) * timeStep;
            
            for (let t = firstTick; t < t1; t += timeStep) {
                const x = ((t - t0) / duration) * width;
                
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
        }
    }
    
    drawTimeMarkers(width, height) {
        const ctx = this.ctx;
        const t0 = this.viewStart;
        const t1 = this.viewEnd;
        const duration = t1 - t0;
        
        ctx.fillStyle = this.textColor;
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        
        const timeStep = this.calculateTimeStep(duration, width);
        if (timeStep > 0) {
            const firstTick = Math.ceil(t0 / timeStep) * timeStep;
            
            for (let t = firstTick; t < t1; t += timeStep) {
                const x = ((t - t0) / duration) * width;
                const timeStr = this.formatTime(t);
                
                // Only draw label if there's enough space
                if (timeStr.length * 6 < width * (timeStep / duration)) {
                    ctx.fillText(timeStr, x, height - 2);
                }
            }
        }
    }
    
    drawTimeMarker(time, x, height) {
        const ctx = this.ctx;
        const timeStr = this.formatTime(time);
        
        // Draw background for better readability
        const textWidth = ctx.measureText(timeStr).width;
        const padding = 4;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(
            x - textWidth / 2 - padding,
            height - 15,
            textWidth + padding * 2,
            14
        );
        
        // Draw time text
        ctx.fillStyle = this.cursorColor;
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(timeStr, x, height - 4);
    }
    
    calculateTimeStep(duration, width) {
        // Calculate appropriate time step based on duration and width
        const targetPixelsPerTick = 80; // Aim for a tick every ~80 pixels
        const minTicks = 3;
        const maxTicks = Math.max(minTicks, Math.floor(width / targetPixelsPerTick));
        
        // Find the best time step from common values
        const possibleSteps = [
            0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 
            1, 2, 5, 10, 15, 30, 60, 120, 300, 600
        ];
        
        // Find the smallest step that gives us enough ticks
        for (const step of possibleSteps) {
            const numTicks = duration / step;
            if (numTicks <= maxTicks) {
                return step;
            }
        }
        
        // Default to a reasonable step if duration is very large
        return Math.ceil(duration / maxTicks);
    }
    
    formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
        } else if (m > 0) {
            return `${m}:${s.toFixed(2).padStart(5, '0')}`;
        } else {
            return s.toFixed(2) + 's';
        }
    }
}

export function drawSpectrum(canvas, magnitudes, sampleRate, scale, magScale='linear'){
  const ctx=canvas.getContext('2d'); const w=canvas.width, h=canvas.height; ctx.clearRect(0,0,w,h); if(!magnitudes) return;
  const N = magnitudes.length*2; const binHz=sampleRate/N;
  const eps=1e-12;
  let normVals = null;
  if(magScale==='db'){
    let max=eps; for(let i=0;i<magnitudes.length;i++){ const v=magnitudes[i]; if(v>max) max=v; }
    const dbMax = 20*Math.log10(max+eps);
    const dyn = 80;
    const dbMin = dbMax - dyn;
    normVals = new Float32Array(magnitudes.length);
    for(let i=0;i<magnitudes.length;i++){
      const db = 20*Math.log10((magnitudes[i]||0)+eps);
      normVals[i] = Math.max(0, Math.min(1, (db - dbMin)/(dbMax - dbMin)));
    }
  }else{
    let max=eps; for(let i=0;i<magnitudes.length;i++){ const v=magnitudes[i]; if(v>max) max=v; }
    normVals = new Float32Array(magnitudes.length);
    for(let i=0;i<magnitudes.length;i++) normVals[i] = magnitudes[i]/max;
  }
  ctx.strokeStyle="#34d399"; ctx.beginPath();
  for(let i=0;i<magnitudes.length;i++){
    const f=i*binHz; const x = scale==='audiogram' ? audiogramX(f, sampleRate, w) : (i/(magnitudes.length-1))*w;
    const m=normVals[i]; const y = (1-m)*h; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // Draw frequency axis ticks and labels
  const nyq = sampleRate/2;
  const baseTicks = [0,100,200,500,1000,2000,5000,10000,15000,20000].filter(f=>f<=nyq);
  ctx.save();
  ctx.strokeStyle = '#374151';
  ctx.fillStyle = '#9ca3af';
  ctx.lineWidth = 1;
  // baseline
  ctx.beginPath();
  ctx.moveTo(0, h-0.5);
  ctx.lineTo(w, h-0.5);
  ctx.stroke();
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  baseTicks.forEach(f=>{
    const x = scale==='audiogram' ? audiogramX(f, sampleRate, w) : (f/nyq)*w;
    // tick
    ctx.beginPath();
    ctx.moveTo(x+0.5, h-8);
    ctx.lineTo(x+0.5, h);
    ctx.stroke();
    // label
    const label = (f>=1000) ? `${(f/1000)}k` : `${f}`;
    ctx.fillText(label, x, h-10);
  });
  ctx.restore();
}

export function drawSpectrogram(canvas, spec, sampleRate){
  const ctx = canvas.getContext('2d'); 
  const w = canvas.width, h = canvas.height; 
  
  // Clear the canvas with a light background for debugging
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, w, h);
  
  if (!spec || spec.length === 0) {
    return;
  }
  
  const frames = spec.length;
  const bins = spec[0].length;
  
  // Compute global max magnitude safely, then derive dB range
  let max = 1e-12;
  let min = Infinity;
  for (let i = 0; i < frames; i++) {
    const row = spec[i];
    for (let k = 0; k < bins; k++) {
      const v = row[k];
      if (v > max) max = v;
      if (v < min && v > 0) min = v; // Avoid log(0)
    }
  }
  
  const eps = 1e-12;
  const dbMax = 20 * Math.log10(max + eps);
  const dbMin = 20 * Math.log10(min + eps);
  const dynRange = Math.min(120, dbMax - dbMin); // Limit dynamic range to 120dB max
  
  // Adjust the minimum to ensure we have a reasonable range
  const adjustedDbMin = dbMax - dynRange;
  
  // Create image data for better performance
  const img = ctx.createImageData(w, h);
  const data = img.data;
  
  for (let x = 0; x < w; x++) {
    // Fix: Use proper frame indexing
    const fi = Math.min(frames - 1, Math.floor(x / w * frames));
    const row = spec[fi];
    
    for (let y = 0; y < h; y++) {
      // Proper bin indexing: low frequencies at bottom (y increases downward)
      const bi = Math.min(bins - 1, Math.floor((1 - y / h) * bins));
      // Convert magnitude to dB and normalize to [0,1] within dynamic range
      const vdb = 20 * Math.log10((row[bi] || 0) + eps);
      // Normalize to [0, 1] within the dynamic range
      let v = (vdb - adjustedDbMin) / dynRange;
      // Apply a slight gamma correction to enhance visibility
      v = Math.pow(Math.max(0, Math.min(1, v)), 0.8);
      const c = colorMap(v);
      
      const idx = (y * w + x) * 4;
      data[idx] = c[0];     // R
      data[idx + 1] = c[1]; // G
      data[idx + 2] = c[2]; // B
      data[idx + 3] = 255;  // A
    }
  }
  ctx.putImageData(img, 0, 0);
  
  // Add a border to make the canvas visible for debugging
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w-2, h-2);
}

// Green color map for spectrogram
function colorMap(v) {
    // Ensure v is within [0, 1] range
    v = Math.max(0, Math.min(1, v));
    
    // Map from [0, 1] to a vibrant green color gradient
    // Black -> Dark Green -> Bright Green -> Yellow -> White
    let r, g, b;
    
    if (v < 0.25) {
        // Black to dark green
        const t = v * 4;
        r = 0;
        g = Math.round(100 * t);
        b = 0;
    } else if (v < 0.5) {
        // Dark green to bright green
        const t = (v - 0.25) * 4;
        r = 0;
        g = 100 + Math.round(155 * t);
        b = 0;
    } else if (v < 0.75) {
        // Bright green to yellow
        const t = (v - 0.5) * 4;
        r = Math.round(255 * t);
        g = 255;
        b = 0;
    } else {
        // Yellow to white
        const t = (v - 0.75) * 4;
        r = 255;
        g = 255;
        b = Math.round(255 * t);
    }
    
    // Return as an array of [r, g, b] values
    return [r, g, b];
}

function audiogramX(f, sr, width){
  // Simple psycho-like scale: map frequency to Bark-like logarithmic scale for UI
  const fmin=20, fmax=sr/2; const lf=Math.log10(fmin), hf=Math.log10(fmax); const xf=(Math.log10(Math.max(fmin, f))-lf)/(hf-lf); return xf*width;
}
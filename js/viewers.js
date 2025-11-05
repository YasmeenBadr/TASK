// Simple linked viewers and drawing utilities
export class TimeViewer{
  constructor(canvas){this.canvas=canvas; this.ctx=canvas.getContext('2d'); this.viewStart=0; this.viewEnd=1; this.signal=null; this.sampleRate=44100}
  setSignal(sig, sr){this.signal=sig; this.sampleRate=sr; this.viewStart=0; this.viewEnd=Math.min(1, sig.length/sr)}
  setView(start,end){this.viewStart=Math.max(0,start); this.viewEnd=Math.max(this.viewStart+0.01,end); this.draw()}
  draw(){const ctx=this.ctx, c=this.canvas; ctx.clearRect(0,0,c.width,c.height); if(!this.signal) return; const s=this.signal; const sr=this.sampleRate; const t0=this.viewStart, t1=this.viewEnd; const i0=Math.floor(t0*sr), i1=Math.min(s.length-1, Math.ceil(t1*sr)); const span=i1-i0; ctx.strokeStyle="#60a5fa"; ctx.beginPath(); for(let x=0;x<c.width;x++){ const idx=i0+Math.floor(span*x/c.width); const y=(0.5-0.45*(s[idx]||0))*c.height; if(x===0) ctx.moveTo(0,y); else ctx.lineTo(x,y);} ctx.stroke();}
}

export function drawSpectrum(canvas, magnitudes, sampleRate, scale){
  const ctx=canvas.getContext('2d'); const w=canvas.width, h=canvas.height; ctx.clearRect(0,0,w,h); if(!magnitudes) return;
  const N = magnitudes.length*2; const binHz=sampleRate/N;
  const maxMag = 1e-6 + Math.max(...magnitudes);
  ctx.strokeStyle="#34d399"; ctx.beginPath();
  for(let i=0;i<magnitudes.length;i++){
    const f=i*binHz; const x = scale==='audiogram' ? audiogramX(f, sampleRate, w) : (i/(magnitudes.length-1))*w;
    const m=magnitudes[i]/maxMag; const y = (1-m)*h; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}

function audiogramX(f, sr, width){
  // Simple psycho-like scale: map frequency to Bark-like logarithmic scale for UI
  const fmin=20, fmax=sr/2; const lf=Math.log10(fmin), hf=Math.log10(fmax); const xf=(Math.log10(Math.max(fmin, f))-lf)/(hf-lf); return xf*width;
}

export function drawSpectrogram(canvas, spec, sampleRate){
  const ctx=canvas.getContext('2d'); const w=canvas.width, h=canvas.height; ctx.clearRect(0,0,w,h); if(!spec) return;
  const frames=spec.length; if(frames===0) return; const bins=spec[0].length;
  // Compute max safely without spread/flat to avoid large-arg issues
  let max=1e-12; for(let i=0;i<frames;i++){ const row=spec[i]; for(let k=0;k<bins;k++){ const v=row[k]; if(v>max) max=v; }}
  const img=ctx.createImageData(w,h);
  for(let x=0;x<w;x++){
    const fi=Math.min(frames-1, Math.floor(x/w*frames));
    const row=spec[fi];
    for(let y=0;y<h;y++){
      const bi=Math.min(bins-1, Math.floor((1-y/h)*(bins-1)));
      const v=row[bi]/(max||1e-6); const c=colorMap(v);
      const idx=(y*w+x)*4; img.data[idx]=c[0]; img.data[idx+1]=c[1]; img.data[idx+2]=c[2]; img.data[idx+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
}

function colorMap(v){ // viridis-like tiny map
  const r=Math.floor(255*Math.min(1, Math.max(0, 1.5*v)));
  const g=Math.floor(255*Math.min(1, Math.max(0, v)));
  const b=Math.floor(255*Math.min(1, Math.max(0, 1-0.7*v)));
  return [r,g,b];
}

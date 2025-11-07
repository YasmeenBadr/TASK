// Helper functions extracted from app.js to reduce its size

// Handles the potentially expensive backend request for spectrogram calculation.
export async function fetchSpectrogram(signal, sr, abortSignal){
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
  const resp=await fetch('/api/spectrogram',{method:'POST', body:form, signal: abortSignal});
  if(!resp.ok) return null;
  const data=await resp.json();
  return data.magnitudes.map(row=>Float32Array.from(row));
}

// Play a buffer using a provided AudioContext and sample rate; returns the created source node
export function playBuffer(signal, rate, audioCtx, sampleRate){
  const ctx = audioCtx;
  const buf = ctx.createBuffer(1, signal.length, sampleRate);
  buf.copyToChannel(signal, 0, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(ctx.destination);
  src.start();
  return src;
}

// Creates a Blob containing a raw 16-bit PCM, mono WAV file header and data.
export function encodeWavPCM16Mono(samples, sr){
  const numChannels=1; 
  const bytesPerSample=2; 
  const blockAlign=numChannels*bytesPerSample; 
  const byteRate=sr*blockAlign; 
  const dataLen=samples.length*bytesPerSample; 
  const buf=new ArrayBuffer(44+dataLen); 
  const view=new DataView(buf);

  function writeStr(off, s){ 
    for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); 
  }
  
  let off=0; 
  writeStr(off,'RIFF'); off+=4; 
  view.setUint32(off, 36+dataLen, true); off+=4; 
  writeStr(off,'WAVE'); off+=4; 
  writeStr(off,'fmt '); off+=4; 
  view.setUint32(off,16,true); off+=4; 
  view.setUint16(off,1,true); off+=2; 
  view.setUint16(off,numChannels,true); off+=2; 
  view.setUint32(off,sr,true); off+=4; 
  view.setUint32(off,byteRate,true); off+=4; 
  view.setUint16(off,blockAlign,true); off+=2; 
  view.setUint16(off,16,true); off+=2; 
  writeStr(off,'data'); off+=4; 
  view.setUint32(off,dataLen,true); off+=4;

  let idx=off; 
  for(let i=0;i<samples.length;i++){ 
    let s=Math.max(-1, Math.min(1, samples[i])); 
    view.setInt16(idx, s<0? s*0x8000 : s*0x7FFF, true); 
    idx+=2; 
  }
  
  return new Blob([buf], {type:'audio/wav'});
}

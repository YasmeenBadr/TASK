// Helper functions extracted from app.js to reduce its size

// -----------------------------
// Fetch spectrogram from server
// -----------------------------
export async function fetchSpectrogram(signal, sr, abortSignal){
  // Convert signal to WAV Blob for sending
  const blob=encodeWavPCM16Mono(signal, sr);

  // Choose a window size for STFT (largest power-of-two <= length, max 1024)
  const maxWin = Math.min(1024, signal.length);
  const pow = Math.floor(Math.log2(Math.max(2, maxWin)));
  const win = 1 << pow; // actual window size (power of 2)
  
  // Hop size (step between windows), usually 1/4 of window
  const hop = Math.max(1, Math.floor(win/4));

  // Prepare form data to send to server
  const form=new FormData();
  form.append('audio', blob, 'sig.wav'); // audio file
  form.append('win', String(win));       // window size
  form.append('hop', String(hop));       // hop size

  // Send request to server with optional abort signal
  const resp=await fetch('/api/spectrogram',{method:'POST', body:form, signal: abortSignal});

  // If server returns error, return null
  if(!resp.ok) return null;

  // Parse JSON data
  const data=await resp.json();

  // Convert each row to Float32Array for consistency in JS
  return data.magnitudes.map(row=>Float32Array.from(row));
}

// -----------------------------
// Play a Float32Array buffer
// -----------------------------
export function playBuffer(signal, rate, audioCtx, sampleRate){
  const ctx = audioCtx;

  // Create a mono AudioBuffer
  const buf = ctx.createBuffer(1, signal.length, sampleRate);

  // Copy signal data into the AudioBuffer channel
  buf.copyToChannel(signal, 0, 0);

  // Create a buffer source node to play the buffer
  const src = ctx.createBufferSource();
  src.buffer = buf;          // assign buffer
  src.playbackRate.value = rate; // set playback rate
  src.connect(ctx.destination);  // connect to speakers
  src.start();               // play immediately

  return src; // return source node in case we want to stop it later
}

// -----------------------------
// Encode Float32Array to WAV (16-bit PCM, mono)
// -----------------------------
export function encodeWavPCM16Mono(samples, sr){
  const numChannels=1; 
  const bytesPerSample=2; 
  const blockAlign=numChannels*bytesPerSample; 
  const byteRate=sr*blockAlign; 
  const dataLen=samples.length*bytesPerSample; 

  // Create ArrayBuffer with space for WAV header + data
  const buf=new ArrayBuffer(44+dataLen); 
  const view=new DataView(buf);

  // Helper to write ASCII string to DataView
  function writeStr(off, s){ 
    for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); 
  }

  // -----------------------------
  // WAV HEADER (44 bytes)
  // -----------------------------
  let off=0; 
  writeStr(off,'RIFF'); off+=4;                  // ChunkID
  view.setUint32(off, 36+dataLen, true); off+=4;// ChunkSize
  writeStr(off,'WAVE'); off+=4;                 // Format
  writeStr(off,'fmt '); off+=4;                 // Subchunk1ID
  view.setUint32(off,16,true); off+=4;          // Subchunk1Size (PCM)
  view.setUint16(off,1,true); off+=2;           // AudioFormat (1=PCM)
  view.setUint16(off,numChannels,true); off+=2; // NumChannels
  view.setUint32(off,sr,true); off+=4;          // SampleRate
  view.setUint32(off,byteRate,true); off+=4;    // ByteRate
  view.setUint16(off,blockAlign,true); off+=2;  // BlockAlign
  view.setUint16(off,16,true); off+=2;          // BitsPerSample
  writeStr(off,'data'); off+=4;                 // Subchunk2ID
  view.setUint32(off,dataLen,true); off+=4;     // Subchunk2Size

  // -----------------------------
  // Write audio samples
  // -----------------------------
  let idx=off; 
  for(let i=0;i<samples.length;i++){ 
    let s=Math.max(-1, Math.min(1, samples[i])); // clamp to [-1,1]
    view.setInt16(idx, s<0? s*0x8000 : s*0x7FFF, true); // convert to int16
    idx+=2; 
  }

  // Return as Blob (type audio/wav) ready to send or download
  return new Blob([buf], {type:'audio/wav'});
}

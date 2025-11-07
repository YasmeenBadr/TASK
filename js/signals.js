// Signal generation utilities extracted from app.js
// Generates a test signal based on mode and presetGroups
export function generateSignal(sampleRate, mode, presetGroups, durationSec = 5){
  const N = Math.max(1, Math.floor(durationSec * sampleRate));
  const signal = new Float32Array(N);

  if(mode !== 'generic' && presetGroups && presetGroups.length){
    const parts = [];
    presetGroups.forEach((g)=>{
      (g.windows||[]).forEach((w)=>{
        const center = Math.max(20, w.startHz + Math.max(0.0, w.widthHz) * 0.5);
        parts.push(center);
      });
    });
    const amp = 0.9/Math.max(1, parts.length);
    for(const f of parts){
      for(let n=0;n<N;n++){
        signal[n] += amp * Math.sin(2*Math.PI*f*n/sampleRate);
      }
    }
  } else {
    const tones = [120,440,880,1500,3000,6000,10000];
    const amp = 1/tones.length;
    for(const f of tones){
      for(let n=0;n<N;n++){
        signal[n] += amp * Math.sin(2*Math.PI*f*n/sampleRate);
      }
    }
  }

  // Normalize
  let max = 0;
  for(let n=0;n<N;n++){
    const a = Math.abs(signal[n]);
    if(a>max) max = a;
  }
  if(max>1e-6){
    for(let n=0;n<N;n++) signal[n] /= max;
  }
  return signal;
}

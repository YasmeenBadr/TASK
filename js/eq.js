// Equalizer band scheme
// Band: { startHz, widthHz, gain } with gain in [0,2]
export class EQScheme{
  constructor(sampleRate){this.sampleRate=sampleRate; this.bands=[]}
  addBand(startHz=100, widthHz=100, gain=1){this.bands.push({startHz, widthHz, gain})}
  removeBand(idx){this.bands.splice(idx,1)}
  toJSON(){return {sampleRate:this.sampleRate, bands:this.bands}}
  static fromJSON(obj){const s=new EQScheme(obj.sampleRate); s.bands=obj.bands||[]; return s}
}

export function renderBands(bandsDiv, scheme, presetGroups){
  bandsDiv.innerHTML='';
  if(presetGroups && presetGroups.length){
    presetGroups.forEach((g,idx)=>{
      const div=document.createElement('div');
      div.className='band';
      div.innerHTML=`<strong style="grid-column: span 1; color:#e5e7eb">${g.label||('Group '+(idx+1))}</strong>
      <label style="grid-column: span 5;">Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${g.gain??1}"></label>
      <span class="gainVal">${(g.gain??1).toFixed(2)}x</span>`;
      const gainR = div.querySelector('input');
      const span=div.querySelector('.gainVal');
      gainR.addEventListener('input',()=>{g.gain=+gainR.value; span.textContent=`${g.gain.toFixed(2)}x`;});
      bandsDiv.appendChild(div);
    });
    return;
  }
  scheme.bands.forEach((b,idx)=>{
    const div=document.createElement('div');
    div.className='band';
    div.innerHTML=`<label>Start Hz<input type="number" step="1" value="${b.startHz}"></label>
    <label>Width Hz<input type="number" step="1" value="${b.widthHz}"></label>
    <label>Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${b.gain}"></label>
    <span class="gainVal">${b.gain.toFixed(2)}x</span>
    <button class="remove">Remove</button>`;
    const [startL,widthL,gainR,span,btn] = div.querySelectorAll('input,span,button');
    startL.addEventListener('input',()=>{b.startHz=+startL.value;});
    widthL.addEventListener('input',()=>{b.widthHz=+widthL.value;});
    gainR.addEventListener('input',()=>{b.gain=+gainR.value; span.textContent=`${b.gain.toFixed(2)}x`;});
    btn.addEventListener('click',()=>{scheme.removeBand(idx); renderBands(bandsDiv, scheme, presetGroups);});
    bandsDiv.appendChild(div);
  });
}

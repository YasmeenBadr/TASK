// Equalizer band scheme
// Band: { startHz, widthHz, gain } with gain in [0,2]
export class EQScheme{
  constructor(sampleRate){this.sampleRate=sampleRate; this.bands=[]}
  addBand(startHz=100, widthHz=100, gain=1){this.bands.push({startHz, widthHz, gain})}
  removeBand(idx){this.bands.splice(idx,1)}
  toJSON(){return {sampleRate:this.sampleRate, bands:this.bands}}
  static fromJSON(obj){const s=new EQScheme(obj.sampleRate); s.bands=obj.bands||[]; return s}
}

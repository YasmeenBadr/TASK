// ///////////////////////////////////////////////////////////////////////////////
// Equalizer band scheme
// Band: { startHz, widthHz, gain } with gain in [0,2]
// The EQScheme class is a simple data model to hold the equalizer configuration.
// It is independent of the UI rendering.
// ///////////////////////////////////////////////////////////////////////////////
export class EQScheme{
  // Constructor for the EQScheme class.
  constructor(sampleRate){
    this.sampleRate = sampleRate; // Stores the audio sample rate (e.g., 44100), crucial for Nyquist frequency calculation.
    this.bands = [];            // An array to hold the individual frequency band objects.
  }

  // Method to add a new frequency band with optional default values.
  addBand(startHz=100, endHz=1000, gain=1){
    // Pushes a new band object { startHz, endHz, gain } to the bands array.
    // Ensure endHz is always greater than startHz
    endHz = Math.max(startHz + 1, endHz);
    this.bands.push({startHz, endHz, gain});
  }

  // Method to remove a band at a specific index.
  removeBand(idx){
    // Uses Array.prototype.splice() to remove 1 element starting at index 'idx'.
    this.bands.splice(idx,1);
  }

  // Method to serialize the scheme into a plain JavaScript object for saving (e.g., JSON).
  toJSON(){
    // Convert back to width for backward compatibility
    const bands = this.bands.map(b => ({
      startHz: b.startHz,
      widthHz: b.endHz - b.startHz,
      gain: b.gain
    }));
    return {sampleRate: this.sampleRate, bands};
  }

  // Static method to create an EQScheme instance from a serialized object.
  static fromJSON(obj){
    // Creates a new EQScheme instance using the sampleRate from the object.
    const s = new EQScheme(obj.sampleRate);
    // Convert width-based bands to end-based bands
    s.bands = (obj.bands || []).map(b => ({
      startHz: b.startHz,
      endHz: b.startHz + b.widthHz,
      gain: b.gain
    }));
    return s;
  }
}


// ///////////////////////////////////////////////////////////////////////////////
// Function to render the UI controls (sliders and buttons) for the EQ scheme.
// It supports two modes: individual bands (default) or preset groups.
// ///////////////////////////////////////////////////////////////////////////////
export function renderBands(bandsDiv, scheme, presetGroups){
  // Clear any existing content in the container div before rendering new controls.
  bandsDiv.innerHTML='';

  // --- 1. PRESET GROUPS MODE ---
  // If presetGroups are provided and not empty, render simplified group controls.
  if(presetGroups && presetGroups.length){
    // Iterate over each preset group object.
    presetGroups.forEach((g,idx)=>{
      const div=document.createElement('div');
      div.className='band';
      // Insert the HTML structure for a single preset group control (label + single gain slider).
      // g.gain??1 uses nullish coalescing to default gain to 1.
      div.innerHTML=`
  <strong style="grid-column: span 4; color:#e5e7eb; font-size: 0.95rem;">${g.label||('Group '+(idx+1))}</strong>
  <label style="grid-column: span 3; display: flex; flex-direction: column; gap: 0.25rem;">
    <span style="color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;">GAIN 0-2</span>
    <input type="range" min="0" max="2" step="0.01" value="${g.gain??1}">
  </label>
  <span class="gainVal" style="grid-column: span 1; text-align: center; font-size: 0.9rem; min-width: 3rem;">${(g.gain??1).toFixed(2)}x</span>`;

      const gainR = div.querySelector('input'); // Get the gain range input.
      const span=div.querySelector('.gainVal'); // Get the gain display span.

      // Add event listener for the gain slider.
      gainR.addEventListener('input',()=>{
        // Update the gain value in the preset group object. The unary '+' converts the string value to a number.
        g.gain=+gainR.value;
        // Update the displayed gain value, formatted to two decimal places.
        span.textContent=`${g.gain.toFixed(2)}x`;
      });

      bandsDiv.appendChild(div); // Add the control to the container.
    });
    return; // Exit the function, skipping the individual band rendering.
  }


  // --- 2. INDIVIDUAL BANDS MODE ---
  // If no preset groups, iterate over each band in the EQ scheme.
  scheme.bands.forEach((b,idx)=>{
    const div=document.createElement('div');
    div.className='band';
    // Insert the HTML structure for a single detailed band control (3 sliders + 1 button).
    div.innerHTML=`<label>Start Hz<input type="range" min="0" step="1" value="${b.startHz}" class="start-slider"></label>
    <span class="startVal">${b.startHz} Hz</span>
    <label>End Hz<input type="range" min="0" step="1" value="${b.endHz}" class="end-slider"></label>
    <span class="endVal">${b.endHz} Hz</span>
    <label>Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${b.gain}" class="gain-slider"></label>
    <span class="gainVal">${b.gain.toFixed(2)}x</span>
    <button class="remove">Remove</button>`;

     // Select all inputs in the current band div
    const startR = div.querySelector('.start-slider');
    const endR = div.querySelector('.end-slider');
    const gainR = div.querySelector('.gain-slider');
    
    // Select the display spans for value feedback
    const spanStart = div.querySelector('.startVal');
    const spanEnd = div.querySelector('.endVal');
    const spanGain = div.querySelector('.gainVal');

    // Set dynamic ranges based on Nyquist frequency (half the sample rate)
    const nyq = Math.max(1, Math.floor((scheme.sampleRate||44100)/2));
    
    // Set initial slider ranges
    startR.max = String(nyq - 1);
    endR.min = String(1);
    endR.max = String(nyq);
    
    // Ensure end is always greater than start
    const updateSliderRanges = () => {
      // Ensure start is at least 1 less than end
      startR.max = Math.min(nyq - 1, +endR.value - 1);
      // Ensure end is at least 1 more than start
      endR.min = Math.max(1, +startR.value + 1);
    };
    
    // Initialize slider positions
    startR.value = b.startHz;
    endR.value = b.endHz;
    updateSliderRanges();

    // --- Event Handlers ---
    
    // Handler for the Start Hz slider
    startR.addEventListener('input', () => {
      // Update the scheme object and display span
      b.startHz = +startR.value;
      spanStart.textContent = `${b.startHz} Hz`;
      
      // Update end slider min and start slider max
      updateSliderRanges();
      
      // If end is now less than start, update it
      if (b.endHz <= b.startHz) {
        b.endHz = b.startHz + 1;
        endR.value = b.endHz;
        spanEnd.textContent = `${b.endHz} Hz`;
      }
    });

    // Handler for the End Hz slider
    endR.addEventListener('input', () => {
      // Update the scheme object and display span
      b.endHz = +endR.value;
      spanEnd.textContent = `${b.endHz} Hz`;
      
      // Update start slider max and end slider min
      updateSliderRanges();
      
      // If start is now greater than end, update it
      if (b.startHz >= b.endHz) {
        b.startHz = Math.max(0, b.endHz - 1);
        startR.value = b.startHz;
        spanStart.textContent = `${b.startHz} Hz`;
      }
    });

    // Handler for the Gain slider.
    gainR.addEventListener('input',()=>{
      // Update the scheme object and display span, formatting to two decimals.
      b.gain=+gainR.value; 
      spanGain.textContent=`${b.gain.toFixed(2)}x`;
    });

    // Handler for the Remove button.
    const btn = div.querySelector('button');
    btn.addEventListener('click',()=>{
      // 1. Remove the band from the underlying data model.
      scheme.removeBand(idx); 
      // 2. Re-render all bands to refresh the UI and correct indices.
      renderBands(bandsDiv, scheme, presetGroups);
    });
    
    bandsDiv.appendChild(div); // Add the final control div to the container.
  });
}
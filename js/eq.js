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
  addBand(startHz=100, widthHz=100, gain=1){
    // Pushes a new band object { startHz, widthHz, gain } to the bands array.
    this.bands.push({startHz, widthHz, gain});
  }

  // Method to remove a band at a specific index.
  removeBand(idx){
    // Uses Array.prototype.splice() to remove 1 element starting at index 'idx'.
    this.bands.splice(idx,1);
  }

  // Method to serialize the scheme into a plain JavaScript object for saving (e.g., JSON).
  toJSON(){
    return {sampleRate:this.sampleRate, bands:this.bands};
  }

  // Static method to create an EQScheme instance from a serialized object.
  static fromJSON(obj){
    // Creates a new EQScheme instance using the sampleRate from the object.
    const s=new EQScheme(obj.sampleRate);
    // Assigns the bands array, defaulting to an empty array if obj.bands is null/undefined.
    s.bands=obj.bands||[];
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
      div.innerHTML=`<strong style="grid-column: span 1; color:#e5e7eb">${g.label||('Group '+(idx+1))}</strong>
      <label style="grid-column: span 5;">Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${g.gain??1}"></label>
      <span class="gainVal">${(g.gain??1).toFixed(2)}x</span>`;

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
    div.innerHTML=`<label>Start Hz<input type="range" min="0" step="1" value="${b.startHz}"></label>
    <span class="startVal">${b.startHz} Hz</span>
    <label>Width Hz<input type="range" min="1" step="1" value="${b.widthHz}"></label>
    <span class="widthVal">${b.widthHz} Hz</span>
    <label>Gain 0-2<input type="range" min="0" max="2" step="0.01" value="${b.gain}"></label>
    <span class="gainVal">${b.gain.toFixed(2)}x</span>
    <button class="remove">Remove</button>`;

    // Select all inputs in the current band div.
    const inputs = div.querySelectorAll('input');
    // Use array destructuring to easily assign the three inputs to separate variables.
    const [startR,widthR,gainR] = inputs;
    
    // Select the display spans for value feedback.
    const spanStart = div.querySelector('.startVal');
    const spanWidth = div.querySelector('.widthVal');
    const spanGain = div.querySelector('.gainVal');

    // Set dynamic ranges based on Nyquist frequency (half the sample rate).
    // The Nyquist frequency is the theoretical maximum frequency a digital audio system can represent.
    const nyq = Math.max(1, Math.floor((scheme.sampleRate||44100)/2));
    // The start frequency of the band cannot exceed the Nyquist frequency.
    startR.max = String(nyq);
    
    // Helper function to dynamically update the maximum width.
    // Width cannot exceed the remaining space up to the Nyquist frequency (StartHz + WidthHz <= Nyquist).
    const updateWidthMax = ()=>{ 
      // Max width is Nyquist minus the current start frequency, ensuring it's at least 1.
      widthR.max = String(Math.max(1, nyq - (+startR.value))); 
    };
    
    updateWidthMax(); // Call once to set the initial max width based on the band's initial startHz.

    // --- Event Handlers ---
    
    // Handler for the Start Hz slider.
    startR.addEventListener('input',()=>{
      // Update the scheme object and display span.
      b.startHz = +startR.value;
      spanStart.textContent = `${b.startHz} Hz`;
      
      // Recalculate the max width based on the new start frequency.
      updateWidthMax();
      
      // If the current width now exceeds the new maximum allowed width,
      // automatically clamp the width value and update the scheme/display.
      if(+widthR.value > +widthR.max){ 
        widthR.value = widthR.max; 
      }
      b.widthHz = +widthR.value;
      spanWidth.textContent = `${b.widthHz} Hz`;
    });

    // Handler for the Width Hz slider.
    widthR.addEventListener('input',()=>{
      // Update the scheme object and display span.
      b.widthHz = +widthR.value;
      spanWidth.textContent = `${b.widthHz} Hz`;
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
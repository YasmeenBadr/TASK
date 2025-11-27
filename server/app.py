from flask import Flask, request, jsonify, send_file, send_from_directory, Response
from pathlib import Path
import io
import wave
import json
import numpy as np
# Import custom DSP functions from dsp.py
from dsp import stft, istft, EQScheme, make_modifier_from_scheme, clamp_signal, next_pow2, fft
import subprocess, os # For running external commands (Demucs CLI)
import tempfile   # For creating temporary files for Demucs processing
import shutil # For directory operations (cleaning up Demucs output)
import base64   # For encoding audio data to send to frontend
import time   # For measuring processing time
import warnings

# Silence SpeechBrain's internal deprecation warnings
warnings.filterwarnings("ignore", message="Module 'speechbrain.pretrained' was deprecated")

# Initialize voice separator with error handling
try:
    from voice_separation import VoiceSeparator
    voice_separator = VoiceSeparator(model_name="speechbrain/sepformer-wham")
    VOICE_SEPARATOR_AVAILABLE = True
    print("[OK] Voice separator initialized successfully")
except ImportError as e:
    print(f"[WARNING] Voice separation not available: {e}")
    print("To enable voice separation, run: pip install speechbrain torch torchaudio")
    voice_separator = None
    VOICE_SEPARATOR_AVAILABLE = False
except Exception as e:
    print(f"[ERROR] Error initializing voice separator: {e}")
    voice_separator = None
    VOICE_SEPARATOR_AVAILABLE = False

# ============================================================================
# FLASK APP SETUP
# ============================================================================

# BASE_DIR points to the parent directory (where index.html, js/, style.css live)
BASE_DIR = Path(__file__).resolve().parents[1]
# Initialize Flask with static file serving from BASE_DIR
app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')


# ============================================================================
# DEMUCS TEMPORARY DIRECTORIES
# ============================================================================

# Demucs requires temporary storage for input files and separated stems
UPLOAD_FOLDER = tempfile.gettempdir()
OUTPUT_FOLDER = os.path.join(UPLOAD_FOLDER, "demucs_output")
os.makedirs(OUTPUT_FOLDER, exist_ok=True)


# ============================================================================
# CORS (Cross-Origin Resource Sharing)  HEADERS FOR CROSS-ORIGIN REQUESTS
# ============================================================================

@app.after_request
def add_cors(resp):
    """
    Add CORS  headers to all responses.
    This allows the frontend (which might be served from a different port during dev)
    to communicate with this backend API.
    
    Headers added:
    - Access-Control-Allow-Origin: * (allow requests from any origin)
    - Access-Control-Allow-Headers: Content-Type (allow Content-Type header)
    - Access-Control-Allow-Methods: GET,POST,OPTIONS (allowed HTTP methods)
    """
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    return resp

# ============================================================================
# BASIC ROUTES - SERVING STATIC FILES
# ============================================================================


@app.route('/api/health')
def health():
    """
    Health check endpoint - returns simple status to verify server is running.
    Used by frontend or monitoring tools to check if the backend is alive.
    """
    return jsonify({"status": "ok"})

@app.route('/')
def root():
    """
    Serve the main HTML page (index.html from BASE_DIR).
    This is the entry point for the web application UI.
    
    """
    return send_file(str(BASE_DIR / 'index.html'))


@app.route('/favicon.ico')
def favicon():
    """
    Handle favicon requests gracefully by returning empty response.
    This prevents 404 errors in browser console.
    """
    return ('', 204) # 204 = No Content

@app.route('/js/<path:filename>')
def serve_js(filename):
    """
    Serve JavaScript files from the js/ directory.
    
    """
    return send_from_directory(str(BASE_DIR / 'js'), filename)

@app.route('/style.css')
def serve_css():
    """
    Serve the main CSS stylesheet for the application.
    
    """
    return send_file(str(BASE_DIR / 'style.css'))

@app.route('/presets.json')
def serve_presets():
    """
    Serve the presets configuration file.
 
    """
    return send_file(str(BASE_DIR / 'presets.json'))

@app.route('/<path:filepath>')
def serve_any(filepath):
    """
    Generic file server for any other static files.
    Returns 404 if file doesn't exist.
    """
    target = BASE_DIR / filepath
    if target.exists() and target.is_file():
        return send_from_directory(str(target.parent), target.name)
    return jsonify({"error": "Not Found"}), 404

# ============================================================================
# MAIN AUDIO PROCESSING ENDPOINT - FREQUENCY-BASED EQUALIZATION
# ============================================================================

@app.route('/api/process', methods=['POST', 'OPTIONS'])
def process_audio():
    """
    Process audio with dynamic equalization based on the provided frequency bands.
    This endpoint applies a multi-band equalizer to the input audio and returns the processed audio.
    """
    print('[process] start')
    
    # Handle CORS preflight request
    if request.method == 'OPTIONS':
        return ('', 204)  # No content response for preflight
    
    try:
        # Check if audio file is present in the request
        if 'audio' not in request.files:
            return jsonify({"error": "missing 'audio' file"}), 400
        
        # Get the equalization scheme from form data
        scheme_json = request.form.get('scheme')
        if not scheme_json:
            return jsonify({"error": "missing 'scheme' json"}), 400
        
        # Parse the JSON scheme containing frequency bands
        try:
            scheme_obj = json.loads(scheme_json)
        except Exception as e:
            return jsonify({"error": f"invalid scheme json: {e}"}), 400

        # Read and parse the WAV file
        wav_file = request.files['audio']
        data = wav_file.read()
        
        # Extract WAV file properties
        with wave.open(io.BytesIO(data), 'rb') as wf:
            nchan = wf.getnchannels()  # Number of channels (1 for mono, 2 for stereo)
            sampwidth = wf.getsampwidth()  # Sample width in bytes
            framerate = wf.getframerate()  # Sample rate in Hz
            nframes = wf.getnframes()  # Total number of frames
            frames = wf.readframes(nframes)  # Raw audio data
            
        # Only support 16-bit PCM audio (2 bytes per sample)
        if sampwidth != 2:
            return jsonify({"error": "only 16-bit PCM supported"}), 400

        # Convert raw bytes to a list of integers (16-bit samples)
        import struct
        total_samples = len(frames) // 2  # Each sample is 2 bytes
        # Unpack little-endian 16-bit integers
        samples = struct.unpack('<' + 'h' * total_samples, frames)
        
        # Convert stereo to mono by taking every other sample if stereo
        if nchan > 1:
            samples = samples[::nchan]
            
        # Normalize samples to float32 range [-1.0, 1.0]
        sig = [s / 32768.0 for s in samples]

        # Process the equalization bands from the scheme
        bands_in = scheme_obj.get('bands', [])
        print(f"[process] bands received: {len(bands_in)}")
        
        # Create an EQ scheme with the audio's sample rate
        scheme = EQScheme(framerate)
        
        # Add each frequency band to the EQ scheme
        for b in bands_in:
            # Each band has start frequency, width, and gain
            scheme.add_band(
                b.get('startHz', 0),     # Start frequency in Hz
                b.get('widthHz', 0),     # Bandwidth in Hz
                b.get('gain', 1.0)       # Gain multiplier
            )

        # Apply Short-Time Fourier Transform (STFT) to the signal
        # win=1024: FFT window size, hop=256: hop size between windows
        S = stft(sig, win=1024, hop=256)
        
        # Create a frequency-domain modifier from the EQ scheme
        modifier = make_modifier_from_scheme(scheme)
        
        # Apply the modifier and convert back to time domain
        out = istft(modifier, S, out_len=len(sig))
        
        # Ensure the output is within valid range
        out = clamp_signal(out)

        # Convert the processed float samples back to 16-bit integers
        out_int16 = bytearray()
        for v in out:
            # Clamp to [-1.0, 1.0] and scale to 16-bit range
            iv = int(max(-1.0, min(1.0, v)) * 32767.0)
            # Convert to little-endian bytes and add to buffer
            out_int16 += int(iv).to_bytes(2, byteorder='little', signed=True)
            
        # Create an in-memory WAV file
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)         # Mono output
            wf.setsampwidth(2)         # 16-bit samples
            wf.setframerate(framerate)  # Original sample rate
            wf.writeframes(bytes(out_int16))  # Write the processed audio data
            
        # Prepare the response
        buf.seek(0)
        data_bytes = buf.getvalue()
        print(f'[process] done bytes={len(data_bytes)}')
        
        # Return the processed audio as a WAV file
        return Response(data_bytes, mimetype='audio/wav')
        
    except Exception as e:
        # Handle any errors during processing
        print('[process] error', e)
        return jsonify({"error": str(e)}), 500

def _read_wav_to_mono_float(data_bytes):
    """
    Parse WAV file bytes and convert to mono float array.
    
    USED BY:
    - spectrum() endpoint
    - spectrogram() endpoint
    
    PROCESS:
    1. Parse WAV headers and data using wave module
    2. Convert 16-bit PCM to float array normalized to [-1, 1]
    3. If stereo, extract only left channel
    
    Returns:
        tuple: (sample_rate, signal_array)
        - sample_rate: int (e.g., 44100)
        - signal_array: numpy array of float64 in range [-1, 1]
    
    Raises:
        ValueError: If audio is not 16-bit PCM
    """
    import struct
    
    # Parse WAV file
    with wave.open(io.BytesIO(data_bytes), 'rb') as wf:
        nchan = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        nframes = wf.getnframes()
        frames = wf.readframes(nframes)
    
    # Only support 16-bit PCM
    if sampwidth != 2:
        raise ValueError('only 16-bit PCM supported')
    
    # Unpack bytes to 16-bit signed integers
    total_samples = len(frames) // 2
    samples = struct.unpack('<' + 'h' * total_samples, frames)
    
    # Extract left channel if stereo
    if nchan > 1:
        samples = samples[::nchan]
    
    # Convert to float array normalized to [-1, 1]
    sig = np.asarray(samples, dtype=np.float64) / 32768.0
    return framerate, sig

# ============================================================================
# SPECTRUM ANALYSIS ENDPOINT
# ============================================================================



@app.route('/api/spectrum', methods=['POST', 'OPTIONS'])
def spectrum():
    """
    Compute frequency spectrum (single FFT) of uploaded audio.
    
    PURPOSE:
    - Generate frequency domain view for the frequency canvas visualizations
    - Shows magnitude at each frequency bin (0 Hz to Nyquist frequency)
    
    CALLED BY:
    - app.js: updateFreqView() function 
    - Called whenever input/output signal changes to update frequency displays
    - Can display in linear or audiogram scale (toggled by scaleSelect)
    
    VISUALIZED BY:
    - viewers.js: drawSpectrum() function
    - Draws the spectrum on freqInCanvas or freqOutCanvas
    
    USES:
    - dsp.py: next_pow2(), fft() 
    - Custom FFT implementation (no numpy.fft or scipy.fft)
    
    WORKFLOW:
    1. Receive audio file
    2. Convert to mono float array
    3. Pad to power-of-2 length (required for radix-2 FFT)
    4. Apply FFT to get frequency components
    5. Compute magnitudes from real and imaginary parts
    6. Return first half (positive frequencies only, up to Nyquist)
    
    REQUEST:
    - Method: POST
    - Form data: audio (WAV file)
    
    RESPONSE:
    {
      "sampleRate": 44100,
      "N": 32768,                    // FFT size (power of 2)
      "magnitudes": [0.1, 0.5, ...]  // Array of N/2 magnitude values
    }
    
    FREQUENCY MAPPING:
    - magnitudes[i] represents frequency: i * (sampleRate / N)
    - Example: If N=32768 and sr=44100, then:
      * magnitudes[0] = 0 Hz (DC component)
      * magnitudes[100] = 100 * (44100/32768) ≈ 134.6 Hz
      * magnitudes[N/2-1] = Nyquist frequency (22050 Hz)
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    
    # Validate input
    if 'audio' not in request.files:
        return jsonify({"error": "missing 'audio' file"}), 400
    
    # Read and convert audio to mono float
    try:
        sr, sig = _read_wav_to_mono_float(request.files['audio'].read())
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    
    # ========================================================================
    # COMPUTE FFT
    # ========================================================================
    # Find next power of 2 for efficient FFT (max 2^15 = 32768 samples)
    N = next_pow2(min(len(sig), 1<<15))
    
    # Allocate zero-padded arrays for FFT
    re = np.zeros(N, dtype=np.float64)  # Real part
    im = np.zeros(N, dtype=np.float64)  # Imaginary part
    
    # Copy signal into real part (imaginary starts at zero)
    re[:min(N, len(sig))] = sig[:min(N, len(sig))]
    
    # Apply custom FFT (modifies re and im in-place)
    # After FFT:
    # - re[k] + j*im[k] represents frequency k * (sr/N)
    # - First half (0 to N/2) = positive frequencies
    # - Second half (N/2 to N) = negative frequencies (mirror of positive)
    fft(re, im)
    
    # Compute magnitudes: sqrt(real^2 + imag^2)
    # Only return positive frequencies (first N/2 bins)
    mags = (re[:N//2]**2 + im[:N//2]**2)**0.5
    
    return jsonify({
        "sampleRate": sr,
        "N": int(N),
        "magnitudes": mags.tolist()  # Convert numpy array to list for JSON
    })


@app.route('/api/spectrogram', methods=['POST', 'OPTIONS'])
def spectrogram():
    """
    Compute spectrogram (time-varying spectrum) of uploaded audio.
    
    PURPOSE:
    - Generate 2D time-frequency representation
    - Shows how frequency content changes over time
    - Useful for visualizing music structure, speech patterns, etc.
    
    CALLED BY:
    - app.js: updateSpecs() → fetchSpectrogram() 
    - helpers.js: fetchSpectrogram() helper (helper code provided)
    - Only called when toggleSpecGlobal is checked (spectrograms visible)
    
    VISUALIZED BY:
    - viewers.js: drawSpectrogram() function 
    - Draws color-mapped time-frequency plot on canvas
    
    USES:
    - dsp.py: stft() function 
    - Custom STFT with Hann windowing
    
    WORKFLOW:
    1. Receive audio file + window/hop parameters
    2. Convert to mono float array
    3. Apply STFT with sliding windows
    4. Compute magnitude for each time-frequency bin
    5. Return 2D array of magnitudes
    
    REQUEST:
    - Method: POST
    - Form data:
        * audio: WAV file
        * win: Window size (default 1024) - affects frequency resolution
        * hop: Hop size (default 256) - affects time resolution
    
    RESPONSE:
    {
      "sampleRate": 44100,
      "N": 1024,                       // Window size
      "hop": 256,                      // Hop size between windows
      "magnitudes": [                  // 2D array: [time][frequency]
        [0.1, 0.3, ...],              // Frame 0 magnitudes (N/2 values)
        [0.2, 0.4, ...],              // Frame 1 magnitudes
        ...
      ]
    }
    
    TIME-FREQUENCY MAPPING:
    - magnitudes[frame][bin] represents:
      * Time: frame * (hop / sampleRate) seconds
      * Frequency: bin * (sampleRate / N) Hz
    - Example: If hop=256, sr=44100, N=1024:
      * Frame 10 → time = 10 * (256/44100) ≈ 0.058 seconds
      * Bin 100 → frequency = 100 * (44100/1024) ≈ 4307 Hz
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    
    # Validate input
    if 'audio' not in request.files:
        return jsonify({"error": "missing 'audio' file"}), 400
    
    # Read audio
    try:
        sr, sig = _read_wav_to_mono_float(request.files['audio'].read())
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    
    # Get STFT parameters from request (with defaults)
    win = int(request.form.get('win', 1024))  # Window size
    hop = int(request.form.get('hop', 256))   # Hop size
    
    # ========================================================================
    # COMPUTE STFT
    # ========================================================================
    # Apply Short-Time Fourier Transform
    # Returns dict with 'reals', 'imags', 'N', 'hop', 'frames'
    S = stft(sig.tolist(), win=win, hop=hop)
    
    # Compute magnitudes for each time-frequency bin
    mags = []
    for i in range(len(S['reals'])):
        # Get real and imaginary parts for this time frame
        re = np.asarray(S['reals'][i])
        im = np.asarray(S['imags'][i])
        
        # Compute magnitude: sqrt(real^2 + imag^2)
        # Only use positive frequencies (first N/2 bins)
        m = np.sqrt(re[:S['N']//2]**2 + im[:S['N']//2]**2)
        mags.append(m.tolist())
    
    return jsonify({
        "sampleRate": sr,
        "N": int(S['N']),
        "hop": int(S['hop']),
        "magnitudes": mags  # 2D list: [time_frames][frequency_bins]
    })


# ============================================================================
# PRESET CONFIGURATIONS - EQ MODES
# ============================================================================
# These presets define specialized EQ controls for different audio types.
# Each mode has labeled sliders that control specific frequency windows.
#
# RELATIONSHIP TO FRONTEND:
# - app.js loads these via fetch('./presets.json') (document 3, line ~400)
# - eq.js renders sliders based on preset structure (document 4)
# - Each slider can control multiple frequency windows simultaneously
#
# PRESET STRUCTURE:
# {
#   "mode_name": {
#     "sliders": [
#       {
#         "label": "Display name",
#         "windows": [
#           {"startHz": freq, "widthHz": bandwidth},
#           ...  // Multiple windows per slider allowed
#         ]
#       },
#       ...
#     ]
#   }
# }

PRESETS = {
    # ========================================================================
    # MUSIC MODE - Separate musical elements by frequency ranges
    # ========================================================================
    "music": {
        "sliders": [
            {
                "label": "Sub Bass",
                "windows": [
                    {"startHz": 40, "widthHz": 60}
                ]
                # Covers 40-100 Hz: deep bass, kick drum fundamentals
            },
            {
                "label": "Kick/Drums", 
                "windows": [
                    {"startHz": 80, "widthHz": 420}
                ]
                # Covers 80-500 Hz: kick drum body, snare, toms
            },
            {
                "label": "Vocals",
                "windows": [
                    {"startHz": 500, "widthHz": 3000}
                ]
                # Covers 500-3500 Hz: human voice fundamental + harmonics
            },
            {
                "label": "Other Instruments",
                "windows": [
                    {"startHz": 4000, "widthHz": 6000}
                ]
                # Covers 4000-10000 Hz: cymbals, strings, brightness
            }
        ]
    },
    
    # ========================================================================
    # ANIMALS MODE - Separate animal sounds by characteristic frequencies
    # ========================================================================
    "animals": {
        "sliders": [
            {
                "label": "Dog",
                "windows": [
                    {"startHz": 0, "widthHz": 450}
                ]
                # Dog barks: typically 200-500 Hz with lower harmonics
            },
            {
                "label": "Wolf",
                "windows": [
                    {"startHz": 450, "widthHz": 650}
                ]
                # Wolf howls: 400-1200 Hz range
            },
            {
                "label": "Crow",
                "windows": [
                    {"startHz": 1100, "widthHz": 1900}
                ]
                # Crow caws: 1000-3000 Hz harsh harmonics
            },
            {
                "label": "Bat",
                "windows": [
                    {"startHz": 3000, "widthHz": 6000}
                ]
                # Bat echolocation: ultrasonic, 3-9 kHz (within human hearing)
            }
        ]
    },
    
    # ========================================================================
    # VOICES MODE - Separate human voices by pitch characteristics
    # ========================================================================
    # Each voice type has 3 windows targeting:
    # 1. Fundamental frequency (pitch)
    # 2. First formant (vowel quality)
    # 3. Second formant (voice character)
    "voices": {
        "sliders": [
            {
                "label": "Male (Deep)",
                "windows": [
                    {"startHz": 414.6, "widthHz": 100},  # Fundamental ~400-520 Hz
                    {"startHz": 248.6, "widthHz": 200},  # First formant
                    {"startHz": 500, "widthHz": 400}     # Second formant
                ]
                # Deep male voice: lower fundamental, darker formants
            },
            {
                "label": "Female (High)",
                "windows": [
                    {"startHz": 162.2, "widthHz": 100},  # Fundamental ~160-260 Hz
                    {"startHz": 200, "widthHz": 200},    # First formant
                    {"startHz": 500, "widthHz": 400}     # Second formant
                ]
                # Female voice: higher fundamental, brighter formants
            },
            {
                "label": "Male (Mid)",
                "windows": [
                    {"startHz": 50, "widthHz": 100},     # Fundamental ~50-150 Hz
                    {"startHz": 332.0, "widthHz": 200},  # First formant
                    {"startHz": 500, "widthHz": 400}     # Second formant
                ]
                # Mid-range male voice
            },
            {
                "label": "Child/Young",
                "windows": [
                    {"startHz": 638.2, "widthHz": 100},  # Fundamental ~640-740 Hz
                    {"startHz": 561.0, "widthHz": 200},  # First formant
                    {"startHz": 519.8, "widthHz": 400}   # Second formant
                ]
                # Child voice: much higher fundamental frequency
            }
        ]
    }
}

# ============================================================================
# PRESET API ENDPOINTS
# ============================================================================

@app.route('/api/presets')
def presets():
    """
    Get preset configuration for a specific mode.
    
    CALLED BY:
    - app.js: modeSelect change event 
    - Called when user switches between Generic/Music/Animals/Voices modes
    
    USED BY:
    - eq.js: renderBands() to create slider controls 
    - Each preset's sliders are rendered with their specific labels
    
    REQUEST:
    - Method: GET
    - Query param: mode (e.g., 'music', 'animals', 'voices')
    
    
    ERROR RESPONSE:
    {"error": "unknown mode"} with status 400
    """
    mode = request.args.get('mode', 'music')  # Default to music mode
    p = PRESETS.get(mode)
    
    if not p:
        return jsonify({"error": "unknown mode"}), 400
    
    return jsonify(p)


@app.route('/api/modes')
def modes():
    """
    Get list of all available preset modes.
    
    CALLED BY:
    - Frontend initialization (if needed for dynamic mode selection)
    
    RESPONSE:
    {"modes": ["music", "animals", "voices"]}
    
    NOTE: Currently the mode list is hardcoded in the HTML <select> element,
    but this endpoint allows for dynamic mode discovery.
    """
    return jsonify({"modes": list(PRESETS.keys())})
# ============================================================================
# DEMUCS API ENDPOINTS - 4 STEMS VERSION
# ============================================================================

@app.route('/api/demucs_check', methods=['GET'])
def check_demucs():
    """
    Check if Demucs CLI is installed and available.
    
    CALLED BY:
    - app.js: checkDemucsAvailability() on page load 
    - Used to enable/disable AI separation button
    
    PROCESS:
    - Runs 'demucs --help' command with 5-second timeout
    - If command succeeds (returncode 0), Demucs is available
    
    RESPONSE:
    {
      "available": true/false,
      "error": "error message if failed"
    }
    """
    try:
        # Try to run demucs --help to verify installation
        result = subprocess.run(
            ['demucs', '--help'],
            capture_output=True,  # Capture stdout/stderr
            timeout=5             # Don't wait forever
        )
        available = result.returncode == 0
        return jsonify({"available": available})
    except Exception as e:
        print(f"Demucs check failed: {e}")
        return jsonify({"available": False, "error": str(e)})


@app.route('/api/demucs', methods=['POST', 'OPTIONS'])
def run_demucs():
    """
    Run Demucs AI model to separate music into 4 stems.
    
    WORKFLOW:
    1. Save uploaded audio to temp file
    2. Run Demucs CLI: 'demucs -n htdemucs -o OUTPUT_FOLDER input.wav'
    3. Demucs creates: OUTPUT_FOLDER/htdemucs/input_name/
       - drums.wav
       - bass.wav
       - vocals.wav
       - other.wav
    4. Read each stem, encode as base64, send to frontend
    5. Frontend can play stems individually or mix them with adjusted gains
    
    CALLED BY:
    - app.js: runDemucsSeparation() when user clicks "Separate with AI" button
     
    
    USES:
    - Demucs CLI (external subprocess)
    - Base64 encoding to send audio data in JSON response
    
    LIMITATIONS:
    - Processing time: 10-60 seconds depending on audio length
    - Requires significant RAM (model is ~300MB)
    - GPU acceleration recommended but CPU works (slower)
    
    REQUEST:
    - Method: POST
    - Form data: audio (WAV file)
    
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    
    print('[Demucs] Starting 4-stem separation...')
    start_time = time.time()
    
    try:
        # ====================================================================
        # STEP 1: VALIDATE INPUT
        # ====================================================================
        if 'audio' not in request.files:
            return jsonify({"error": "missing 'audio' file"}), 400
        
        audio_file = request.files['audio']
        
        # ====================================================================
        # STEP 2: SAVE INPUT AUDIO TO TEMP FILE
        # ====================================================================
        # Demucs CLI requires a file path, not in-memory data
        temp_input = os.path.join(UPLOAD_FOLDER, 'demucs_input.wav')
        audio_file.save(temp_input)
        
        # Clean output directory from previous runs
        if os.path.exists(OUTPUT_FOLDER):
            shutil.rmtree(OUTPUT_FOLDER)
        os.makedirs(OUTPUT_FOLDER, exist_ok=True)
        
        # ====================================================================
        # STEP 3: RUN DEMUCS CLI
        # ====================================================================
        cmd = [
            'demucs',              # Demucs command
            '-n', 'htdemucs',      # Model name (HTDemucs = best quality)
            '-o', OUTPUT_FOLDER,   # Output directory
            temp_input             # Input file
        ]
        
        print(f"[Demucs] Running command: {' '.join(cmd)}")
        
        # Run with 180-second timeout (3 minutes max)
        result = subprocess.run(
            cmd,
            capture_output=True,  # Capture stdout/stderr
            text=True,            # Decode output as text
            timeout=180           # Max 3 minutes
        )
        
        # Check if Demucs succeeded
        if result.returncode != 0:
            print(f"[Demucs] Error: {result.stderr}")
            return jsonify({
                "success": False,
                "error": f"Demucs failed: {result.stderr}"
            }), 500
        
        # ====================================================================
        # STEP 4: READ SEPARATED STEMS
        # ====================================================================
        # Demucs output structure: OUTPUT_FOLDER/htdemucs/demucs_input/
        model_dir = os.path.join(OUTPUT_FOLDER, 'htdemucs', 'demucs_input')
        
        if not os.path.exists(model_dir):
            return jsonify({
                "success": False,
                "error": "Demucs output directory not found"
            }), 500
        
        stems = {}
        stem_names = []
        
        # Expected stem files (Demucs always produces these 4)
        expected_stems = ['drums', 'bass', 'vocals', 'other']
        
        for stem_name in expected_stems:
            stem_path = os.path.join(model_dir, f'{stem_name}.wav')
            
            if os.path.exists(stem_path):
                # Read WAV file as binary
                with open(stem_path, 'rb') as f:
                    wav_data = f.read()
                    
                    # Encode as base64 for JSON transmission
                    base64_data = base64.b64encode(wav_data).decode('utf-8')
                    
                    stems[stem_name] = {
                        'data': base64_data,
                        'size': len(wav_data)
                    }
                    stem_names.append(stem_name)
                    print(f"[Demucs] Found stem: {stem_name} ({len(wav_data)} bytes)")
        
        # ====================================================================
        # STEP 5: GET SAMPLE RATE FROM ONE OF THE STEMS
        # ====================================================================
        processing_time = time.time() - start_time
        
        print(f"[Demucs] Separation complete in {processing_time:.2f}s")
        print(f"[Demucs] Stems: {stem_names}")
        
        sample_rate = 44100  # Default
        if stem_names:
            # Read sample rate from first stem
            first_stem = os.path.join(model_dir, f"{stem_names[0]}.wav")
            with wave.open(first_stem, 'rb') as wf:
                sample_rate = wf.getframerate()
        
        # ====================================================================
        # STEP 6: CLEANUP TEMP FILES
        # ====================================================================
        try:
            os.remove(temp_input)
        except:
            pass  # Ignore cleanup errors
        
        # ====================================================================
        # STEP 7: RETURN RESULTS
        # ====================================================================
        return jsonify({
            "success": True,
            "stems": stems,
            "stemNames": stem_names,
            "sampleRate": sample_rate,
            "processingTime": round(processing_time, 2)
        })
        
    except subprocess.TimeoutExpired:
        # Demucs took too long (>180 seconds)
        return jsonify({
            "success": False,
            "error": "Demucs timed out (>180s). Try a shorter audio file."
        }), 500
        
    except Exception as e:
        print(f"[Demucs] Exception: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ============================================================================
# COMPARISON ENDPOINT - EQ VS DEMUCS
# ============================================================================

@app.route('/api/demucs_compare', methods=['POST', 'OPTIONS'])
def compare_demucs():
    """
    Compare Demucs AI separation with frequency-based equalizer.
    
    PURPOSE:
    - Demonstrate the difference between AI-based and frequency-based separation
    - Show processing time comparison
    - Highlight quality vs speed tradeoff
    
    RESULTS:
    - Demucs: Slower (10-60s) but actually separates instruments
    - Equalizer: Very fast (<1s) but only boosts/cuts frequencies
    
    CALLED BY:
    - Could be used for a comparison UI feature (not currently in app.js)
    
    REQUEST:
    - Method: POST
    - Form data: audio (WAV file)
    
    RESPONSE:
    {
      "demucs": {
        "time": 15.3,
        "stems": ["drums", "bass", "vocals", "other"],
        "method": "Deep Learning AI (Demucs)"
      },
      "equalizer": {
        "time": 0.2,
        "bands": 4,
        "method": "Frequency-based (FFT)"
      },
      "comparison": {
        "equalizer_faster_by": "15.1s",
        "speedup_factor": "76.5x",
        "time_saved": "15.1s",
        "winner_speed": "Equalizer",
        "winner_quality": "Demucs (AI separation isolates actual instruments)"
      }
    }
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    
    try:
        if 'audio' not in request.files:
            return jsonify({"error": "missing 'audio' file"}), 400
        
        audio_file = request.files['audio']
        audio_data = audio_file.read()
        
        # ====================================================================
        # RUN DEMUCS SEPARATION
        # ====================================================================
        demucs_start = time.time()
        
        temp_input = os.path.join(UPLOAD_FOLDER, 'compare_input.wav')
        with open(temp_input, 'wb') as f:
            f.write(audio_data)
        
        if os.path.exists(OUTPUT_FOLDER):
            shutil.rmtree(OUTPUT_FOLDER)
        os.makedirs(OUTPUT_FOLDER, exist_ok=True)
        
        cmd = ['demucs', '-n', 'htdemucs', '-o', OUTPUT_FOLDER, temp_input]
        subprocess.run(cmd, capture_output=True, timeout=180)
        
        demucs_time = time.time() - demucs_start
        
        # Count stems produced
        model_dir = os.path.join(OUTPUT_FOLDER, 'htdemucs', 'compare_input')
        demucs_stems = []
        if os.path.exists(model_dir):
            demucs_stems = [f.replace('.wav', '') for f in os.listdir(model_dir) 
                          if f.endswith('.wav')]
        
        # ====================================================================
        # RUN EQUALIZER PROCESSING
        # ====================================================================
        eq_start = time.time()
        
        sr, sig = _read_wav_to_mono_float(audio_data)
        scheme = EQScheme(sr)
        
        # Add 4 frequency bands (similar to music preset)
        bands = [
            {"startHz": 40, "widthHz": 360, "gain": 1.0},    # Sub bass
            {"startHz": 400, "widthHz": 400, "gain": 1.0},   # Kick/drums
            {"startHz": 950, "widthHz": 3050, "gain": 1.0},  # Vocals
            {"startHz": 5000, "widthHz": 9000, "gain": 1.0}  # Other
        ]
        
        for b in bands:
            scheme.add_band(b['startHz'], b['widthHz'], b['gain'])
        
        # Apply STFT + EQ + ISTFT
        S = stft(sig.tolist(), win=1024, hop=256)
        modifier = make_modifier_from_scheme(scheme)
        out = istft(modifier, S, out_len=len(sig))
        
        eq_time = time.time() - eq_start
        
        # ====================================================================
        # CLEANUP
        # ====================================================================
        try:
            os.remove(temp_input)
        except:
            pass
        
        # ====================================================================
        # COMPUTE COMPARISON METRICS
        # ====================================================================
        time_diff = demucs_time - eq_time
        faster_by = f"{abs(time_diff):.2f}s"
        speedup_factor = demucs_time / eq_time if eq_time > 0 else 0
        
        return jsonify({
            "demucs": {
                "time": round(demucs_time, 2),
                "stems": demucs_stems,
                "method": "Deep Learning AI (Demucs)"
            },
            "equalizer": {
                "time": round(eq_time, 2),
                "bands": len(bands),
                "method": "Frequency-based (FFT)"
            },
            "comparison": {
                "equalizer_faster_by": faster_by,
                "speedup_factor": f"{speedup_factor:.1f}x",
                "time_saved": f"{time_diff:.2f}s",
                "winner_speed": "Equalizer" if eq_time < demucs_time else "Demucs",
                "winner_quality": "Demucs (AI separation isolates actual instruments)"
            }
        })
        
    except Exception as e:
        print(f"[Compare] Exception: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ============================================================================
# SPEECHBRAIN VOICE SEPARATION API ENDPOINTS
# ============================================================================

@app.route('/api/speechbrain_check', methods=['GET'])
def check_speechbrain():
    """Check if SpeechBrain is installed and available"""
    return jsonify({
        "available": VOICE_SEPARATOR_AVAILABLE,
        "message": "SpeechBrain is ready" if VOICE_SEPARATOR_AVAILABLE else "Install: pip install speechbrain torch torchaudio"
    })


@app.route('/api/speechbrain_separate', methods=['POST', 'OPTIONS'])
def speechbrain_separate():
    """2-stage voice separation using SpeechBrain SepFormer"""
    if request.method == 'OPTIONS':
        return ('', 204)
    
    if not VOICE_SEPARATOR_AVAILABLE:
        return jsonify({
            "success": False,
            "error": "SpeechBrain not available. Install: pip install speechbrain torch torchaudio"
        }), 503
    
    print('[SpeechBrain] Starting 2-stage voice separation...')
    start_time = time.time()
    
    try:
        # Get both mixed audio files
        if 'audio1' not in request.files or 'audio2' not in request.files:
            return jsonify({
                "error": "Missing audio files. Need both 'audio1' and 'audio2'"
            }), 400
        
        # Read both audio files
        sr1, mix1 = _read_wav_to_mono_float(request.files['audio1'].read())
        sr2, mix2 = _read_wav_to_mono_float(request.files['audio2'].read())
        
        if sr1 != sr2:
            return jsonify({
                "error": f"Sample rates must match. Got {sr1}Hz and {sr2}Hz"
            }), 400
        
        sample_rate = sr1
        
        # Stage 1: Separate Mix 1 (Old Man + Woman)
        print('[SpeechBrain] Stage 1: Separating Old Man + Woman...')
        result1, msg1 = voice_separator.separate(mix1, sample_rate)
        
        if result1 is None:
            return jsonify({
                "success": False,
                "error": f"Stage 1 failed: {msg1}"
            }), 500
        
        old_man_audio = result1['sources'][0]  # First source
        woman_audio = result1['sources'][1]    # Second source
        
        # Stage 2: Separate Mix 2 (Man + Child)
        print('[SpeechBrain] Stage 2: Separating Man + Child...')
        result2, msg2 = voice_separator.separate(mix2, sample_rate)
        
        if result2 is None:
            return jsonify({
                "success": False,
                "error": f"Stage 2 failed: {msg2}"
            }), 500
        
        man_audio = result2['sources'][0]     # First source
        child_audio = result2['sources'][1]   # Second source
        
        # Encode all 4 speakers to base64
        stems = {}
        stem_names = ['old_man', 'woman', 'man', 'child']
        audio_sources = [old_man_audio, woman_audio, man_audio, child_audio]
        labels = ['Old Man', 'Woman', 'Man', 'Child']
        
        for stem_name, source_audio in zip(stem_names, audio_sources):
            # Normalize and convert to int16
            source_normalized = source_audio / (np.max(np.abs(source_audio)) + 1e-8) * 0.9
            source_int = (source_normalized * 32767).astype(np.int16)
            
            # Create WAV in memory
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(source_int.tobytes())
            
            buffer.seek(0)
            wav_data = buffer.read()
            base64_data = base64.b64encode(wav_data).decode('utf-8')
            
            stems[stem_name] = {
                'data': base64_data,
                'size': len(wav_data)
            }
            print(f"[SpeechBrain] Encoded: {stem_name}")
        
        processing_time = time.time() - start_time
        
        print(f"[SpeechBrain] All stages complete in {processing_time:.2f}s")
        
        return jsonify({
            "success": True,
            "stems": stems,
            "stemNames": stem_names,
            "labels": labels,
            "sampleRate": sample_rate,
            "processingTime": round(processing_time, 2),
            "model": "SpeechBrain SepFormer (2-stage)"
        })
        
    except Exception as e:
        print(f"[SpeechBrain] Exception: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
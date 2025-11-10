from flask import Flask, request, jsonify, send_file, send_from_directory, Response
from pathlib import Path
import io
import wave
import json
import numpy as np
from dsp import stft, istft, EQScheme, make_modifier_from_scheme, clamp_signal, next_pow2, fft
import subprocess, os
import tempfile
import shutil
import base64
import time

BASE_DIR = Path(__file__).resolve().parents[1]
app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')

# Demucs output directory
UPLOAD_FOLDER = tempfile.gettempdir()
OUTPUT_FOLDER = os.path.join(UPLOAD_FOLDER, "demucs_output")
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

@app.after_request
def add_cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    return resp

@app.route('/api/health')
def health():
    return jsonify({"status": "ok"})

@app.route('/')
def root():
    return send_file(str(BASE_DIR / 'index.html'))

@app.route('/favicon.ico')
def favicon():
    return ('', 204)

@app.route('/js/<path:filename>')
def serve_js(filename):
    return send_from_directory(str(BASE_DIR / 'js'), filename)

@app.route('/style.css')
def serve_css():
    return send_file(str(BASE_DIR / 'style.css'))

@app.route('/presets.json')
def serve_presets():
    return send_file(str(BASE_DIR / 'presets.json'))

@app.route('/<path:filepath>')
def serve_any(filepath):
    target = BASE_DIR / filepath
    if target.exists() and target.is_file():
        return send_from_directory(str(target.parent), target.name)
    return jsonify({"error": "Not Found"}), 404

@app.route('/api/process', methods=['POST', 'OPTIONS'])
def process_audio():
    print('[process] start')
    if request.method == 'OPTIONS':
        return ('', 204)
    try:
        if 'audio' not in request.files:
            return jsonify({"error": "missing 'audio' file"}), 400
        scheme_json = request.form.get('scheme')
        if not scheme_json:
            return jsonify({"error": "missing 'scheme' json"}), 400
        try:
            scheme_obj = json.loads(scheme_json)
        except Exception as e:
            return jsonify({"error": f"invalid scheme json: {e}"}), 400

        wav_file = request.files['audio']
        data = wav_file.read()
        with wave.open(io.BytesIO(data), 'rb') as wf:
            nchan = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            nframes = wf.getnframes()
            frames = wf.readframes(nframes)
        if sampwidth != 2:
            return jsonify({"error": "only 16-bit PCM supported"}), 400

        import struct
        total_samples = len(frames) // 2
        samples = struct.unpack('<' + 'h' * total_samples, frames)
        if nchan > 1:
            samples = samples[::nchan]
        sig = [s / 32768.0 for s in samples]

        bands_in = scheme_obj.get('bands', [])
        print(f"[process] bands received: {len(bands_in)}")
        scheme = EQScheme(framerate)
        for b in bands_in:
            scheme.add_band(b.get('startHz', 0), b.get('widthHz', 0), b.get('gain', 1.0))

        S = stft(sig, win=1024, hop=256)
        modifier = make_modifier_from_scheme(scheme)
        out = istft(modifier, S, out_len=len(sig))
        out = clamp_signal(out)

        out_int16 = bytearray()
        for v in out:
            iv = int(max(-1.0, min(1.0, v)) * 32767.0)
            out_int16 += int(iv).to_bytes(2, byteorder='little', signed=True)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(framerate)
            wf.writeframes(bytes(out_int16))
        buf.seek(0)
        data_bytes = buf.getvalue()
        print(f'[process] done bytes={len(data_bytes)}')
        return Response(data_bytes, mimetype='audio/wav')
    except Exception as e:
        print('[process] error', e)
        return jsonify({"error": str(e)}), 500


def _read_wav_to_mono_float(data_bytes):
    import struct
    with wave.open(io.BytesIO(data_bytes), 'rb') as wf:
        nchan = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        nframes = wf.getnframes()
        frames = wf.readframes(nframes)
    if sampwidth != 2:
        raise ValueError('only 16-bit PCM supported')
    total_samples = len(frames) // 2
    samples = struct.unpack('<' + 'h' * total_samples, frames)
    if nchan > 1:
        samples = samples[::nchan]
    sig = np.asarray(samples, dtype=np.float64) / 32768.0
    return framerate, sig


@app.route('/api/spectrum', methods=['POST', 'OPTIONS'])
def spectrum():
    if request.method == 'OPTIONS':
        return ('', 204)
    if 'audio' not in request.files:
        return jsonify({"error": "missing 'audio' file"}), 400
    try:
        sr, sig = _read_wav_to_mono_float(request.files['audio'].read())
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    N = next_pow2(min(len(sig), 1<<15))
    re = np.zeros(N, dtype=np.float64)
    im = np.zeros(N, dtype=np.float64)
    re[:min(N, len(sig))] = sig[:min(N, len(sig))]
    fft(re, im)
    mags = (re[:N//2]**2 + im[:N//2]**2)**0.5
    return jsonify({"sampleRate": sr, "N": int(N), "magnitudes": mags.tolist()})


@app.route('/api/spectrogram', methods=['POST', 'OPTIONS'])
def spectrogram():
    if request.method == 'OPTIONS':
        return ('', 204)
    if 'audio' not in request.files:
        return jsonify({"error": "missing 'audio' file"}), 400
    try:
        sr, sig = _read_wav_to_mono_float(request.files['audio'].read())
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    win = int(request.form.get('win', 1024))
    hop = int(request.form.get('hop', 256))
    S = stft(sig.tolist(), win=win, hop=hop)
    mags = []
    for i in range(len(S['reals'])):
        re = np.asarray(S['reals'][i])
        im = np.asarray(S['imags'][i])
        m = np.sqrt(re[:S['N']//2]**2 + im[:S['N']//2]**2)
        mags.append(m.tolist())
    return jsonify({"sampleRate": sr, "N": int(S['N']), "hop": int(S['hop']), "magnitudes": mags})


PRESETS = {
    "music": {
        "sliders": [
            {"label": "Drums", "windows": [{"startHz": 50, "widthHz": 450}]},
            {"label": "Bass", "windows": [{"startHz": 40, "widthHz": 210}]},
            {"label": "Vocals", "windows": [{"startHz": 300, "widthHz": 3100}]},
            {"label": "Other Instruments", "windows": [{"startHz": 400, "widthHz": 7600}]}
        ]
    },
    "animals": {
        "sliders": [
            {"label": "Dog", "windows": [{"startHz": 0, "widthHz": 450}]},
            {"label": "Wolf", "windows": [{"startHz": 450, "widthHz": 650}]},
            {"label": "Crow", "windows": [{"startHz": 1100, "widthHz": 1900}]},
            {"label": "Bat", "windows": [{"startHz": 3000, "widthHz": 6000}]}
        ]
    },
    "voices": {
        "sliders": [
            {"label": "Male Low", "windows": [{"startHz": 85, "widthHz": 120}]},
            {"label": "Female Mid", "windows": [{"startHz": 165, "widthHz": 250}]},
            {"label": "Sibilance", "windows": [{"startHz": 5000, "widthHz": 4000}]},
            {"label": "Formants", "windows": [{"startHz": 500, "widthHz": 2000}]}
        ]
    }
}

@app.route('/api/presets')
def presets():
    mode = request.args.get('mode', 'music')
    p = PRESETS.get(mode)
    if not p:
        return jsonify({"error": "unknown mode"}), 400
    return jsonify(p)

@app.route('/api/modes')
def modes():
    return jsonify({"modes": list(PRESETS.keys())})


# ============================================================================
# DEMUCS API ENDPOINTS - 4 STEMS VERSION
# ============================================================================

@app.route('/api/demucs_check', methods=['GET'])
def check_demucs():
    """Check if Demucs is installed and available"""
    try:
        result = subprocess.run(['demucs', '--help'], 
                              capture_output=True, 
                              timeout=5)
        available = result.returncode == 0
        return jsonify({"available": available})
    except Exception as e:
        print(f"Demucs check failed: {e}")
        return jsonify({"available": False, "error": str(e)})


@app.route('/api/demucs', methods=['POST', 'OPTIONS'])
def run_demucs():
    """Run Demucs 4-stem source separation on uploaded audio"""
    if request.method == 'OPTIONS':
        return ('', 204)
    
    print('[Demucs] Starting 4-stem separation...')
    start_time = time.time()
    
    try:
        # Get audio file
        if 'audio' not in request.files:
            return jsonify({"error": "missing 'audio' file"}), 400
        
        audio_file = request.files['audio']
        
        # Create temporary input file
        temp_input = os.path.join(UPLOAD_FOLDER, 'demucs_input.wav')
        audio_file.save(temp_input)
        
        # Clean output folder
        if os.path.exists(OUTPUT_FOLDER):
            shutil.rmtree(OUTPUT_FOLDER)
        os.makedirs(OUTPUT_FOLDER, exist_ok=True)
        
        # Run Demucs with 4 stems (drums, bass, vocals, other)
        # REMOVED --two-stems flag to get 4 stems instead of 2
        cmd = [
            'demucs',
            '-n', 'htdemucs',      # Use pretrained htdemucs model (4 stems)
            '-o', OUTPUT_FOLDER,
            temp_input
        ]
        
        print(f"[Demucs] Running command: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        
        if result.returncode != 0:
            print(f"[Demucs] Error: {result.stderr}")
            return jsonify({
                "success": False,
                "error": f"Demucs failed: {result.stderr}"
            }), 500
        
        # Find output files
        # Demucs creates: OUTPUT_FOLDER/htdemucs/demucs_input/{drums.wav, bass.wav, vocals.wav, other.wav}
        model_dir = os.path.join(OUTPUT_FOLDER, 'htdemucs', 'demucs_input')
        
        if not os.path.exists(model_dir):
            return jsonify({
                "success": False,
                "error": "Demucs output directory not found"
            }), 500
        
        # Read separated stems
        stems = {}
        stem_names = []
        
        # Expected 4 stems from htdemucs
        expected_stems = ['drums', 'bass', 'vocals', 'other']
        
        for stem_name in expected_stems:
            stem_path = os.path.join(model_dir, f'{stem_name}.wav')
            
            if os.path.exists(stem_path):
                # Read WAV file and encode to base64
                with open(stem_path, 'rb') as f:
                    wav_data = f.read()
                    base64_data = base64.b64encode(wav_data).decode('utf-8')
                    
                    stems[stem_name] = {
                        'data': base64_data,
                        'size': len(wav_data)
                    }
                    stem_names.append(stem_name)
                    print(f"[Demucs] Found stem: {stem_name} ({len(wav_data)} bytes)")
        
        processing_time = time.time() - start_time
        
        print(f"[Demucs] Separation complete in {processing_time:.2f}s")
        print(f"[Demucs] Stems: {stem_names}")
        
        # Read sample rate from one of the stems
        sample_rate = 44100
        if stem_names:
            first_stem = os.path.join(model_dir, f"{stem_names[0]}.wav")
            with wave.open(first_stem, 'rb') as wf:
                sample_rate = wf.getframerate()
        
        # Cleanup
        try:
            os.remove(temp_input)
        except:
            pass
        
        return jsonify({
            "success": True,
            "stems": stems,
            "stem_names": stem_names,
            "sampleRate": sample_rate,
            "processingTime": round(processing_time, 2)
        })
        
    except subprocess.TimeoutExpired:
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


@app.route('/api/demucs_compare', methods=['POST', 'OPTIONS'])
def compare_demucs():
    """Compare Demucs AI separation with frequency-based equalizer"""
    if request.method == 'OPTIONS':
        return ('', 204)
    
    try:
        if 'audio' not in request.files:
            return jsonify({"error": "missing 'audio' file"}), 400
        
        audio_file = request.files['audio']
        audio_data = audio_file.read()
        
        # 1. Run Demucs
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
        
        model_dir = os.path.join(OUTPUT_FOLDER, 'htdemucs', 'compare_input')
        demucs_stems = []
        if os.path.exists(model_dir):
            demucs_stems = [f.replace('.wav', '') for f in os.listdir(model_dir) 
                          if f.endswith('.wav')]
        
        # 2. Run Equalizer (simple frequency-based separation)
        eq_start = time.time()
        
        sr, sig = _read_wav_to_mono_float(audio_data)
        scheme = EQScheme(sr)
        
        # Simulate instrument separation with frequency bands
        bands = [
            {"startHz": 40, "widthHz": 360, "gain": 1.0},
            {"startHz": 400, "widthHz": 400, "gain": 1.0},
            {"startHz": 950, "widthHz": 3050, "gain": 1.0},
            {"startHz": 5000, "widthHz": 9000, "gain": 1.0}
        ]
        
        for b in bands:
            scheme.add_band(b['startHz'], b['widthHz'], b['gain'])
        
        S = stft(sig.tolist(), win=1024, hop=256)
        modifier = make_modifier_from_scheme(scheme)
        out = istft(modifier, S, out_len=len(sig))
        
        eq_time = time.time() - eq_start
        
        # Cleanup
        try:
            os.remove(temp_input)
        except:
            pass
        
        # Calculate comparison metrics
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


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
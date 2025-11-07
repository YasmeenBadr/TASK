from flask import Flask, request, jsonify, send_file, make_response, send_from_directory, Response
from pathlib import Path
import io
import wave
import json
import numpy as np
from dsp import stft, istft, EQScheme, make_modifier_from_scheme, clamp_signal, next_pow2, fft

BASE_DIR = Path(__file__).resolve().parents[1]  # project root folder containing index.html
app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')

# Simple CORS for development
@app.after_request
def add_cors(resp):
    # Not strictly needed when same-origin, but kept for convenience
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    return resp


@app.route('/api/health')
def health():
    return jsonify({"status": "ok"})


@app.route('/')
def root():
    # Serve the SPA index
    return send_file(str(BASE_DIR / 'index.html'))

@app.route('/favicon.ico')
def favicon():
    # No favicon asset; return 204 to avoid 404 logs
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
    # Fallback to serve any asset under project root (e.g., js/*.js modules)
    target = BASE_DIR / filepath
    if target.exists() and target.is_file():
        # Use send_from_directory to set correct mimetypes
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

        # decode PCM16 LE
        import struct
        total_samples = len(frames) // 2
        samples = struct.unpack('<' + 'h' * total_samples, frames)
        if nchan > 1:
            # take first channel
            samples = samples[::nchan]
        sig = [s / 32768.0 for s in samples]

        # build EQ scheme
        bands_in = scheme_obj.get('bands', [])
        print(f"[process] bands received: {len(bands_in)}")
        if bands_in[:3]:
            print('[process] first bands sample:', bands_in[:3])
        scheme = EQScheme(framerate)
        for b in bands_in:
            scheme.add_band(b.get('startHz', 0), b.get('widthHz', 0), b.get('gain', 1.0))

        S = stft(sig, win=1024, hop=256)
        modifier = make_modifier_from_scheme(scheme)
        out = istft(modifier, S, out_len=len(sig))
        out = clamp_signal(out)

        # encode back to WAV PCM16
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
            {"label": "Kick/Bass", "windows": [{"startHz": 40, "widthHz": 120}]},
            {"label": "Snare/Mids", "windows": [{"startHz": 200, "widthHz": 400}]},
            {"label": "Guitar/Piano", "windows": [{"startHz": 500, "widthHz": 1500}]},
            {"label": "Vocals/Lead", "windows": [{"startHz": 1500, "widthHz": 3500}]}
        ]
    },
    "animals": {
        "sliders": [
            {"label": "Dog", "windows": [{"startHz": 500, "widthHz": 2000}]},
            {"label": "Cat", "windows": [{"startHz": 700, "widthHz": 2000}]},
            {"label": "Bird", "windows": [{"startHz": 3000, "widthHz": 6000}]},
            {"label": "Cow", "windows": [{"startHz": 80, "widthHz": 200}]}
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


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)

# Custom DSP in Python without using numpy.fft or external FFT libs
# Radix-2 FFT/iFFT, STFT/iSTFT, EQ modifier implemented on NumPy arrays
from math import cos, sin, pi, log2
import numpy as np


def next_pow2(n: int) -> int:
    p = 1
    while p < n:
        p <<= 1
    return p


def bit_reverse(x: int, bits: int) -> int:
    r = 0
    for i in range(bits):
        r = (r << 1) | ((x >> i) & 1)
    return r


def fft(real, imag):
    # in-place iterative radix-2 Cooley-Tukey on numpy arrays (float64)
    n = real.shape[0]
    bits = int(log2(n))
    # bit reversal
    for i in range(n):
        j = bit_reverse(i, bits)
        if j > i:
            real[i], real[j] = real[j], real[i]
            imag[i], imag[j] = imag[j], imag[i]
    size = 2
    while size <= n:
        half = size // 2
        theta = -2 * pi / size
        wmul_re = cos(theta)
        wmul_im = sin(theta)
        i0 = 0
        while i0 < n:
            wre, wim = 1.0, 0.0
            for j in range(half):
                a = i0 + j
                b = i0 + j + half
                xr = real[b] * wre - imag[b] * wim
                xi = real[b] * wim + imag[b] * wre
                real[b] = real[a] - xr
                imag[b] = imag[a] - xi
                real[a] += xr
                imag[a] += xi
                tmp = wre * wmul_re - wim * wmul_im
                wim = wre * wmul_im + wim * wmul_re
                wre = tmp
            i0 += size
        size <<= 1


def ifft(real, imag):
    n = real.shape[0]
    imag *= -1.0
    fft(real, imag)
    real /= n
    imag *= -1.0 / n


def hann(N: int):
    n = np.arange(N, dtype=np.float64)
    return 0.5 * (1.0 - np.cos(2.0 * pi * n / (N - 1)))


def stft(signal, win=1024, hop=256):
    N = next_pow2(win)
    w = hann(N)
    signal = np.asarray(signal, dtype=np.float64)
    frames = []
    reals = []
    imags = []
    length = signal.shape[0]
    start = 0
    while start + N <= length:
        re = np.zeros(N, dtype=np.float64)
        im = np.zeros(N, dtype=np.float64)
        re[:] = signal[start:start+N] * w
        fft(re, im)
        frames.append(start)
        reals.append(re)
        imags.append(im)
        start += hop
    return {"frames": frames, "reals": reals, "imags": imags, "N": N, "hop": hop}


def istft(modifier, stft_data, out_len=None):
    reals = stft_data["reals"]
    imags = stft_data["imags"]
    N = stft_data["N"]
    hop = stft_data["hop"]
    w = hann(N)
    length = out_len if out_len is not None else (len(reals) * hop + N)
    out = np.zeros(length, dtype=np.float64)
    for f in range(len(reals)):
        re = np.array(reals[f], dtype=np.float64)
        im = np.array(imags[f], dtype=np.float64)
        if modifier is not None:
            modifier(re, im, N)
        ifft(re, im)
        start = f * hop
        end = min(start + N, length)
        nlen = end - start
        out[start:end] += re[:nlen] * w[:nlen]
    return out.tolist()


class EQScheme:
    def __init__(self, sample_rate: int):
        self.sample_rate = sample_rate
        self.bands = []  # list of dicts: {startHz, widthHz, gain}

    def add_band(self, start_hz=100.0, width_hz=100.0, gain=1.0):
        self.bands.append({"startHz": float(start_hz), "widthHz": float(width_hz), "gain": float(gain)})


def make_modifier_from_scheme(scheme: EQScheme):
    def modifier(re, im, N):
        bin_hz = scheme.sample_rate / N
        for b in scheme.bands:
            start_bin = max(0, int(b["startHz"] / bin_hz))
            end_bin = min(N // 2, int((b["startHz"] + b["widthHz"]) / bin_hz))
            g = float(b["gain"]) if 0 <= b["gain"] else 0.0
            for k in range(start_bin, end_bin + 1):
                re[k] *= g
                im[k] *= g
                if k != 0 and k != N // 2:
                    k2 = N - k
                    re[k2] *= g
                    im[k2] *= g
    return modifier


def clamp_signal(sig):
    # ensure within [-1,1]
    arr = np.asarray(sig, dtype=np.float64)
    arr = np.clip(arr, -1.0, 1.0)
    return arr.tolist()

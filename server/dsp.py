# Custom DSP in Python without using numpy.fft or external FFT libs
# Radix-2 FFT/iFFT, STFT/iSTFT, EQ modifier implemented on NumPy arrays
from math import cos, sin, pi, log2
import numpy as np


def next_pow2(n: int) -> int:
    """Find the next power of 2 greater than or equal to n."""
    p = 1  # Start with the smallest power of 2 (2^0)
    while p < n:
        # Keep doubling p until it becomes >= n
        p <<= 1  # Multiply by 2 efficiently (bit shift)
    return p  # Return the first power of 2 that is >= n


def bit_reverse(x: int, bits: int) -> int:
    """Reverse the bit pattern of x using 'bits' number of bits."""
    r = 0  # r will store the reversed bit pattern
    for i in range(bits):
        # Shift r left to make space, then add the i-th bit from x
        r = (r << 1) | ((x >> i) & 1)
    return r  # Return the bit-reversed value


def fft(real, imag):
    """
    In-place iterative radix-2 Cooley-Tukey FFT on numpy arrays (float64).
    Converts time-domain signal into frequency-domain representation.
    """
    n = real.shape[0]  # Number of samples in the signal
    bits = int(log2(n))  # Number of bits needed for indices

    # ---------------------------
    # BIT-REVERSAL PERMUTATION
    # ---------------------------
    for i in range(n):
        j = bit_reverse(i, bits)  # Get bit-reversed index
        if j > i:  # Swap only once to avoid double swapping
            real[i], real[j] = real[j], real[i]  # Swap real parts
            imag[i], imag[j] = imag[j], imag[i]  # Swap imaginary parts

    # ---------------------------
    # ITERATIVE BUTTERFLY OPERATIONS
    # ---------------------------
    size = 2  # Start with smallest FFT size (2 points)
    while size <= n:
        half = size >> 1  # Half the size for butterfly
        theta = -2 * pi / size  # Angle step for twiddle factors
        wmul_re = cos(theta)  # Real part of twiddle factor
        wmul_im = sin(theta)  # Imaginary part of twiddle factor

        i0 = 0  # Start index of current FFT block
        while i0 < n:
            wre, wim = 1.0, 0.0  # Initialize twiddle factor as 1 + 0j
            for j in range(half):
                a = i0 + j  # Index of first element in butterfly
                b = a + half  # Index of second element in butterfly

                # ---------------------------
                # COMPLEX MULTIPLICATION
                # ---------------------------
                xr = real[b] * wre - imag[b] * wim  # Real part of multiplication
                xi = real[b] * wim + imag[b] * wre  # Imaginary part

                # ---------------------------
                # BUTTERFLY OPERATION
                # ---------------------------
                real[b] = real[a] - xr  # Update second element (real)
                imag[b] = imag[a] - xi  # Update second element (imag)
                real[a] += xr  # Update first element (real)
                imag[a] += xi  # Update first element (imag)

                # ---------------------------
                # UPDATE TWIDDLE FACTOR
                # ---------------------------
                tmp = wre * wmul_re - wim * wmul_im  # Temporary storage
                wim = wre * wmul_im + wim * wmul_re  # Update imaginary part
                wre = tmp  # Update real part

            i0 += size  # Move to next FFT block
        size <<= 1  # Double the size for next stage


def ifft(real, imag):
    """
    Inverse FFT: convert frequency-domain back to time-domain.
    Uses conjugate trick: IFFT(X) = conj(FFT(conj(X))) / N
    """
    n = real.shape[0]  # Number of samples
    imag *= -1.0  # Conjugate the imaginary part
    fft(real, imag)  # Perform FFT on conjugated signal
    real /= n  # Scale real part by 1/N
    imag *= -1.0 / n  # Conjugate and scale imaginary part


def hann(N: int):
    """
    Generate Hann window of length N to reduce spectral leakage.
    """
    n = np.arange(N, dtype=np.float64)  # Array [0, 1, ..., N-1]
    return 0.5 * (1.0 - np.cos(2.0 * pi * n / (N - 1)))  # Hann formula


def stft(signal, win=1024, hop=256):
    """
    Short-Time Fourier Transform (STFT): analyze signal in overlapping windows.
    Returns frequency content over time.
    """
    N = next_pow2(win)  # Ensure window length is a power of 2
    w = hann(N)  # Precompute Hann window
    signal = np.asarray(signal, dtype=np.float64)  # Convert signal to float64 array

    frames = []  # Start indices of frames
    reals = []  # Real parts of FFT
    imags = []  # Imaginary parts of FFT
    length = signal.shape[0]  # Total signal length

    start = 0  # Initial frame start
    while start + N <= length:  # Loop over frames
        re = np.zeros(N, dtype=np.float64)  # Allocate real buffer
        im = np.zeros(N, dtype=np.float64)  # Allocate imaginary buffer
        re[:] = signal[start:start+N] * w  # Apply window to signal
        fft(re, im)  # Compute FFT

        frames.append(start)  # Save frame start index
        reals.append(re)  # Save FFT real part
        imags.append(im)  # Save FFT imaginary part

        start += hop  # Move to next frame

    return {"frames": frames, "reals": reals, "imags": imags, "N": N, "hop": hop}


def istft(modifier, stft_data, out_len=None):
    """
    Inverse STFT: reconstruct time-domain signal.
    Optionally apply modifier (EQ, filtering) to frequency data.
    """
    reals = stft_data["reals"]
    imags = stft_data["imags"]
    N = stft_data["N"]
    hop = stft_data["hop"]

    w = hann(N)  # Synthesis Hann window

    length = out_len if out_len is not None else (len(reals) * hop + N)  # Output length

    out = np.zeros(length, dtype=np.float64)  # Output buffer
    norm = np.zeros(length, dtype=np.float64)  # Normalization weights

    for f in range(len(reals)):
        re = np.array(reals[f], dtype=np.float64)  # Copy real part
        im = np.array(imags[f], dtype=np.float64)  # Copy imaginary part

        if modifier is not None:
            modifier(re, im, N)  # Apply EQ/filter

        ifft(re, im)  # Convert back to time-domain

        start = f * hop
        end = min(start + N, length)
        nlen = end - start

        seg = re[:nlen] * w[:nlen]  # Windowed segment
        out[start:end] += seg  # Overlap-add
        norm[start:end] += w[:nlen] ** 2  # Accumulate window energy

    nz = norm > 1e-12  # Avoid divide by zero
    out[nz] = out[nz] / norm[nz]  # Normalize amplitude

    return out.tolist()  # Return as Python list


class EQScheme:
    """
    Equalizer scheme: defines frequency bands and their gain adjustments.
    """
    def __init__(self, sample_rate: int):
        self.sample_rate = sample_rate  # Store the sample rate of the audio in Hz
        self.bands = []  # Initialize an empty list to hold EQ band definitions
    
    def add_band(self, start_hz=100.0, width_hz=100.0, gain=1.0):
        """Add an EQ band with start frequency, bandwidth, and gain multiplier."""
        self.bands.append({
            "startHz": float(start_hz),  # Frequency where the band starts
            "widthHz": float(width_hz),  # Width of the frequency band
            "gain": float(gain)  # How much to scale the amplitude (1.0 = no change)
        })


def make_modifier_from_scheme(scheme: EQScheme):
    """
    Create a modifier function that applies the EQ scheme to frequency-domain data.
    Returns a closure (function) that can be passed to istft.
    """
    def modifier(re, im, N):
        """Apply EQ gains to FFT frequency bins for a single frame."""
        bin_hz = scheme.sample_rate / N  # Frequency represented by each FFT bin

        # Process each EQ band in the scheme
        for b in scheme.bands:
            start = float(b.get("startHz", 0.0))  # Get start frequency of band
            width = float(b.get("widthHz", 0.0))  # Get width of band
            g = float(b.get("gain", 1.0))  # Get gain multiplier

            # Prevent negative gain (would invert signal phase)
            if g < 0:
                g = 0.0

            # Skip bands with zero width
            if width <= 0:
                continue

            # Convert start and end frequency to FFT bin indices
            start_bin = max(0, int(start / bin_hz))  # Bin where band starts
            end_bin = min(N >> 1, int((start + width) / bin_hz))  # Bin where band ends (N/2 = Nyquist)

            # Ensure at least one bin is affected
            if end_bin <= start_bin:
                end_bin = min(N >> 1, start_bin + 1)

            # Apply gain to positive frequencies
            for k in range(start_bin, end_bin):
                re[k] *= g  # Scale real part of bin
                im[k] *= g  # Scale imaginary part of bin

                # Apply gain to corresponding negative frequency (conjugate symmetry)
                if k != 0 and k != (N >> 1):  # Skip DC (0 Hz) and Nyquist
                    k2 = N - k  # Mirror index for negative frequency
                    re[k2] *= g
                    im[k2] *= g
    
    # Return the modifier function (closure)
    return modifier


def clamp_signal(sig):
    """
    Ensure signal values are within [-1.0, 1.0] range.
    Prevents clipping artifacts in audio playback or processing.
    """
    arr = np.asarray(sig, dtype=np.float64)  # Convert input signal to NumPy array (float64)
    arr = np.clip(arr, -1.0, 1.0)  # Clamp all values to be between -1.0 and 1.0
    return arr.tolist()  # Return the clamped signal as a Python list

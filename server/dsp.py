# Custom DSP in Python without using numpy.fft or external FFT libs
# Radix-2 FFT/iFFT, STFT/iSTFT, EQ modifier implemented on NumPy arrays
from math import cos, sin, pi, log2
import numpy as np


def next_pow2(n: int) -> int:
    """Find the next power of 2 greater than or equal to n."""
    # Start with p=1 and keep doubling until p >= n
    p = 1
    while p < n:
        p <<= 1  # Left shift by 1 is equivalent to multiplying by 2
    return p


def bit_reverse(x: int, bits: int) -> int:
    """Reverse the bit pattern of x using 'bits' number of bits."""
    r = 0  # Result accumulator
    for i in range(bits):
        r = (r << 1) | ((x >> i) & 1)  # Shift result left, add LSB of x
    return r


def fft(real, imag):
    """
    In-place iterative radix-2 Cooley-Tukey FFT on numpy arrays (float64).
    Transforms time-domain signal into frequency-domain representation.
    """
    n = real.shape[0]  # Get array size (must be power of 2)
    bits = int(log2(n))  # Number of bits needed to represent indices
    
    # Bit-reversal permutation for in-place computation
    for i in range(n):
        j = bit_reverse(i, bits)  # Get bit-reversed index
        if j > i:  # Swap only once per pair to avoid double-swapping
            real[i], real[j] = real[j], real[i]
            imag[i], imag[j] = imag[j], imag[i]
    
    # Iterative FFT computation using butterfly operations
    size = 2  # Start with 2-point FFTs
    while size <= n:
        half = size >> 1  # Half-size for butterfly indexing (optimized division)
        theta = -2 * pi / size  # Angle step for twiddle factors
        wmul_re = cos(theta)  # Real part of twiddle factor multiplier
        wmul_im = sin(theta)  # Imaginary part of twiddle factor multiplier
        
        i0 = 0  # Starting index of current FFT block
        while i0 < n:
            wre, wim = 1.0, 0.0  # Initialize twiddle factor to 1+0j
            for j in range(half):
                a = i0 + j  # Index of first element in butterfly
                b = a + half  # Index of second element in butterfly
                
                # Complex multiplication: (real[b] + j*imag[b]) * (wre + j*wim)
                xr = real[b] * wre - imag[b] * wim  # Real part
                xi = real[b] * wim + imag[b] * wre  # Imaginary part
                
                # Butterfly operation: update both elements
                real[b] = real[a] - xr
                imag[b] = imag[a] - xi
                real[a] += xr
                imag[a] += xi
                
                # Update twiddle factor for next iteration
                tmp = wre * wmul_re - wim * wmul_im
                wim = wre * wmul_im + wim * wmul_re
                wre = tmp
            
            i0 += size  # Move to next FFT block
        size <<= 1  # Double the FFT size for next stage


def ifft(real, imag):
    """
    Inverse FFT: transforms frequency-domain back to time-domain.
    Uses the conjugate trick: IFFT(X) = conj(FFT(conj(X))) / N
    """
    n = real.shape[0]  # Get array size
    imag *= -1.0  # Conjugate: negate imaginary part
    fft(real, imag)  # Perform forward FFT on conjugated input
    real /= n  # Scale real part by 1/N
    imag *= -1.0 / n  # Conjugate and scale imaginary part


def hann(N: int):
    """
    Generate Hann window of length N for windowing signals.
    Reduces spectral leakage in frequency analysis.
    """
    n = np.arange(N, dtype=np.float64)  # Create array [0, 1, 2, ..., N-1]
    # Hann window formula: 0.5 * (1 - cos(2π*n/(N-1)))
    return 0.5 * (1.0 - np.cos(2.0 * pi * n / (N - 1)))


def stft(signal, win=1024, hop=256):
    """
    Short-Time Fourier Transform: analyze signal in overlapping windows.
    Returns frequency content over time.
    """
    N = next_pow2(win)  # Round window size up to power of 2 for FFT
    w = hann(N)  # Pre-compute Hann window
    signal = np.asarray(signal, dtype=np.float64)  # Ensure float64 array
    
    # Initialize storage for frame data
    frames = []  # Starting positions of each frame
    reals = []  # Real parts of FFT results
    imags = []  # Imaginary parts of FFT results
    length = signal.shape[0]  # Total signal length
    
    start = 0  # Starting position of current frame
    while start + N <= length:  # Process until we run out of full windows
        re = np.zeros(N, dtype=np.float64)  # Allocate real buffer
        im = np.zeros(N, dtype=np.float64)  # Allocate imaginary buffer
        re[:] = signal[start:start+N] * w  # Apply window to signal segment
        fft(re, im)  # Compute FFT of windowed segment
        
        # Store results for this frame
        frames.append(start)
        reals.append(re)
        imags.append(im)
        
        start += hop  # Move to next frame (with overlap)
    
    # Return all STFT data bundled together
    return {"frames": frames, "reals": reals, "imags": imags, "N": N, "hop": hop}


def istft(modifier, stft_data, out_len=None):
    """
    Inverse Short-Time Fourier Transform: reconstruct time-domain signal.
    Optionally applies a modifier function to each frame's frequency data.
    """
    # Extract STFT parameters
    reals = stft_data["reals"]
    imags = stft_data["imags"]
    N = stft_data["N"]
    hop = stft_data["hop"]
    
    w = hann(N)  # Re-create Hann window for synthesis
    
    # Calculate output length
    length = out_len if out_len is not None else (len(reals) * hop + N)
    
    # Initialize output buffers
    out = np.zeros(length, dtype=np.float64)  # Time-domain output
    norm = np.zeros(length, dtype=np.float64)  # Normalization weights
    
    # Process each frame
    for f in range(len(reals)):
        # Copy frequency data for this frame
        re = np.array(reals[f], dtype=np.float64)
        im = np.array(imags[f], dtype=np.float64)
        
        # Apply modifier if provided (e.g., EQ, filtering)
        if modifier is not None:
            modifier(re, im, N)
        
        ifft(re, im)  # Transform back to time domain
        
        # Calculate overlap-add boundaries
        start = f * hop
        end = min(start + N, length)
        nlen = end - start
        
        # Apply synthesis window and accumulate
        seg = re[:nlen] * w[:nlen]  # Window the time-domain frame
        out[start:end] += seg  # Overlap-add to output
        norm[start:end] += (w[:nlen] ** 2)  # Accumulate window energy for normalization
    
    # Normalize by accumulated window energy to maintain correct amplitude
    nz = norm > 1e-12  # Find non-zero elements (avoid division by zero)
    out[nz] = out[nz] / norm[nz]  # Apply normalization
    
    return out.tolist()  # Convert to Python list


class EQScheme:
    """
    Equalizer scheme: defines frequency bands and their gain adjustments.
    """
    def __init__(self, sample_rate: int):
        self.sample_rate = sample_rate  # Sample rate in Hz
        self.bands = []  # List of EQ band definitions
    
    def add_band(self, start_hz=100.0, width_hz=100.0, gain=1.0):
        """Add an EQ band with start frequency, bandwidth, and gain multiplier."""
        self.bands.append({
            "startHz": float(start_hz),  # Band start frequency
            "widthHz": float(width_hz),  # Band width
            "gain": float(gain)  # Amplitude multiplier (1.0 = no change)
        })


def make_modifier_from_scheme(scheme: EQScheme):
    """
    Create a modifier function that applies EQ scheme to frequency-domain data.
    Returns a closure that can be passed to istft.
    """
    def modifier(re, im, N):
        """Apply EQ gains to frequency bins."""
        bin_hz = scheme.sample_rate / N  # Frequency resolution per bin
        
        # Process each EQ band
        for b in scheme.bands:
            start = float(b.get("startHz", 0.0))  # Band start frequency
            width = float(b.get("widthHz", 0.0))  # Band width
            g = float(b.get("gain", 1.0))  # Gain multiplier
            
            # Clamp gain to non-negative (avoid phase inversion)
            if g < 0:
                g = 0.0
            
            # Skip zero-width bands
            if width <= 0:
                continue
            
            # Calculate FFT bin range for this frequency band
            start_bin = max(0, int(start / bin_hz))
            end_bin = min(N >> 1, int((start + width) / bin_hz))  # Use bit shift for division
            
            # Ensure at least one bin is affected
            if end_bin <= start_bin:
                end_bin = min(N >> 1, start_bin + 1)
            
            # Apply gain to positive frequencies and their negative counterparts
            for k in range(start_bin, end_bin):
                re[k] *= g  # Scale real part
                im[k] *= g  # Scale imaginary part
                
                # Apply to negative frequency (conjugate symmetry for real signals)
                if k != 0 and k != (N >> 1):  # Skip DC and Nyquist
                    k2 = N - k  # Mirror index
                    re[k2] *= g
                    im[k2] *= g
    
    return modifier


def clamp_signal(sig):
    """
    Ensure signal values are within [-1.0, 1.0] range.
    Prevents clipping artifacts in audio processing.
    """
    arr = np.asarray(sig, dtype=np.float64)  # Convert to numpy array
    arr = np.clip(arr, -1.0, 1.0)  # Clamp values to valid range
    return arr.tolist()  # Return as Python list
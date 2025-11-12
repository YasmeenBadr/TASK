"""
Standalone Voice Separation Module using SpeechBrain SepFormer
Can be imported and used independently from the main application
"""

import warnings
# Silence SpeechBrain's internal deprecation warnings
warnings.filterwarnings("ignore", message="Module 'speechbrain.pretrained' was deprecated")

import numpy as np
import time

# Try to import AI model dependencies
try:
    import torch
    import torchaudio
    # FIXED: Use new SpeechBrain 1.0+ module
    from speechbrain.inference.separation import SepformerSeparation
    AI_AVAILABLE = True
except ImportError as e:
    AI_AVAILABLE = False
    SepformerSeparation = None
    print(f"AI dependencies not installed: {e}")
    print("Run: pip install speechbrain torch torchaudio soundfile")


class VoiceSeparator:
    """
    Wrapper class for SpeechBrain's SepFormer voice separation model
    """
    
    def __init__(self, model_name="speechbrain/sepformer-wham"):
        """
        Initialize the voice separator
        
        Args:
            model_name (str): SpeechBrain model to use
                - "speechbrain/sepformer-wham" (2 speakers, recommended)
                - "speechbrain/sepformer-wsj02mix" (2 speakers)
                - "speechbrain/sepformer-wsj03mix" (3 speakers)
                - "speechbrain/sepformer-libri2mix" (2 speakers, LibriSpeech)
        """
        self.model = None
        self.model_loaded = False
        self.device = 'cuda' if (AI_AVAILABLE and torch.cuda.is_available()) else 'cpu'
        self.model_name = model_name
        self.target_sample_rate = 8000  # SepFormer works best at 8kHz
    
    def load_model(self):
        """Load the SpeechBrain model"""
        if not AI_AVAILABLE:
            return False, "AI dependencies not installed. Run: pip install speechbrain torchaudio torch soundfile"
        
        if self.model_loaded:
            return True, "Model already loaded"
        
        try:
            print(f"[VoiceSeparator] Loading {self.model_name}...")
            
            self.model = SepformerSeparation.from_hparams(
                source=self.model_name,
                savedir=f"pretrained_models/{self.model_name.split('/')[-1]}",
                run_opts={"device": self.device}
            )
            
            print(f"[OK] Model loaded on {self.device.upper()}")
            self.model_loaded = True
            return True, f"Model loaded successfully on {self.device.upper()}"
        
        except Exception as e:
            error_msg = str(e)
            print(f"[ERROR] Error loading model: {error_msg}")
            return False, f"Error loading model: {error_msg}"
    
    def separate(self, audio_signal, sample_rate):
        """
        Separate voices from mixed audio signal
        
        Args:
            audio_signal (np.ndarray): Input audio signal (mono)
            sample_rate (int): Sample rate of the input audio
        
        Returns:
            dict: Result containing separated sources, or None if failed
            str: Status message
        """
        if not AI_AVAILABLE:
            return None, "AI dependencies not installed"
        
        if not self.model_loaded:
            success, msg = self.load_model()
            if not success:
                return None, msg
        
        try:
            # Prepare audio
            if isinstance(audio_signal, np.ndarray):
                mixture = torch.from_numpy(audio_signal.astype(np.float32))
            else:
                mixture = audio_signal.float()
            
            # Normalize
            mixture = mixture / (torch.max(torch.abs(mixture)) + 1e-8)
            
            # Ensure correct shape (batch, time)
            if mixture.dim() == 1:
                mixture = mixture.unsqueeze(0)
            
            # Resample if necessary
            if sample_rate != self.target_sample_rate:
                print(f"[VoiceSeparator] Resampling from {sample_rate}Hz to {self.target_sample_rate}Hz")
                resampler = torchaudio.transforms.Resample(sample_rate, self.target_sample_rate)
                mixture = resampler(mixture)
            
            # Separate
            start_time = time.time()
            est_sources = self.model.separate_batch(mixture)
            separation_time = time.time() - start_time
            
            # Convert to numpy
            est_sources = est_sources.cpu().numpy()
            
            # Fix shape: (batch, time, sources) -> (sources, time)
            if est_sources.ndim == 3:
                est_sources = est_sources.squeeze(0)  # Remove batch
                est_sources = est_sources.T  # Transpose
            
            print(f"[OK] Separated {est_sources.shape[0]} sources in {separation_time:.2f}s")
            
            # Resample back to original sample rate if needed
            if sample_rate != self.target_sample_rate:
                resampler_back = torchaudio.transforms.Resample(self.target_sample_rate, sample_rate)
                est_sources_resampled = []
                for source in est_sources:
                    source_tensor = torch.from_numpy(source).unsqueeze(0)
                    resampled = resampler_back(source_tensor).squeeze(0).numpy()
                    est_sources_resampled.append(resampled)
                est_sources = np.array(est_sources_resampled)
            
            result = {
                'sources': est_sources,
                'num_speakers': est_sources.shape[0],
                'separation_time': separation_time,
                'sample_rate': sample_rate,
                'model': self.model_name,
                'device': self.device
            }
            
            return result, "Separation successful"
        
        except Exception as e:
            import traceback
            traceback.print_exc()
            return None, f"Separation error: {str(e)}"
    
    def separate_from_file(self, audio_path):
        """
        Separate voices directly from audio file
        
        Args:
            audio_path (str): Path to audio file
        
        Returns:
            dict: Result containing separated sources
            str: Status message
        """
        if not AI_AVAILABLE:
            return None, "AI dependencies not installed"
        
        try:
            import scipy.io.wavfile as wav
            
            sample_rate, audio_data = wav.read(audio_path)
            
            # Convert to mono if stereo
            if len(audio_data.shape) > 1:
                audio_data = np.mean(audio_data, axis=1)
            
            # Normalize to float
            audio_data = audio_data.astype(np.float32)
            max_val = np.max(np.abs(audio_data))
            if max_val > 0:
                audio_data = audio_data / max_val
            
            return self.separate(audio_data, sample_rate)
        
        except Exception as e:
            return None, f"Error reading file: {str(e)}"
    
    def save_sources(self, result, output_dir="output"):
        """
        Save separated sources to WAV files
        
        Args:
            result (dict): Result from separate() method
            output_dir (str): Directory to save output files
        """
        import os
        import scipy.io.wavfile as wav
        
        os.makedirs(output_dir, exist_ok=True)
        
        saved_files = []
        for i, source in enumerate(result['sources']):
            # Normalize
            source_normalized = source / (np.max(np.abs(source)) + 1e-8) * 0.9
            source_int = (source_normalized * 32767).astype(np.int16)
            
            # Save
            filename = f"{output_dir}/speaker_{i+1}.wav"
            wav.write(filename, result['sample_rate'], source_int)
            saved_files.append(filename)
            print(f"[OK] Saved: {filename}")
        
        return saved_files


# Convenience function for quick usage
def separate_voices(audio_signal, sample_rate, model_name="speechbrain/sepformer-wham"):
    """
    Convenience function to separate voices in one call
    
    Args:
        audio_signal (np.ndarray): Input audio signal
        sample_rate (int): Sample rate
        model_name (str): Model to use
    
    Returns:
        dict: Separation result
        str: Status message
    """
    separator_instance = VoiceSeparator(model_name)
    return separator_instance.separate(audio_signal, sample_rate)


# Example usage
if __name__ == "__main__":
    import scipy.io.wavfile as wav
    
    print("=== Voice Separator Test ===")
    
    # Create a test signal (synthetic mix)
    sample_rate = 8000
    duration = 3
    t = np.linspace(0, duration, int(sample_rate * duration), False)
    
    # Two speakers with different fundamental frequencies
    speaker1 = np.sin(2 * np.pi * 220 * t) + 0.5 * np.sin(2 * np.pi * 440 * t)
    speaker2 = np.sin(2 * np.pi * 150 * t) + 0.5 * np.sin(2 * np.pi * 300 * t)
    
    mixture = (speaker1 + speaker2) / 2
    mixture = mixture / np.max(np.abs(mixture)) * 0.9
    
    # Save test signal
    mixture_int = (mixture * 32767).astype(np.int16)
    wav.write("test_mixture.wav", sample_rate, mixture_int)
    print("[OK] Created test_mixture.wav")
    
    # Separate
    separator_instance = VoiceSeparator()
    result, msg = separator_instance.separate(mixture, sample_rate)
    
    if result:
        print(f"\n[OK] {msg}")
        print(f"Separated {result['num_speakers']} speakers")
        print(f"Processing time: {result['separation_time']:.2f}s")
        
        # Save results
        saved = separator_instance.save_sources(result)
        print(f"\nSaved {len(saved)} files to 'output/' directory")
    else:
        print(f"\n[ERROR] {msg}")
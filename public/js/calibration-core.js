/**
 * Shared calibration logic for Settings and Onboarding
 * Handles speaker enrollment with live feedback and validation
 */

import { CalibrationMonitor } from './components/calibration-monitor.js';

export class CalibrationSession {
  constructor(config) {
    this.config = config; // { btnId, statusId, counterId, attemptsId, samplePrefix, monitorId }
    this.state = {
      consecutiveSuccess: 0,
      attempts: 0,
      samples: [],
      isRecording: false,
      monitor: null,
      micVAD: null,
      stream: null,
      baselineRMS: null,          // Adaptive threshold: captures user's natural voice level
      adaptiveThreshold: null     // Calculated as baselineRMS * 0.6 (60% of baseline)
    };
  }

  // Helper: Calculate RMS energy
  calculateRMSEnergy(samples) {
    const sumSquares = samples.reduce((sum, val) => sum + val * val, 0);
    return Math.sqrt(sumSquares / samples.length);
  }

  // Helper: Reset consecutive counter
  resetConsecutiveCounter() {
    this.state.consecutiveSuccess = 0;
    this.state.samples = [];
    const counterEl = document.getElementById(this.config.counterId);
    if (counterEl) counterEl.textContent = '0';

    // Reset visual rings
    for (let i = 1; i <= 3; i++) {
      this.updateSampleRing(i, 'pending');
    }

    // NOTE: We do NOT reset baselineRMS/adaptiveThreshold here
    // Once established, they persist for the entire calibration session
    // This allows the system to stay adapted to the user's natural voice level
  }

  // Helper: Update sample ring visual
  updateSampleRing(sampleNum, state) {
    const ring = document.getElementById(`${this.config.samplePrefix}${sampleNum}`);
    if (!ring) return;

    ring.className = 'calibration-sample-ring';

    if (state === 'success') {
      ring.classList.add('calibration-sample-success');
      ring.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--accent-green)" stroke-width="2.5"><path d="M3 8l4 4 6-6"/></svg>`;
    } else if (state === 'pending') {
      ring.innerHTML = `<span class="calibration-sample-number">${sampleNum}</span>`;
    }
  }

  // Helper: Update calibration status
  updateCalibrationStatus(type, message) {
    const statusEl = document.getElementById(this.config.statusId);
    if (!statusEl) return;

    const icons = {
      listening: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-blue)" stroke-width="1.5"><circle cx="8" cy="4" r="2"/><path d="M5 10c0-1.7 1.3-3 3-3s3 1.3 3 3v2"/></svg>',
      validating: '<svg viewBox="0 0 16 16" width="14" height="14" class="spinner"><circle cx="8" cy="8" r="6" stroke="var(--accent-blue)" stroke-width="2" fill="none" stroke-dasharray="37.7 37.7" stroke-dashoffset="9.4"/></svg>',
      success: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-green)" stroke-width="2"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>',
      error: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-red)" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M5 5l6 6M11 5l-6 6"/></svg>'
    };

    const colors = {
      listening: 'var(--accent-blue)',
      validating: 'var(--text-muted)',
      success: 'var(--accent-green)',
      error: 'var(--accent-red)'
    };

    statusEl.innerHTML = `
      <div class="calibration-status-message" style="color: ${colors[type]}">
        ${icons[type]}
        <span>${message}</span>
      </div>
    `;
  }

  // Helper: Get failure reason
  getFailureReason(result, t) {
    switch (result.reason) {
      case 'too_short':
        return t('settings.tooShort');
      case 'wrong_word':
        return t('settings.wrongWord', { transcript: result.transcript || '...' });
      case 'whisper_error':
        return t('settings.whisperError');
      default:
        return t('settings.detectionFailed');
    }
  }

  // Helper: Convert Float32Array to WAV blob
  float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    const offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  // Process calibration audio
  async processCalibrationAudio(audio, t) {
    this.state.attempts++;
    const attemptsEl = document.getElementById(this.config.attemptsId);
    if (attemptsEl) attemptsEl.textContent = this.state.attempts;

    // CLIENT-SIDE GATES
    // 1. Duration check
    const duration = audio.length / 16000;
    if (duration < 0.3) {
      this.updateCalibrationStatus('error', t('settings.tooShort'));
      this.resetConsecutiveCounter();
      return;
    }
    if (duration > 10) {
      this.updateCalibrationStatus('error', t('settings.tooLong'));
      this.resetConsecutiveCounter();
      return;
    }

    // 2. RMS energy check - ADAPTIVE THRESHOLD (very permissive)
    const rms = this.calculateRMSEnergy(audio);

    // If this is the first valid sample, establish baseline from user's natural voice
    if (this.state.baselineRMS === null && rms > 0.002) {
      this.state.baselineRMS = rms;
      this.state.adaptiveThreshold = Math.max(0.002, rms * 0.3); // Very permissive: 30% of baseline, minimum 0.002
      console.log(`[Calibration] Baseline established: RMS=${rms.toFixed(3)}, threshold=${this.state.adaptiveThreshold.toFixed(3)}`);
    }

    // Only reject complete silence (< 0.002)
    // This is extremely permissive - we rely on Whisper validation for quality
    const minRMS = this.state.adaptiveThreshold || 0.002;
    if (rms < minRMS) {
      this.updateCalibrationStatus('error', t('settings.tooQuiet', { rms: rms.toFixed(3) }));
      this.resetConsecutiveCounter();
      return;
    }

    // 3. Length check
    if (audio.length < 3200) {
      this.updateCalibrationStatus('error', t('settings.tooShort'));
      this.resetConsecutiveCounter();
      return;
    }

    // CLIENT GATES PASSED → Call server validation
    this.updateCalibrationStatus('validating', t('settings.validating'));

    const wavBlob = this.float32ToWav(audio, 16000);

    try {
      const response = await fetch('/api/wake-word/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBlob
      });

      const result = await response.json();

      if (result.valid) {
        // SUCCESS!
        this.state.consecutiveSuccess++;
        this.state.samples.push(wavBlob);

        this.updateCalibrationStatus('success', t('settings.detectionSuccess', {
          count: this.state.consecutiveSuccess
        }));
        this.updateSampleRing(this.state.consecutiveSuccess, 'success');
        const counterEl = document.getElementById(this.config.counterId);
        if (counterEl) {
          counterEl.textContent = this.state.consecutiveSuccess;
          counterEl.classList.add('success');
          setTimeout(() => counterEl.classList.remove('success'), 500);
        }

        if (this.state.consecutiveSuccess >= 3) {
          await this.complete(t);
        }
      } else {
        // FAILURE
        const reason = this.getFailureReason(result, t);
        this.updateCalibrationStatus('error', reason);
        this.resetConsecutiveCounter();
      }
    } catch (err) {
      this.updateCalibrationStatus('error', t('settings.validationError', { error: err.message }));
      this.resetConsecutiveCounter();
    }
  }

  // Complete calibration
  async complete(t) {
    this.updateCalibrationStatus('validating', t('settings.enrolling'));

    try {
      const formData = new FormData();
      this.state.samples.forEach((blob, i) => {
        formData.append('samples', blob, `sample_${i}.wav`);
      });

      const res = await fetch('/api/speaker/enroll', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) throw new Error(await res.text());

      // Success! Call completion callback if provided
      if (this.config.onComplete) {
        await this.config.onComplete();
      }

      this.stop(t);

    } catch (err) {
      this.updateCalibrationStatus('error', t('settings.enrollmentError', { error: err.message }));
    }
  }

  // Stop calibration
  stop(t) {
    if (this.state.monitor) {
      this.state.monitor.stop();
      this.state.monitor = null;
    }

    if (this.state.micVAD) {
      try { this.state.micVAD.destroy(); } catch {}
      this.state.micVAD = null;
    }

    if (this.state.stream) {
      this.state.stream.getTracks().forEach(track => track.stop());
      this.state.stream = null;
    }

    this.state.isRecording = false;

    const monitorContainer = document.getElementById(this.config.monitorId);
    if (monitorContainer) monitorContainer.classList.remove('active');

    const btn = document.getElementById(this.config.btnId);
    if (btn && t) {
      btn.innerHTML = `
        <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="var(--accent-red)"/></svg>
        ${t('settings.startCalibration')}
      `;
      btn.classList.remove('btn-danger');
      btn.disabled = false;
    }
  }

  // Start calibration
  async start(t) {
    if (this.state.isRecording) {
      this.stop(t);
      return;
    }

    const btn = document.getElementById(this.config.btnId);
    if (btn) btn.disabled = true;
    this.updateCalibrationStatus('listening', t('settings.requestingMic'));

    try {
      // Request microphone
      this.state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });

      // Start audio monitor
      const monitorContainer = document.getElementById(this.config.monitorId);
      this.state.monitor = new CalibrationMonitor(this.state.stream, monitorContainer);
      this.state.monitor.start();

      // Initialize MicVAD
      this.state.micVAD = await window.vad.MicVAD.new({
        stream: this.state.stream,
        ortConfig: (ort) => { ort.env.wasm.wasmPaths = "/vendor/"; },
        baseAssetPath: "/vendor/",
        positiveSpeechThreshold: 0.8,
        negativeSpeechThreshold: 0.3,
        minSpeechFrames: 2,
        preSpeechPadFrames: 6,
        onSpeechStart: () => {
          console.log("[Calibration] Speech started");
          this.updateCalibrationStatus('listening', t('settings.listening'));
        },
        onSpeechEnd: async (audio) => {
          await this.processCalibrationAudio(audio, t);
        },
      });

      this.state.micVAD.start();
      this.state.isRecording = true;

      if (btn) {
        btn.textContent = t('settings.stopCalibration');
        btn.disabled = false;
        btn.classList.add('btn-danger');
      }
      this.updateCalibrationStatus('success', t('settings.sayYabbyNow'));

    } catch (err) {
      console.error('[Calibration] Mic error:', err);
      this.updateCalibrationStatus('error', t('settings.micError') + ': ' + err.message);
      if (btn) btn.disabled = false;
      this.stop(t);
    }
  }
}

/**
 * Real-time audio monitor for calibration
 * Shows waveform, RMS energy bar, volume meter
 */

export class CalibrationMonitor {
  constructor(stream, containerEl) {
    this.stream = stream;
    this.containerEl = containerEl;
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.source.connect(this.analyser);

    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.animationFrame = null;
    this.isActive = false;
  }

  start() {
    this.isActive = true;
    this.render();
    this.animate();
  }

  stop() {
    this.isActive = false;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    if (this.source) this.source.disconnect();
    if (this.audioContext.state !== 'closed') this.audioContext.close();
  }

  render() {
    this.containerEl.innerHTML = `
      <div class="calibration-monitor">
        <div class="calibration-waveform" id="calWaveform">
          <canvas width="300" height="60"></canvas>
        </div>
        <div class="calibration-meters">
          <div class="calibration-meter">
            <span class="calibration-meter-label">Volume</span>
            <div class="calibration-meter-bar">
              <div class="calibration-meter-fill" id="calVolume"></div>
            </div>
          </div>
          <div class="calibration-meter">
            <span class="calibration-meter-label">Clarté</span>
            <div class="calibration-meter-bar">
              <div class="calibration-meter-fill" id="calClarity"></div>
            </div>
          </div>
        </div>
        <div class="calibration-stats" id="calStats">
          <span>RMS: <strong id="calRMS">--</strong></span>
          <span>Peak: <strong id="calPeak">--</strong></span>
        </div>
      </div>
    `;

    // Show container
    this.containerEl.classList.add('active');
  }

  animate() {
    if (!this.isActive) return;

    this.analyser.getByteTimeDomainData(this.dataArray);

    // Calculate RMS energy
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const normalized = (this.dataArray[i] - 128) / 128;
      sumSquares += normalized * normalized;
      peak = Math.max(peak, Math.abs(normalized));
    }
    const rms = Math.sqrt(sumSquares / this.dataArray.length);

    // Update meters
    const volumeBar = document.getElementById('calVolume');
    const clarityBar = document.getElementById('calClarity');
    if (volumeBar) {
      const volumePct = Math.min(100, rms * 200);
      volumeBar.style.width = `${volumePct}%`;
      volumeBar.style.background = volumePct < 20 ? 'var(--accent-red)'
        : volumePct < 50 ? 'var(--accent-orange)'
        : 'var(--accent-green)';
    }
    if (clarityBar) {
      const clarityPct = Math.min(100, (1 - (peak - rms)) * 100);
      clarityBar.style.width = `${clarityPct}%`;
    }

    // Update stats
    const rmsEl = document.getElementById('calRMS');
    const peakEl = document.getElementById('calPeak');
    if (rmsEl) rmsEl.textContent = rms.toFixed(3);
    if (peakEl) peakEl.textContent = peak.toFixed(3);

    // Draw waveform
    const canvas = this.containerEl.querySelector('canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      ctx.fillStyle = 'rgba(0,0,0,0.05)';
      ctx.fillRect(0, 0, width, height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'var(--accent-blue)';
      ctx.beginPath();

      const sliceWidth = width / this.dataArray.length;
      let x = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        const v = this.dataArray[i] / 128.0;
        const y = v * height / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
    }

    this.animationFrame = requestAnimationFrame(() => this.animate());
  }
}

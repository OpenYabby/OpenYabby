"""
Yabby — Speaker Verification Microservice

FastAPI + SpeechBrain ECAPA-TDNN for speaker enrollment and verification.
Runs on port 3001 by default.

Usage:
    cd speaker
    pip install -r requirements.txt
    uvicorn app:app --port 3001
"""

import os
import io
import numpy as np
import torch
import soundfile as sf
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Yabby Speaker Verification")

# ─── Config ───────────────────────────────────────────────

DATA_DIR = Path(os.getenv("SPEAKER_DATA_DIR", os.path.join(os.path.dirname(__file__), "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

ENROLLMENT_FILE = DATA_DIR / "enrollment.npy"
COSINE_THRESHOLD = float(os.getenv("SPEAKER_THRESHOLD", "0.25"))

# ─── Model (lazy-loaded) ─────────────────────────────────

_classifier = None

def get_classifier():
    global _classifier
    if _classifier is None:
        from speechbrain.inference.speaker import EncoderClassifier
        _classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(DATA_DIR / "pretrained_ecapa"),
            run_opts={"device": "cpu"},
        )
    return _classifier


def extract_embedding(audio_bytes: bytes) -> np.ndarray:
    """Extract speaker embedding from WAV audio bytes."""
    # Use soundfile directly to avoid torchaudio backend issues
    audio_data, sr = sf.read(io.BytesIO(audio_bytes))

    # Convert to torch tensor
    waveform = torch.from_numpy(audio_data).float()

    # Ensure 2D shape (channels, samples)
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0)
    else:
        waveform = waveform.T  # soundfile returns (samples, channels), we need (channels, samples)

    # Mono - average channels if needed
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)

    # Resample to 16kHz if needed
    if sr != 16000:
        import torchaudio
        resampler = torchaudio.transforms.Resample(sr, 16000)
        waveform = resampler(waveform)

    classifier = get_classifier()
    embedding = classifier.encode_batch(waveform)
    return embedding.squeeze().cpu().numpy()


# ─── Endpoints ────────────────────────────────────────────

@app.get("/status")
async def status():
    enrolled = ENROLLMENT_FILE.exists()
    return {"enrolled": enrolled}


@app.post("/enroll")
async def enroll(samples: list[UploadFile] = File(...)):
    if len(samples) < 3:
        raise HTTPException(status_code=400, detail="At least 3 samples required")

    embeddings = []
    for sample in samples:
        audio_bytes = await sample.read()
        if len(audio_bytes) < 1000:
            raise HTTPException(status_code=400, detail=f"Sample {sample.filename} too short")
        emb = extract_embedding(audio_bytes)
        embeddings.append(emb)

    # Average embedding = speaker profile
    profile = np.mean(embeddings, axis=0)
    profile = profile / np.linalg.norm(profile)  # normalize

    np.save(str(ENROLLMENT_FILE), profile)

    return {
        "enrolled": True,
        "samples_used": len(embeddings),
        "embedding_dim": len(profile),
    }


@app.post("/verify")
async def verify(audio: UploadFile = File(...)):
    if not ENROLLMENT_FILE.exists():
        return {"verified": True, "reason": "not_enrolled"}

    audio_bytes = await audio.read()
    if len(audio_bytes) < 1000:
        raise HTTPException(status_code=400, detail="Audio too short")

    test_emb = extract_embedding(audio_bytes)
    test_emb = test_emb / np.linalg.norm(test_emb)

    profile = np.load(str(ENROLLMENT_FILE))
    similarity = float(np.dot(profile, test_emb))

    return {
        "verified": similarity >= COSINE_THRESHOLD,
        "similarity": round(similarity, 4),
        "threshold": COSINE_THRESHOLD,
    }


@app.post("/verify-raw")
async def verify_raw(request: Request):
    """Accept raw audio bytes (not multipart) for wake word verification"""
    if not ENROLLMENT_FILE.exists():
        return {"verified": True, "reason": "not_enrolled"}

    audio_bytes = await request.body()
    if len(audio_bytes) < 1000:
        raise HTTPException(status_code=400, detail="Audio too short")

    test_emb = extract_embedding(audio_bytes)
    test_emb = test_emb / np.linalg.norm(test_emb)

    profile = np.load(str(ENROLLMENT_FILE))
    similarity = float(np.dot(profile, test_emb))

    return {
        "verified": similarity >= COSINE_THRESHOLD,
        "similarity": round(similarity, 4),
        "threshold": COSINE_THRESHOLD,
    }


@app.delete("/enroll")
async def clear_enrollment():
    if ENROLLMENT_FILE.exists():
        ENROLLMENT_FILE.unlink()
    return {"enrolled": False, "cleared": True}


# ─── Health ───────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "model": "ecapa-tdnn"}

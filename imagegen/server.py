"""
Yabby — Image Generation Sidecar

FastAPI service for local image generation using diffusers + PyTorch MPS.
Runs on port 3002, mirrors the speaker/ sidecar pattern.
"""

import io
import os
import time
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field
from typing import Optional

app = FastAPI(title="Yabby Image Generation")

# ─── Config ───────────────────────────────────────────────

DEFAULT_MODEL = os.getenv("IMAGEGEN_DEFAULT_MODEL", "stabilityai/sdxl-turbo")
MAX_QUEUE_DEPTH = int(os.getenv("IMAGEGEN_MAX_QUEUE", "3"))

# ─── Model Manager (lazy-loaded) ─────────────────────────

_model_manager = None
_generation_semaphore = asyncio.Semaphore(1)  # one generation at a time
_queue_depth = 0


def get_model_manager():
    global _model_manager
    if _model_manager is None:
        from models import ModelManager
        _model_manager = ModelManager()
    return _model_manager


# ─── Request/Response Models ─────────────────────────────

class GenerateRequest(BaseModel):
    prompt: str
    model: Optional[str] = None
    steps: Optional[int] = Field(default=4, ge=1, le=50)
    width: Optional[int] = Field(default=1024, ge=256, le=2048)
    height: Optional[int] = Field(default=1024, ge=256, le=2048)
    seed: Optional[int] = None
    negative_prompt: Optional[str] = None


class LoadRequest(BaseModel):
    model: str


# ─── Endpoints ────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "imagegen"}


@app.get("/status")
async def status():
    mgr = get_model_manager()
    return {
        "ready": mgr.is_loaded(),
        "model": mgr.current_model_id,
        "queue_depth": _queue_depth,
        "max_queue_depth": MAX_QUEUE_DEPTH,
        "models_available": mgr.list_models(),
    }


@app.get("/models")
async def list_models():
    mgr = get_model_manager()
    return mgr.list_models()


@app.post("/generate")
async def generate(req: GenerateRequest):
    global _queue_depth

    if _queue_depth >= MAX_QUEUE_DEPTH:
        raise HTTPException(status_code=429, detail="Generation queue full, please retry")

    _queue_depth += 1
    try:
        async with _generation_semaphore:
            mgr = get_model_manager()
            model_id = req.model or DEFAULT_MODEL

            # Ensure model is loaded
            if not mgr.is_loaded() or mgr.current_model_id != model_id:
                print(f"[ImageGen] Loading model: {model_id}")
                mgr.load(model_id)

            start = time.time()
            print(f"[ImageGen] Generating: '{req.prompt[:80]}' model={model_id} steps={req.steps} {req.width}x{req.height}")

            img = await asyncio.to_thread(
                mgr.generate,
                prompt=req.prompt,
                steps=req.steps,
                width=req.width,
                height=req.height,
                seed=req.seed,
                negative_prompt=req.negative_prompt,
            )

            elapsed_ms = int((time.time() - start) * 1000)
            print(f"[ImageGen] Generated in {elapsed_ms}ms")

            # Convert PIL Image to PNG bytes
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            png_bytes = buf.getvalue()

            return Response(
                content=png_bytes,
                media_type="image/png",
                headers={
                    "X-Elapsed-Ms": str(elapsed_ms),
                    "X-Model": model_id,
                    "X-Prompt": req.prompt[:200],
                },
            )
    finally:
        _queue_depth -= 1


@app.post("/load")
async def load_model(req: LoadRequest):
    mgr = get_model_manager()
    try:
        mgr.load(req.model)
        return {"loaded": True, "model": req.model}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
async def unload_model():
    mgr = get_model_manager()
    mgr.unload()
    return {"unloaded": True}

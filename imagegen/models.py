"""
Model manager — abstracts diffusers pipeline loading, generation, and unloading.

Supports any HuggingFace diffusers model that works with AutoPipelineForText2Image.
Default: SDXL-Turbo (stabilityai/sdxl-turbo) — 4 steps, no guidance, ~2s on M2 Pro.
"""

import os
import gc
import torch
from typing import Optional
from PIL import Image


MODEL_CATALOG = {
    "stabilityai/sdxl-turbo": {
        "label": "SDXL-Turbo",
        "default_steps": 4,
        "guidance_scale": 0.0,
        "default_width": 512,
        "default_height": 512,
        "notes": "Fast, 1-4 steps, best at 512x512",
    },
    "stabilityai/stable-diffusion-xl-base-1.0": {
        "label": "SDXL 1.0",
        "default_steps": 30,
        "guidance_scale": 7.5,
        "default_width": 1024,
        "default_height": 1024,
        "notes": "High quality, 20-50 steps, 1024x1024",
    },
}


class ModelManager:
    def __init__(self):
        self.pipe = None
        self.current_model_id = None
        self._device = self._detect_device()

    def _detect_device(self):
        if torch.backends.mps.is_available():
            return "mps"
        elif torch.cuda.is_available():
            return "cuda"
        return "cpu"

    def is_loaded(self):
        return self.pipe is not None

    def list_models(self):
        result = []
        for model_id, info in MODEL_CATALOG.items():
            result.append({
                "id": model_id,
                "label": info["label"],
                "loaded": self.current_model_id == model_id,
                "default_steps": info["default_steps"],
                "notes": info.get("notes", ""),
            })
        return result

    def load(self, model_id: str):
        if self.pipe and self.current_model_id == model_id:
            return
        self.unload()
        from diffusers import AutoPipelineForText2Image
        print(f"[ModelManager] Loading {model_id} on {self._device} (float16)...")
        self.pipe = AutoPipelineForText2Image.from_pretrained(
            model_id,
            torch_dtype=torch.float16,
            variant="fp16",
            cache_dir=os.path.join(os.path.dirname(__file__), "data"),
        )
        self.pipe = self.pipe.to(self._device)
        self.current_model_id = model_id
        print(f"[ModelManager] {model_id} loaded on {self._device}")

    def unload(self):
        if self.pipe:
            del self.pipe
            self.pipe = None
            self.current_model_id = None
            gc.collect()
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
            elif torch.cuda.is_available():
                torch.cuda.empty_cache()
            print("[ModelManager] Model unloaded, memory freed")

    def generate(
        self,
        prompt: str,
        steps: int = 4,
        width: int = 512,
        height: int = 512,
        seed: Optional[int] = None,
        negative_prompt: Optional[str] = None,
    ) -> Image.Image:
        if not self.pipe:
            raise RuntimeError("No model loaded. Call load() first.")
        catalog = MODEL_CATALOG.get(self.current_model_id, {})
        guidance = catalog.get("guidance_scale", 7.5)
        generator = None
        if seed is not None:
            generator = torch.Generator(device=self._device).manual_seed(seed)
        result = self.pipe(
            prompt=prompt,
            num_inference_steps=steps,
            width=width,
            height=height,
            guidance_scale=guidance,
            negative_prompt=negative_prompt if guidance > 0 else None,
            generator=generator,
        )
        return result.images[0]

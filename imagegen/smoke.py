#!/usr/bin/env python3
"""
Smoke test for the image generation sidecar.
Loads the default model, generates one image, and writes smoke.png.

Usage:
    cd imagegen
    source venv/bin/activate
    python smoke.py
"""

import sys
import time

def main():
    from models import ModelManager

    model_id = "stabilityai/sdxl-turbo"
    print(f"[Smoke] Loading {model_id}...")
    start = time.time()

    mgr = ModelManager()
    mgr.load(model_id)
    load_time = time.time() - start
    print(f"[Smoke] Model loaded in {load_time:.1f}s on {mgr._device}")

    print("[Smoke] Generating test image...")
    gen_start = time.time()
    img = mgr.generate(
        prompt="a cute orange tabby cat sitting on a windowsill, watercolor style",
        steps=4,
        width=512,
        height=512,
        seed=42,
    )
    gen_time = time.time() - gen_start
    print(f"[Smoke] Generated in {gen_time:.1f}s")

    img.save("smoke.png")
    print(f"[Smoke] Saved smoke.png ({img.size[0]}x{img.size[1]})")

    mgr.unload()
    print("[Smoke] Done!")

if __name__ == "__main__":
    main()

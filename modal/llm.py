"""yAI 3 Coder on Modal (serverless GPUs that scale to zero): an OpenAI-compatible vLLM server per model.

    modal deploy modal/llm.py

Each function becomes a URL like https://<workspace>--yai-llm-coder.modal.run; the site talks to <URL>/v1.
Model weights live in a Modal Volume, so a cold start loads them from disk instead of downloading them again.
Image and video generation stay on RunPod (lib/images.js).

yAI Q3.8 Max moved to a Modal shared endpoint billed per token (2026-10-21), so the coder is the only model here.
"""

import os
import subprocess

import modal

app = modal.App("yai-llm")

# vLLM on a CUDA base image; weights and vLLM's compile cache persist in volumes across cold starts.
image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu24.04", add_python="3.12")
    .entrypoint([])
    .pip_install("vllm", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "YAI_MAX_MODEL": os.environ.get("YAI_MAX_MODEL", "")})
)
hf_cache = modal.Volume.from_name("yai-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("yai-vllm-cache", create_if_missing=True)
VOLUMES = {"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache}
# VLLM_API_KEY: the key the site sends (Authorization: Bearer ...). Create it once with `modal secret create`.
SECRETS = [modal.Secret.from_name("yai-vllm")]
PORT = 8000
IDLE_SECONDS = 300  # how long a GPU stays up after the last request (billed); 60 s meant a cold start after most pauses


def serve(model: str, name: str, max_len: int, extra: list[str] | None = None) -> None:
    cmd = [
        "vllm", "serve", model,
        "--served-model-name", name,
        "--host", "0.0.0.0", "--port", str(PORT),
        "--api-key", os.environ["VLLM_API_KEY"],
        "--max-model-len", str(max_len),
        "--gpu-memory-utilization", "0.92",
        "--enable-prefix-caching",
        *(extra or []),
    ]
    subprocess.Popen(cmd)


# Qwen3 Coder 30B (FP8, ~31 GB): yAI Code's default model. 64k context fits beside it on a 48 GB L40S.
@app.function(image=image, gpu="L40S", volumes=VOLUMES, secrets=SECRETS, scaledown_window=IDLE_SECONDS, timeout=60 * 60)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=PORT, startup_timeout=15 * 60)
def coder():
    serve("Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", "qwen3-coder", 65536)


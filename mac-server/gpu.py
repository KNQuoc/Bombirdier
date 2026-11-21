"""One thread for everything that runs on the GPU (Whisper and Kokoro, both MLX).

MLX work is tied to the thread it started on, and two models shouldn't fight over the GPU, so all of
it goes through this single worker: one job at a time, always the same thread.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor

executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")


async def run(fn, *args):
    """Runs fn(*args) on the GPU thread without blocking the server."""
    return await asyncio.get_running_loop().run_in_executor(executor, fn, *args)

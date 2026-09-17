"""Time one vision call per model on a saved kiosk photo. Usage: python scripts/probe_vision.py <image> <model> [<model>...]"""
import base64, json, sys, time
from openai import OpenAI
sys.path.insert(0, ".")
from app.pipeline import VISION_PROMPT

img = sys.argv[1]
b64 = base64.b64encode(open(img, "rb").read()).decode()
client = OpenAI(api_key="ollama", base_url="http://127.0.0.1:11434/v1/")
for model in sys.argv[2:]:
    t = time.time()
    try:
        r = client.chat.completions.create(
            model=model, temperature=0.2, max_tokens=700,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": VISION_PROMPT.format(kind="marks")},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}],
        )
        c = r.choices[0]
        print(f"== {model}: {time.time()-t:.1f}s finish={c.finish_reason} tokens={r.usage.completion_tokens if r.usage else '?'}")
        print((c.message.content or "")[:900])
    except Exception as e:
        print(f"== {model}: {time.time()-t:.1f}s ERROR {e}")

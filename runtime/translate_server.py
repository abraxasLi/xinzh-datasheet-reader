"""本机离线英中翻译服务（Argos 模型包 + CTranslate2 精简运行时）。

只监听 127.0.0.1，只在本机推理；不联网、不回退到任何远程服务。
  GET  /health   -> {"ready": true, "load_ms": ..., "model": ...}
  POST /translate {"texts": ["...", "..."]} -> {"items": [{"text": "...", "ms": 12.3}, ...]}
"""
import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ctranslate2
import sentencepiece as spm


class Translator:
    def __init__(self, model_dir, sp_model=None, compute_type="int8", threads=4, beam_size=1):
        started = time.perf_counter()
        # CTranslate2 / SentencePiece 的 C++ 实现用 std::ifstream 打开模型文件，
        # 在 Windows 上无法处理非 ASCII 绝对路径（本项目目录名是中文）。
        # 先切到模型父目录，再用相对路径传入，避开这个限制。
        model_dir = os.path.abspath(model_dir)
        os.chdir(os.path.dirname(model_dir))
        model_dir = os.path.basename(model_dir)

        candidates = []
        if sp_model:
            candidates.append(os.path.relpath(os.path.abspath(sp_model), os.getcwd()))
        candidates += ["sentencepiece.model", os.path.join("..", "sentencepiece.model")]
        tokenizer_path = next((p for p in candidates if os.path.exists(p)), None)
        if not tokenizer_path:
            raise SystemExit("找不到 sentencepiece.model")

        self.sp = spm.SentencePieceProcessor()
        if not self.sp.load(tokenizer_path):
            raise SystemExit(f"无法加载分词模型: {tokenizer_path}")
        self.translator = ctranslate2.Translator(
            model_dir,
            device="cpu",
            compute_type=compute_type,
            inter_threads=1,
            intra_threads=threads,
        )
        self.beam_size = beam_size
        self.compute_type = compute_type
        self.threads = threads
        self.tokenizer_path = tokenizer_path
        self.load_ms = (time.perf_counter() - started) * 1000

    def translate(self, text):
        tokens = self.sp.encode(text, out_type=str)
        results = self.translator.translate_batch(
            [tokens], beam_size=self.beam_size, replace_unknowns=False
        )
        output = self.sp.decode(results[0].hypotheses[0])
        # SentencePiece 用 "▁" 表示词边界，解码后会有残留，清掉再交给界面。
        output = output.replace("▁", " ").strip()
        return output, len(tokens)


def make_handler(engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 安静：只写 stderr
            sys.stderr.write("translate_server: " + (fmt % args) + "\n")

        def send_json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != "/health":
                self.send_json(404, {"error": "not found"})
                return
            self.send_json(200, {
                "ready": True,
                "load_ms": round(engine.load_ms, 1),
                "compute_type": engine.compute_type,
                "threads": engine.threads,
                "tokenizer": os.path.basename(engine.tokenizer_path),
            })

        def do_POST(self):
            if self.path != "/translate":
                self.send_json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                texts = payload.get("texts") or []
                if not isinstance(texts, list) or not texts:
                    self.send_json(400, {"error": "texts 必须是非空数组"})
                    return
                items = []
                for text in texts:
                    text = (text or "").strip()
                    if not text:
                        items.append({"text": "", "ms": 0, "tokens": 0})
                        continue
                    begin = time.perf_counter()
                    output, tokens = engine.translate(text)
                    items.append({
                        "text": output,
                        "ms": round((time.perf_counter() - begin) * 1000, 1),
                        "tokens": tokens,
                    })
                self.send_json(200, {"items": items})
            except Exception as error:  # noqa: BLE001
                self.send_json(500, {"error": str(error)})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--sp-model", default=None)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--beam-size", type=int, default=1)
    args = parser.parse_args()

    engine = Translator(args.model_dir, args.sp_model, args.compute_type, args.threads, args.beam_size)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine))
    print(f"ready on http://{args.host}:{args.port} load_ms={engine.load_ms:.1f}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

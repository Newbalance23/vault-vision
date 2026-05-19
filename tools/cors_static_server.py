import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class CorsHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="Serve a local folder with permissive CORS headers.")
    parser.add_argument("directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4174)
    args = parser.parse_args()

    os.chdir(args.directory)
    ThreadingHTTPServer((args.host, args.port), CorsHandler).serve_forever()


if __name__ == "__main__":
    main()

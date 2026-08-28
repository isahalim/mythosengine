#!/usr/bin/env python3
"""Fixture standing in for the yt-dlp binary in YtDlpDownloadDriver's tests."""
import json
import sys

if "--dump-json" in sys.argv:
    print(json.dumps({"id": "abc123", "duration": 30}))
    sys.exit(0)

# Download mode: find the -o template arg and write a dummy file next to it.
out_index = sys.argv.index("-o") + 1
out_template = sys.argv[out_index]
out_path = out_template.replace("%(ext)s", "mp4")
with open(out_path, "wb") as f:
    f.write(b"fake-mp4-bytes")

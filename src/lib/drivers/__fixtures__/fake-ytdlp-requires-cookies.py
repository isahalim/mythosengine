#!/usr/bin/env python3
"""Fixture simulating YouTube's bot-check: succeeds only when --cookies is passed."""
import json
import sys

if "--cookies" not in sys.argv:
    print("ERROR: Sign in to confirm you're not a bot.", file=sys.stderr)
    sys.exit(1)

if "--dump-json" in sys.argv:
    print(json.dumps({"id": "abc123", "duration": 30}))
    sys.exit(0)

out_index = sys.argv.index("-o") + 1
out_template = sys.argv[out_index]
out_path = out_template.replace("%(ext)s", "mp4")
with open(out_path, "wb") as f:
    f.write(b"fake-mp4-bytes")

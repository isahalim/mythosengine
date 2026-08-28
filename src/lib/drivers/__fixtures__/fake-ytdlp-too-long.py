#!/usr/bin/env python3
"""Fixture: metadata reports a video far longer than any sane maxDurationS."""
import json
import sys

if "--dump-json" in sys.argv:
    print(json.dumps({"id": "long-video", "duration": 14400}))  # 4 hours
    sys.exit(0)

sys.stderr.write("fake-ytdlp-too-long: download should never be reached\n")
sys.exit(1)

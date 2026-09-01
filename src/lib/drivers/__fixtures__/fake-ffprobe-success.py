#!/usr/bin/env python3
"""Fixture standing in for ffprobe: reports a fixed duration, and a fixed
loop shape when asked to count a stream's frames.

The driver probes for two different things -- the finished render's
duration, and the character loop's frame rate and length -- so the fixture
answers on the same flag the real binary would: `-count_frames` means the
question is about the stream, not the container."""
import json
import sys

if "-count_frames" in sys.argv:
    # The real asset's shape: 70 frames at 12.5fps.
    print(json.dumps({"streams": [{"r_frame_rate": "25/2", "nb_read_frames": "70"}]}))
else:
    print(json.dumps({"format": {"duration": "12.34"}}))

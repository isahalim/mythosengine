#!/usr/bin/env python3
"""Fixture standing in for ffmpeg, recording how it was called.

The driver invokes ffmpeg twice when the character has holds -- once to
derive her held loop, once to render -- and the argument wiring between the
two is the thing worth testing: which file is looped, with which flag. This
writes one JSON array per invocation to $FFMPEG_ARGV_LOG, and still writes
the output file so the driver's success path runs to the end."""
import json
import os
import sys

log = os.environ.get("FFMPEG_ARGV_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps(sys.argv[1:]) + "\n")

output_path = sys.argv[-1]
with open(output_path, "wb") as f:
    f.write(b"fake-bytes")

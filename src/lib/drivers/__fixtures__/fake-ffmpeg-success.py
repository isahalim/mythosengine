#!/usr/bin/env python3
"""Fixture standing in for the ffmpeg binary in FfmpegRenderDriver's tests.
The real render logic (ass-subtitles.ts) is tested separately as a pure
function -- this fixture just proves the driver wires arguments/files
correctly and handles ffmpeg's success/failure contract."""
import sys

output_path = sys.argv[-1]
with open(output_path, "wb") as f:
    f.write(b"fake-mp4-bytes")

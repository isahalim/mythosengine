#!/usr/bin/env python3
"""Fixture: simulates ffmpeg failing (bad filtergraph, missing codec, etc)."""
import sys

sys.stderr.write("fake-ffmpeg-fail: simulated encode failure\n")
sys.exit(1)

#!/usr/bin/env python3
"""Fixture: writes audio fine, but malformed JSON timings."""
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--text", required=True)
parser.add_argument("--voice", required=True)
parser.add_argument("--out-audio", required=True)
parser.add_argument("--out-timings", required=True)
parser.add_argument("--rate")
parser.add_argument("--volume")
parser.add_argument("--pitch")
args = parser.parse_args()

with open(args.out_audio, "wb") as f:
    f.write(b"\xff\xfb\x90fake-mp3-bytes")

with open(args.out_timings, "w") as f:
    f.write("{not valid json")

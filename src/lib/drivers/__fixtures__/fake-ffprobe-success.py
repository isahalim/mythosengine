#!/usr/bin/env python3
"""Fixture standing in for ffprobe: reports a fixed duration."""
import json

print(json.dumps({"format": {"duration": "12.34"}}))

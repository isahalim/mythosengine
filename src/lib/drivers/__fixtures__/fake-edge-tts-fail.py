#!/usr/bin/env python3
"""Fixture: simulates a transient failure (e.g. Microsoft's endpoint 403ing)."""
import sys

print("edge_tts_synth: simulated network failure", file=sys.stderr)
sys.exit(1)

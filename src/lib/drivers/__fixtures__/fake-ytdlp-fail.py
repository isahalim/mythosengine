#!/usr/bin/env python3
"""Fixture: simulates a transient failure at the metadata stage."""
import sys

sys.stderr.write("fake-ytdlp-fail: simulated network failure\n")
sys.exit(1)

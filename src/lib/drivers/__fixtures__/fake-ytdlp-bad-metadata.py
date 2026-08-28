#!/usr/bin/env python3
"""Fixture: --dump-json prints malformed JSON."""
import sys

if "--dump-json" in sys.argv:
    print("{not valid json")
    sys.exit(0)

sys.exit(1)

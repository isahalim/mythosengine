#!/usr/bin/env python3
"""Fixture: metadata is fine, but the "download" writes nothing."""
import json
import sys

if "--dump-json" in sys.argv:
    print(json.dumps({"id": "abc123", "duration": 30}))
    sys.exit(0)

# download mode: exit 0 without writing a file

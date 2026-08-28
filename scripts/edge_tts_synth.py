#!/usr/bin/env python3
"""
Thin wrapper around the `edge_tts` library (LGPL-3.0, github.com/rany2/edge-tts)
requesting WordBoundary events explicitly -- the bare `edge-tts` CLI hard-codes
SentenceBoundary and exposes no flag to change that, so this exists specifically
to get word-level timing for AutoShorts AI's captions.

Invoked as a subprocess from src/lib/drivers/tts-edge.ts via node:child_process.
This is process invocation, not a code import into the TypeScript codebase --
see docs/DECISIONS.md for why that distinction mattered for the licensing call.

Usage:
  edge_tts_synth.py --text "..." --voice en-US-AndrewNeural \
    --out-audio out.mp3 --out-timings out.json \
    [--rate +0%] [--volume +0%] [--pitch +0Hz]

Writes the synthesized audio to --out-audio and a JSON array of
{word, offsetMs, durationMs} to --out-timings. Exits non-zero with a message
on stderr on any failure -- never partial/silent output.
"""

import argparse
import asyncio
import json
import sys

import edge_tts


async def synth(args: argparse.Namespace) -> None:
    communicate = edge_tts.Communicate(
        args.text,
        args.voice,
        rate=args.rate,
        volume=args.volume,
        pitch=args.pitch,
        boundary="WordBoundary",
    )

    timings = []
    with open(args.out_audio, "wb") as audio_file:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_file.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                timings.append(
                    {
                        "word": chunk["text"],
                        # offset/duration arrive in 100-nanosecond units.
                        "offsetMs": chunk["offset"] / 10_000,
                        "durationMs": chunk["duration"] / 10_000,
                    }
                )

    if len(timings) == 0:
        print("edge_tts_synth: no WordBoundary events received", file=sys.stderr)
        sys.exit(1)

    with open(args.out_timings, "w", encoding="utf-8") as timings_file:
        json.dump(timings, timings_file)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--out-audio", required=True)
    parser.add_argument("--out-timings", required=True)
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--volume", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    args = parser.parse_args()

    try:
        asyncio.run(synth(args))
    except Exception as exc:  # noqa: BLE001 -- report and exit non-zero, never swallow
        print(f"edge_tts_synth: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

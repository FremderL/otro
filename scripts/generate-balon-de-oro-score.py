#!/usr/bin/env python3
"""Generate a restrained, royalty-free 45-second ceremony score using stdlib only."""
from array import array
import math
from pathlib import Path
import wave

RATE = 22_050
DURATION = 45.0
BPM = 72
BAR = 4 * 60 / BPM
FRAMES = round(RATE * DURATION)
OUT = Path(__file__).resolve().parents[1] / "public/assets/ballon-dor-ceremony-theme.wav"

# A gentle D-minor to F-major arc: warm sustained chords, sparse high notes,
# and no synthetic drum hits or vocals. The cue is deliberately quiet under speech.
CHORDS = [
    (146.83, 174.61, 220.00, 293.66),  # Dm(add9)
    (116.54, 146.83, 174.61, 220.00),  # Bbmaj7
    (87.31, 110.00, 130.81, 164.81),   # Fmaj7
    (130.81, 164.81, 196.00, 261.63),  # Csus2
]
MELODY = (440.00, 392.00, 349.23, 329.63, 293.66, 349.23, 392.00, 440.00,
          523.25, 440.00, 392.00, 349.23, 329.63, 293.66)


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def render() -> None:
    mix = array("f", [0.0]) * FRAMES
    for index in range(FRAMES):
        t = index / RATE
        bar_index = int(t / BAR)
        position = t - bar_index * BAR
        chord = CHORDS[bar_index % len(CHORDS)]
        edge = min(position / 0.72, (BAR - position) / 0.72, 1.0)
        envelope = smoothstep(edge)
        # Slow movement keeps the bed from sounding like a rigid, bright loop.
        swell = 0.92 + 0.08 * math.sin(2 * math.pi * 0.075 * t)
        pad = 0.0
        for note in chord:
            phase = 2 * math.pi * note * t
            # Rounded fundamentals and restrained harmonics approximate a soft string pad.
            pad += (0.72 * math.sin(phase)
                    + 0.18 * math.sin(2 * phase + 0.12)
                    + 0.07 * math.sin(3 * phase + 0.23)
                    + 0.16 * math.sin(2 * math.pi * (note + 0.32) * t))
        pad /= len(chord)
        sub = math.sin(2 * math.pi * (chord[0] / 2) * t) * 0.16

        # One quiet bell tone per bar, with a long decay rather than a sharp attack.
        local_beat = (t % BAR)
        bell = 0.0
        bell_start = 0.92
        bell_elapsed = local_beat - bell_start
        if 0.0 <= bell_elapsed < 2.25:
            bell_env = math.exp(-bell_elapsed / 0.82) * min(1.0, bell_elapsed / 0.09)
            frequency = MELODY[bar_index % len(MELODY)]
            bell = bell_env * (math.sin(2 * math.pi * frequency * bell_elapsed)
                               + 0.10 * math.sin(4 * math.pi * frequency * bell_elapsed))

        # Soft, non-percussive low swell at the start of the final bars.
        low_swell = 0.0
        if bar_index in (0, 4, 8, 12):
            elapsed = t - bar_index * BAR
            if 0.0 <= elapsed < 1.4:
                low_swell = 0.08 * math.sin(2 * math.pi * (52 - 8 * elapsed) * elapsed) * math.exp(-2.5 * elapsed)

        mix[index] = envelope * swell * (0.62 * pad + 0.12 * sub) + 0.024 * bell + low_swell

    # A small, soft room reflection adds depth without a loud wash.
    dry = mix[:]
    for delay_seconds, gain in ((0.19, 0.12), (0.37, 0.075), (0.61, 0.035)):
        delay = round(delay_seconds * RATE)
        for index in range(delay, FRAMES):
            mix[index] += dry[index - delay] * gain

    # Keep headroom for the narration and smooth the endpoints.
    peak = max(abs(value) for value in mix) or 1.0
    scale = min(0.27 / peak, 1.0)
    pcm = array("h")
    fade_in = round(1.4 * RATE)
    fade_out = round(2.2 * RATE)
    for index, value in enumerate(mix):
        t = index / RATE
        fade = min(1.0, index / max(1, fade_in), (FRAMES - 1 - index) / max(1, fade_out))
        sample = max(-1.0, min(1.0, value * scale * max(0.0, fade)))
        pcm.append(round(sample * 32767))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(RATE)
        writer.writeframes(pcm.tobytes())
    print(f"Wrote {OUT} ({DURATION:.0f}s, {OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    render()

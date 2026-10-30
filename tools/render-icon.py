#!/usr/bin/env python3
"""Render the DSH Attention beacon icon and the .icns used by the helper app.

A macOS-style blue squircle with a white attention bell, ring strokes and a coral
badge dot. Pure Pillow drawing — no external assets, reproducible at any time.
"""
from __future__ import annotations

import math
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 1024
CENTER_X = SIZE / 2

TOP_COLOR = (92, 115, 255)      # #5C73FF
BOTTOM_COLOR = (36, 45, 190)    # #242DBE
CORAL = (255, 91, 77, 255)      # #FF5B4D


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def background() -> Image.Image:
    """Diagonal blue gradient with a soft top-left highlight."""
    image = Image.new("RGB", (SIZE, SIZE), TOP_COLOR)
    pixels = image.load()
    for y in range(SIZE):
        t = y / (SIZE - 1)
        row = (
            int(lerp(TOP_COLOR[0], BOTTOM_COLOR[0], t)),
            int(lerp(TOP_COLOR[1], BOTTOM_COLOR[1], t)),
            int(lerp(TOP_COLOR[2], BOTTOM_COLOR[2], t)),
        )
        for x in range(SIZE):
            pixels[x, y] = row

    highlight = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(highlight)
    steps = 70
    for index in range(steps, 0, -1):
        t = index / steps
        radius = int(SIZE * 0.85 * t)
        alpha = int(40 * (1 - t) ** 2)
        draw.ellipse(
            (SIZE * 0.04 - radius, -radius, SIZE * 0.04 + radius, radius),
            fill=alpha,
        )
    white = Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    return Image.composite(white, image, highlight)


def squircle_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def quadratic(p0, p1, p2, steps: int):
    """Sample a quadratic bezier from p0 to p2 with control point p1."""
    points = []
    for index in range(steps + 1):
        t = index / steps
        inv = 1 - t
        x = inv * inv * p0[0] + 2 * inv * t * p1[0] + t * t * p2[0]
        y = inv * inv * p0[1] + 2 * inv * t * p1[1] + t * t * p2[1]
        points.append((x, y))
    return points


def bell_shape() -> Image.Image:
    """A bell silhouette: rounded dome, flaring sides and a clapper."""
    shoulder_y = 372.0
    shoulder_r = 138.0
    mouth_half = 250.0
    mouth_y = 648.0

    points = []
    # Dome: upper half of a circle.
    for index in range(49):
        angle = math.pi + math.pi * index / 48
        points.append((CENTER_X + shoulder_r * math.cos(angle), shoulder_y + shoulder_r * math.sin(angle)))
    # Right side, flaring outward.
    points += quadratic((CENTER_X + shoulder_r, shoulder_y), (CENTER_X + 158, 540), (CENTER_X + mouth_half, mouth_y), 26)
    # Mouth: a shallow downward bulge.
    points += quadratic((CENTER_X + mouth_half, mouth_y), (CENTER_X, mouth_y + 52), (CENTER_X - mouth_half, mouth_y), 40)
    # Left side, mirrored.
    points += quadratic((CENTER_X - mouth_half, mouth_y), (CENTER_X - 158, 540), (CENTER_X - shoulder_r, shoulder_y), 26)
    points.append(points[0])

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)

    # Smooth the silhouette a touch, then re-solidify so it stays crisp.
    mask = mask.filter(ImageFilter.GaussianBlur(1.4)).point(lambda value: 255 if value > 110 else 0)

    ImageDraw.Draw(mask).ellipse((CENTER_X - 42, 700, CENTER_X + 42, 784), fill=255)  # clapper

    white = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255))
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    layer.paste(white, (0, 0), mask)
    return layer


def ring_marks() -> Image.Image:
    """Three motion dashes on each side of the bell."""
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rows = ((395, 46, 220), (470, 74, 255), (545, 46, 220))
    thickness = 24
    for y, length, alpha in rows:
        draw.rounded_rectangle(
            (196, y, 196 + length, y + thickness),
            radius=thickness / 2,
            fill=(255, 255, 255, alpha),
        )
        draw.rounded_rectangle(
            (SIZE - 196 - length, y, SIZE - 196, y + thickness),
            radius=thickness / 2,
            fill=(255, 255, 255, alpha),
        )
    return layer


def badge_dot() -> Image.Image:
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    box = (786 - 112, 224 - 112, 786 + 112, 224 + 112)
    draw.ellipse(box, fill=CORAL)
    draw.ellipse(box, outline=(255, 255, 255, 240), width=24)
    return layer


def build_icon() -> Image.Image:
    base = background()
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), squircle_mask(SIZE, 232))

    marks = ring_marks()
    bell = bell_shape()

    shadow = bell.split()[3].filter(ImageFilter.GaussianBlur(20))
    shadow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shadow_layer.paste(Image.new("RGBA", (SIZE, SIZE), (10, 16, 90, 130)), (0, 18), shadow)

    icon.alpha_composite(marks)
    icon.alpha_composite(shadow_layer)
    icon.alpha_composite(bell)
    icon.alpha_composite(badge_dot())

    rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        (2, 2, SIZE - 3, SIZE - 3), radius=230, outline=(255, 255, 255, 40), width=5
    )
    icon.alpha_composite(rim)
    return icon


def write_icns(icon: Image.Image, destination: str) -> None:
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        iconset = os.path.join(temp, "AppIcon.iconset")
        os.makedirs(iconset)
        for size in (16, 32, 64, 128, 256, 512, 1024):
            icon.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}.png"))
            if size <= 512:
                icon.resize((size * 2, size * 2), Image.LANCZOS).save(
                    os.path.join(iconset, f"icon_{size}x{size}@2x.png")
                )
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", destination], check=True)


def main() -> int:
    icon = build_icon()
    docs = os.path.join(ROOT, "docs")
    os.makedirs(docs, exist_ok=True)
    icon.save(os.path.join(docs, "icon-1024.png"))
    write_icns(icon, os.path.join(ROOT, "bin", "DSH Attention.app", "Contents", "Resources", "AppIcon.icns"))
    print(f"rendered {os.path.join(docs, 'icon-1024.png')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

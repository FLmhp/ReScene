"""Decode bounded, single-frame avatars and discard their source metadata."""

from __future__ import annotations

import base64
import binascii
import io
import struct

from PIL import Image, ImageOps

_MAX_BYTES = 1024 * 1024
_MAX_PIXELS = 16_000_000
_SIZE = (192, 192)


class AvatarTooLarge(ValueError):
    """The supplied image exceeds a byte or pixel limit."""


class InvalidAvatar(ValueError):
    """The source is not a supported, decodable still image."""


def normalize_avatar(image_base64: str) -> bytes:
    """Apply orientation and center-crop a JPEG, PNG, or WebP to a small JPEG."""
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise InvalidAvatar("Avatar must be base64 without a data URI prefix") from error
    if len(raw) > _MAX_BYTES:
        raise AvatarTooLarge("Avatar must be at most 1 MiB")
    try:
        with Image.open(io.BytesIO(raw), formats=("JPEG", "PNG", "WEBP")) as image:
            if image.width * image.height > _MAX_PIXELS:
                raise AvatarTooLarge("Avatar must be at most 16 million pixels")
            if getattr(image, "n_frames", 1) != 1:
                raise InvalidAvatar("Avatar must contain a single frame")
            ImageOps.exif_transpose(image, in_place=True)
            transparent = "A" in image.getbands() or "transparency" in image.info
            mode = "RGBA" if transparent else "RGB"
            source = image if image.mode == mode else image.convert(mode)
            square = ImageOps.fit(source, _SIZE, Image.Resampling.LANCZOS)
            if transparent:
                canvas = Image.new("RGB", _SIZE, "white")
                canvas.paste(square, mask=square.getchannel("A"))
                square = canvas
            encoded = io.BytesIO()
            square.save(encoded, format="JPEG", quality=85)
            return encoded.getvalue()
    except Image.DecompressionBombError as error:
        raise AvatarTooLarge("Avatar must be at most 16 million pixels") from error
    except (AvatarTooLarge, InvalidAvatar):
        raise
    except (OSError, ValueError, SyntaxError, struct.error) as error:
        raise InvalidAvatar("Avatar must be a valid JPEG, PNG, or WebP") from error

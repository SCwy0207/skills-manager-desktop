"""Generate deterministic Skills Manager raster and Windows installer assets."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets" / "brand"
INSTALLER = ROOT / "src-tauri" / "installer-assets"

INK = (11, 19, 36)
INDIGO = (102, 118, 247)
INDIGO_DEEP = (48, 79, 210)
NAVY = (11, 25, 54)
TEAL = (89, 227, 207)
SIGNAL_TEAL = (22, 183, 177)
CLOUD = (245, 248, 253)
WHITE = (255, 255, 255)


def lerp(a: int, b: int, amount: float) -> int:
    return round(a + (b - a) * amount)


def gradient(size: tuple[int, int], start=SIGNAL_TEAL, middle=(83, 104, 237), end=NAVY) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            t = min(1.0, max(0.0, (x / max(1, width - 1) + y / max(1, height - 1)) / 2))
            if t < 0.56:
                u = t / 0.56
                colour = tuple(lerp(start[i], middle[i], u) for i in range(3))
            else:
                u = (t - 0.56) / 0.44
                colour = tuple(lerp(middle[i], end[i], u) for i in range(3))
            pixels[x, y] = colour
    return image


def draw_mark(canvas: Image.Image, box: tuple[int, int, int, int], *, with_background: bool = True) -> None:
    x0, y0, x1, y1 = box
    size = min(x1 - x0, y1 - y0)
    scale = size / 512
    draw = ImageDraw.Draw(canvas, "RGBA")

    def point(x: float, y: float) -> tuple[int, int]:
        return round(x0 + x * scale), round(y0 + y * scale)

    if with_background:
        tile = gradient((size, size)).convert("RGBA")
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((24 * scale, 24 * scale, 488 * scale, 488 * scale), radius=116 * scale, fill=255)
        canvas.paste(tile, (x0, y0), mask)

    outer = [point(296, 123), point(256, 100), point(128, 174), point(128, 338), point(256, 412), point(296, 389)]
    draw.line(outer, fill=(255, 255, 255, 122), width=max(1, round(24 * scale)), joint="curve")
    rails = [
        [point(218, 256), point(252, 256)],
        [point(252, 256), point(328, 164)],
        [point(252, 256), point(328, 256)],
        [point(252, 256), point(328, 348)],
    ]
    for rail in rails:
        draw.line(rail, fill=WHITE + (255,), width=max(1, round(22 * scale)), joint="curve")

    for x, y in ((326, 136), (326, 228), (326, 320)):
        draw.rounded_rectangle((*point(x, y), *point(x + 54, y + 56)), radius=round(16 * scale), fill=WHITE + (255,))

    cx, cy = point(176, 256)
    radius = round(42 * scale)
    ring = max(1, round(22 * scale))
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(20, 40, 89, 255), outline=TEAL + (255,), width=ring)
    dot = max(1, round(11 * scale))
    draw.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=WHITE + (255,))


def app_icon(size: int = 1024) -> Image.Image:
    supersample = 2
    image = Image.new("RGBA", (size * supersample, size * supersample), (0, 0, 0, 0))
    draw_mark(image, (0, 0, size * supersample, size * supersample))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    windows = Path("C:/Windows/Fonts")
    candidates = [
        windows / ("segoeuib.ttf" if bold else "segoeui.ttf"),
        windows / ("arialbd.ttf" if bold else "arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def lockup(dark: bool) -> Image.Image:
    background = INK if dark else CLOUD
    foreground = WHITE if dark else INK
    image = Image.new("RGBA", (1200, 360), background + (255,))
    draw_mark(image, (64, 48, 328, 312))
    draw = ImageDraw.Draw(image)
    draw.text((376, 108), "Skills", font=font(82, True), fill=foreground)
    skills_width = draw.textlength("Skills", font=font(82, True))
    draw.text((376 + round(skills_width) + 20, 108), "Manager", font=font(82), fill=foreground)
    draw.text((380, 214), "LOCAL-FIRST AGENT SKILLS WORKSPACE", font=font(24, True), fill=TEAL if dark else INDIGO_DEEP)
    return image


def abstract_relay(draw: ImageDraw.ImageDraw, width: int, height: int, colour: tuple[int, int, int, int]) -> None:
    hub_x = round(width * 0.32)
    hub_y = round(height * 0.5)
    stroke = max(2, round(width * 0.022))
    branch_x = round(width * 0.56)
    for end_y in (round(height * 0.24), round(height * 0.5), round(height * 0.76)):
        draw.line([(hub_x, hub_y), (branch_x, hub_y), (round(width * 0.84), end_y)], fill=colour, width=stroke)
    r = max(4, round(width * 0.045))
    draw.ellipse((hub_x-r, hub_y-r, hub_x+r, hub_y+r), fill=TEAL + (255,))


def installer_sidebar() -> Image.Image:
    image = gradient((164, 314), start=(18, 165, 160), middle=(72, 88, 224), end=INK).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    abstract_relay(ImageDraw.Draw(overlay), 164, 314, (255, 255, 255, 88))
    image.alpha_composite(overlay)
    draw_mark(image, (31, 28, 133, 130), with_background=False)
    draw = ImageDraw.Draw(image)
    draw.text((28, 258), "SKILLS", font=font(18, True), fill=WHITE)
    draw.text((28, 280), "MANAGER", font=font(13, True), fill=(202, 216, 255))
    return image.convert("RGB")


def installer_header(size: tuple[int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size, CLOUD + (255,))
    draw = ImageDraw.Draw(image, "RGBA")
    for idx in range(3):
        y = round(height * (0.28 + idx * 0.22))
        draw.line([(0, y), (round(width * 0.58), y), (round(width * 0.72), height // 2)], fill=INDIGO + (24 + idx * 12,), width=2)
    mark_size = min(height - 8, 48)
    draw_mark(image, (width - mark_size - 7, 4, width - 7, 4 + mark_size))
    return image.convert("RGB")


def wix_dialog() -> Image.Image:
    image = Image.new("RGBA", (493, 312), WHITE + (255,))
    left = gradient((164, 312), start=(18, 165, 160), middle=(72, 88, 224), end=INK).convert("RGBA")
    image.alpha_composite(left, (0, 0))
    overlay = Image.new("RGBA", (164, 312), (0, 0, 0, 0))
    abstract_relay(ImageDraw.Draw(overlay), 164, 312, (255, 255, 255, 72))
    image.alpha_composite(overlay, (0, 0))
    draw_mark(image, (33, 30, 131, 128), with_background=False)
    draw = ImageDraw.Draw(image)
    draw.line([(164, 0), (164, 312)], fill=(218, 225, 240), width=1)
    return image.convert("RGB")


def main() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    INSTALLER.mkdir(parents=True, exist_ok=True)

    icon = app_icon()
    icon.save(BRAND / "skills-manager-app-icon.png")
    lockup(False).save(BRAND / "skills-manager-lockup-light.png")
    lockup(True).save(BRAND / "skills-manager-lockup-dark.png")

    sidebar = installer_sidebar()
    sidebar.save(INSTALLER / "nsis-sidebar.bmp")
    sidebar.save(INSTALLER / "nsis-sidebar.png")
    installer_header((150, 57)).save(INSTALLER / "nsis-header.bmp")
    installer_header((493, 58)).save(INSTALLER / "wix-banner.bmp")
    wix_dialog().save(INSTALLER / "wix-dialog.bmp")


if __name__ == "__main__":
    main()

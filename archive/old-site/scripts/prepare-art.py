#!/usr/bin/env python3
"""资产管线：把弥音（猫耳少女）原图转成 WebP 多档尺寸。

原图不在仓库内（体积大，且属于既有项目 HSCL 的美术资产）；本脚本按需从 HSCL
读取并输出到 Web 静态目录，**产物入库**，因此克隆仓库后无需原图即可构建页面。

用法：python scripts/prepare-art.py [原图目录]
"""

from __future__ import annotations

import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
# 仓库位于工作区外层目录之下（SC2clud/site），既有项目 HSCL 与之同级；两种位置都认。
DEFAULT_SRC_CANDIDATES = [
    ROOT.parent.parent / 'HSCL' / 'ui' / 'public' / 'miyin',
    ROOT.parent / 'HSCL' / 'ui' / 'public' / 'miyin',
]
OUT_DIR = ROOT / 'crates' / 'sc2clud-web' / 'static' / 'art'

# name -> (源文件, 目标宽度列表)。宽度按「首屏预算」定：hero 480/960，吉祥物 240/480。
SOURCES: dict[str, tuple[str, list[int]]] = {
    # 宽度按实际展示尺寸的 1x/2x 取（原图本身只有 400–680 px，不放大）。
    'portrait': ('portrait.png', [160, 320]),
    'wink': ('wink.png', [260, 520]),
    'chibi': ('chibi.png', [80, 160]),
    'cry': ('cry.png', [120, 240]),
}

QUALITY = 82


def main() -> int:
    if len(sys.argv) > 1:
        src_dir = pathlib.Path(sys.argv[1])
    else:
        src_dir = next(
            (p for p in DEFAULT_SRC_CANDIDATES if p.is_dir()), DEFAULT_SRC_CANDIDATES[0]
        )
    if not src_dir.is_dir():
        print(f'原图目录不存在：{src_dir}', file=sys.stderr)
        print('提示：从既有项目复制 ui/public/miyin，或用参数指定目录。', file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    print(f'{"产物":<34}{"尺寸":>12}{"体积":>10}')
    for name, (filename, widths) in SOURCES.items():
        src = src_dir / filename
        if not src.is_file():
            print(f'缺少原图：{src}', file=sys.stderr)
            return 2
        image = Image.open(src).convert('RGBA')
        print(f'  {filename}: 原图 {image.width}x{image.height}')
        for width in widths:
            if width > image.width:
                print(f'    (跳过 {width}：原图宽度不足)')
                continue
            height = round(image.height * width / image.width)
            resized = image.resize((width, height), Image.LANCZOS)
            out = OUT_DIR / f'miyin-{name}-{width}.webp'
            resized.save(out, 'WEBP', quality=QUALITY, method=6)
            size = out.stat().st_size
            total += size
            print(f'  {out.name:<32}{f"{width}x{height}":>12}{size / 1024:>9.1f}K')
    print(f'合计 {total / 1024:.1f} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/bin/sh
# Turn the raw captures in docs/assets/.raw/ into the optimised files the README uses.
#
#   sh scripts/build-assets.sh [stills] [recording]      (default: both)
#
# stills     hero-{light,dark}.png, social-preview.png, shot-*-{light,dark}.png
#            from scripts/readme-brand.mjs and scripts/readme-shots.mjs
# recording  demo.gif (terminal) and live-{light,dark}.gif (the project page during the same
#            session) from scripts/record-demo.sh
#
# Needs: ffmpeg, gifsicle, pngquant, oxipng (brew install ffmpeg gifsicle pngquant oxipng).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/docs/assets"
RAW="$OUT/.raw"
WHAT=${*:-stills recording}
for tool in ffmpeg gifsicle pngquant oxipng; do command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool" >&2; exit 1; }; done

png() { # src dest width — downscale, quantise, strip
  ffmpeg -v error -y -i "$1" -vf "scale=$3:-1:flags=lanczos" "$2.tmp.png"
  pngquant --force --skip-if-larger --quality 75-98 --strip --output "$2" "$2.tmp.png" || cp "$2.tmp.png" "$2"
  rm -f "$2.tmp.png"
  oxipng -q -o 4 --strip safe "$2"
}

case " $WHAT " in *" stills "*)
  for theme in light dark; do
    png "$RAW/hero-$theme.png" "$OUT/hero-$theme.png" 2400
    png "$RAW/discover-$theme.png" "$OUT/shot-discover-$theme.png" 1920
    for shot in project back maintain donor; do
      png "$RAW/$shot-$theme.png" "$OUT/shot-$shot-$theme.png" 1280
    done
  done
  png "$RAW/social-preview.png" "$OUT/social-preview.png" 1280
  ;;
esac

case " $WHAT " in *" recording "*)
  # Terminal: vhs already wrote a GIF; shrink it without touching the timing.
  gifsicle -O3 "$RAW/terminal.gif" -o "$OUT/demo.gif"
  DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/demo.gif")

  # Project page: frames were captured at 8 fps from before the tape started. Cut the same
  # window the terminal GIF covers, so the two loops stay in step when shown together.
  OFFSET=$(awk -v a="$(cat "$RAW/tape-start")" -v b="$(cat "$RAW/live-start")" 'BEGIN { d = a - b; if (d < 0) d = 0; printf "%.3f", d }')
  for theme in light dark; do
    ffmpeg -v error -y -framerate 8 -i "$RAW/live-$theme/%04d.png" -ss "$OFFSET" -t "$DURATION" \
      -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
      "$RAW/live-$theme.gif"
    gifsicle -O3 "$RAW/live-$theme.gif" -o "$OUT/live-$theme.gif"
  done
  ;;
esac

ls -l "$OUT" | awk 'NR > 1 && $5 ~ /^[0-9]+$/ && $NF !~ /^(tapes|\.raw)$/ { printf "%8.0f KB  %s\n", $5 / 1024, $NF }'

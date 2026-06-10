#!/usr/bin/env python3
"""
assemble-sprite.py  ——  把 A/B 帧组装成桌宠精灵图
用法：python scripts/assemble-sprite.py <frames_zip_or_dir> [character_name]

示例：
  python scripts/assemble-sprite.py ~/Downloads/knight-frames.zip knight
  python scripts/assemble-sprite.py ~/Downloads/knight-frames/   knight
"""

import sys, os, json, zipfile, shutil, tempfile
from pathlib import Path
from PIL import Image

# ── 与现有 contract-state-map.json 一致的布局 ────────────────────────────────
COLUMNS   = 8
CELL_W    = 192
CELL_H    = 208
# 每个状态的 (行号, id, 帧数, loop, type, petState)
ROWS = [
  (0,  "idle",          6, True,  "standard",   "good"),
  (1,  "running-right", 8, True,  "standard",   None),
  (2,  "running-left",  8, True,  "standard",   None),
  (3,  "waving",        4, False, "standard",   None),
  (4,  "jumping",       5, False, "standard",   None),
  (5,  "failed",        8, True,  "standard",   "slacking"),
  (6,  "waiting",       6, True,  "standard",   None),
  (7,  "running",       6, True,  "standard",   None),
  (8,  "review",        6, True,  "standard",   None),
  (9,  "happy-idle",    6, True,  "continuous", "thriving"),
  (10, "dizzy-glasses", 6, True,  "continuous", "eyestrain"),
  (11, "sleep",         6, True,  "continuous", "resting"),
  (12, "celebrate",     8, False, "one-shot",   None),
  (13, "sick",          6, True,  "continuous", "sick"),
  (14, "angry",         6, True,  "continuous", "angry"),
  (15, "alert",         6, False, "one-shot",   None),
]
TOTAL_ROWS = len(ROWS)

def load_frames(src: Path, row_id: str):
    """从目录里找 XX_<id>_a.png 和 XX_<id>_b.png，返回 (img_a, img_b)"""
    matches_a = sorted(src.glob(f"*_{row_id}_a.png"))
    matches_b = sorted(src.glob(f"*_{row_id}_b.png"))
    if not matches_a:
        raise FileNotFoundError(f"找不到 *_{row_id}_a.png")
    img_a = Image.open(matches_a[0]).convert("RGBA").resize((CELL_W, CELL_H))
    img_b = Image.open(matches_b[0]).convert("RGBA").resize((CELL_W, CELL_H)) if matches_b else img_a
    return img_a, img_b

def build_row(img_a, img_b, n_frames: int):
    """用 A/B 两帧填满 n_frames 个格子（后两帧是 B，其余是 A）"""
    frames = []
    for i in range(n_frames):
        frames.append(img_b if i >= n_frames - 2 else img_a)
    return frames

def assemble(frames_dir: Path, name: str, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)

    canvas_w = COLUMNS * CELL_W
    canvas_h = TOTAL_ROWS * CELL_H
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))

    state_map = {
        "columns": COLUMNS, "rows": TOTAL_ROWS,
        "cellWidth": CELL_W, "cellHeight": CELL_H,
        "width": canvas_w, "height": canvas_h,
        "rowOrder": [], "petStateToRow": {}, "oneShotRows": {},
    }

    print(f"\n组装精灵图：{name}")
    print(f"画布：{canvas_w}×{canvas_h}，{TOTAL_ROWS} 行 × {COLUMNS} 列\n")

    for row_idx, row_id, n_frames, loop, rtype, pet_state in ROWS:
        try:
            img_a, img_b = load_frames(frames_dir, row_id)
        except FileNotFoundError as e:
            print(f"  ⚠ {e}，用占位色块代替")
            img_a = img_b = Image.new("RGBA", (CELL_W, CELL_H), (180, 180, 200, 180))

        frames = build_row(img_a, img_b, n_frames)
        for col, frame in enumerate(frames):
            canvas.paste(frame, (col * CELL_W, row_idx * CELL_H), frame)

        state_map["rowOrder"].append({
            "row": row_idx, "id": row_id, "frames": n_frames,
            "loop": loop, "type": rtype,
        })
        if pet_state:
            state_map["petStateToRow"][pet_state] = row_idx

        print(f"  行{row_idx:02d} {row_id:20s}  {n_frames}帧  ✓")

    # 保存 WebP + JSON
    webp_path = out_dir / f"{name}.webp"
    json_path = out_dir / f"{name}-state-map.json"

    canvas.save(webp_path, "WEBP", lossless=True)
    json_path.write_text(json.dumps(state_map, ensure_ascii=False, indent=2))

    print(f"\n✅ 精灵图已生成：{webp_path}")
    print(f"✅ 状态图已生成：{json_path}")
    return webp_path, json_path

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)

    src_arg = Path(sys.argv[1]).expanduser()
    name    = sys.argv[2] if len(sys.argv) > 2 else "new-character"
    out_dir = Path(__file__).parent.parent / "pet/src/assets/pets" / name

    # 如果是 zip，先解压到临时目录
    if src_arg.suffix.lower() == ".zip":
        tmp = Path(tempfile.mkdtemp())
        with zipfile.ZipFile(src_arg) as zf:
            zf.extractall(tmp)
        frames_dir = tmp
    else:
        frames_dir = src_arg

    webp, jmap = assemble(frames_dir, name, out_dir)

    # 生成替换指令
    print("\n── 替换步骤 ──────────────────────────────────────────────")
    print(f"在 pet/src/main.ts 中修改以下两行：")
    print(f'  import atlasUrl from "./assets/pets/{name}/{name}.webp";')
    print(f'  import rawMap   from "./assets/pets/{name}/{name}-state-map.json";')
    print("然后 pnpm tauri dev 预览，确认无误后 pnpm tauri build 打包")

if __name__ == "__main__":
    main()

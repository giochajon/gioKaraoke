"""
gioKaraoke Processor
Converts an MP3 into a Karaoke MP4:
  1. Vocal separation   — audio-separator (UVR MDXNET KARA model)
  2. Lyric transcription — whisper-timestamped (word-level timestamps)
  3. ASS subtitle file   — karaoke \kf fill effect
  4. Background image    — PIL dark-purple music-themed art
  5. Video render        — ffmpeg: instrumental + background + subtitles → MP4
"""

import asyncio
import json
import math
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel

MODEL_CACHE = os.environ.get("MODEL_CACHE", "/tmp/model_cache")
WHISPER_CACHE = os.path.join(MODEL_CACHE, "whisper")
SEPARATOR_CACHE = os.path.join(MODEL_CACHE, "audio_separator")

for d in (MODEL_CACHE, WHISPER_CACHE, SEPARATOR_CACHE):
    os.makedirs(d, exist_ok=True)

app = FastAPI()

# In-memory job registry — ephemeral, no disk persistence
jobs: dict[str, dict] = {}


def update_job(job_id: str, **kwargs) -> None:
    if job_id in jobs:
        jobs[job_id].update(kwargs)


# ── Background image ─────────────────────────────────────────────────────────

_NOTES = ["♩", "♪", "♫", "♬", "♭", "♮", "♯"]
_ACCENT = (124, 77, 255)   # --accent #7c4dff
_ACCENT2 = (224, 64, 251)  # --accent2 #e040fb
_BG_DARK = (13, 13, 26)    # --bg #0d0d1a


def _get_fonts() -> tuple:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return (
                    ImageFont.truetype(path, 56),
                    ImageFont.truetype(path, 30),
                    ImageFont.truetype(path, 18),
                )
            except OSError:
                pass
    f = ImageFont.load_default()
    return f, f, f


def generate_background(tmpdir: str, song_title: str = "") -> str:
    W, H = 1280, 720
    img = Image.new("RGB", (W, H), _BG_DARK)
    draw = ImageDraw.Draw(img)

    # Radial gradient glow from center
    cx, cy = W // 2, H // 2
    for r in range(360, 0, -1):
        t = 1 - r / 360
        c = (
            int(_BG_DARK[0] + (_ACCENT[0] - _BG_DARK[0]) * t * 0.18),
            int(_BG_DARK[1] + (_ACCENT[1] - _BG_DARK[1]) * t * 0.10),
            int(_BG_DARK[2] + (_ACCENT[2] - _BG_DARK[2]) * t * 0.25),
        )
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)

    font_lg, font_sm, font_xs = _get_fonts()

    # Scattered music notes
    rng = random.Random(42)
    for _ in range(28):
        x = rng.randint(10, W - 70)
        y = rng.randint(10, H - 90)
        note = rng.choice(_NOTES)
        alpha = rng.randint(18, 55)
        font = font_lg if rng.random() > 0.45 else font_sm
        color = (
            min(255, _ACCENT[0] + alpha),
            min(255, _ACCENT[1] + alpha // 3),
            min(255, _ACCENT[2] + alpha // 2),
        )
        draw.text((x, y), note, fill=color, font=font)

    # Stars
    for _ in range(100):
        x = rng.randint(0, W)
        y = rng.randint(0, H)
        sz = rng.choice([1, 1, 1, 2, 2, 3])
        b = rng.randint(40, 130)
        draw.ellipse([x - sz, y - sz, x + sz, y + sz], fill=(b, b, min(255, b + 40)))

    # Decorative staff lines (top-left cluster)
    staff_y = 60
    for i in range(5):
        y = staff_y + i * 8
        draw.line([(30, y), (200, y)], fill=(60, 35, 90), width=1)

    # Another staff (bottom-right)
    staff_y2 = H - 100
    for i in range(5):
        y = staff_y2 + i * 8
        draw.line([(W - 220, y), (W - 30, y)], fill=(60, 35, 90), width=1)

    # Border
    draw.rectangle([0, 0, W - 1, H - 1], outline=(55, 30, 85), width=2)
    draw.rectangle([5, 5, W - 6, H - 6], outline=(35, 18, 55), width=1)

    # Song title watermark top-center (subtle)
    if song_title:
        label = song_title[:60]
        draw.text((W // 2, 22), label, fill=(80, 55, 100), font=font_xs, anchor="mm")

    bg_path = os.path.join(tmpdir, "background.png")
    img.save(bg_path, "PNG")
    return bg_path


# ── ASS subtitle generation ──────────────────────────────────────────────────

# ASS colours: &HAABBGGRR  (alpha, blue, green, red — reversed RGB with alpha)
_ASS_HEADER = """\
[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Arial,62,&H0000FFFF,&H00FFFFFF,&H00150025,&H78000000,-1,0,0,0,100,100,0.8,0,1,3,1,2,30,30,75,1
Style: Near,Arial,46,&H00E6E6E6,&H00FFFFFF,&H00150025,&H78000000,0,0,0,0,100,100,0.8,0,1,2,1,5,30,30,75,1
Style: Far,Arial,34,&H00909090,&H00FFFFFF,&H00150025,&H78000000,0,0,0,0,100,100,0.8,0,1,2,1,5,30,30,75,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
# PrimaryColour &H0000FFFF = yellow (sung/highlighted current line)
# Near/Far styles render the dimmer lines just before/after the current one,
# producing a scrolling lyrics effect baked directly into the video.

# Fixed vertical slots for the 5-line scrolling window (PlayResY 720), centered horizontally.
_SCROLL_ROWS = {
    -2: (640, 190, "Far"),
    -1: (640, 300, "Near"),
    0:  (640, 430, "Karaoke"),
    1:  (640, 560, "Near"),
    2:  (640, 670, "Far"),
}


def _ts(seconds: float) -> str:
    """Seconds → ASS timestamp H:MM:SS.cc"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{int(s):02d}.{round((s % 1) * 100):02d}"


def _render_scrolling_ass(items: list[dict], tmpdir: str) -> str:
    """
    items: chronological [{t0, t1, active, plain}], where `active` is the
    text (with \\kf karaoke-fill tags) shown while that line is current, and
    `plain` is its plain-text form shown when it's a neighbour.

    For every line's time window, emits the current line plus up to two
    lines before/after at fixed screen positions (see _SCROLL_ROWS), so the
    lyric stack visibly scrolls up through the video as playback advances.
    """
    n = len(items)
    dialogue = []
    for i, item in enumerate(items):
        t0, t1 = _ts(item["t0"]), _ts(item["t1"])
        for offset, (x, y, style) in _SCROLL_ROWS.items():
            j = i + offset
            if j < 0 or j >= n:
                continue
            text = items[j]["active"] if offset == 0 else items[j]["plain"]
            dialogue.append(
                f"Dialogue: 0,{t0},{t1},{style},,0,0,0,,{{\\an5\\pos({x},{y})}}{text}"
            )

    ass_path = os.path.join(tmpdir, "lyrics.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(_ASS_HEADER)
        fh.write("\n".join(dialogue))
        fh.write("\n")
    return ass_path


def generate_ass(result: dict, tmpdir: str) -> str:
    items: list[dict] = []

    for seg in result.get("segments", []):
        words = seg.get("words", [])

        if not words:
            # Fallback: whole-segment line
            t0 = seg.get("start", 0)
            t1 = seg.get("end", t0 + 1)
            cs = max(1, round((t1 - t0) * 100))
            text = (seg.get("text") or "").strip()
            if text:
                items.append({"t0": t0, "t1": t1, "active": f"{{\\kf{cs}}}{text}", "plain": text})
            continue

        # Break words into display lines of ≤8 words or ≤6 s
        current: list[dict] = []
        line_start: Optional[float] = None

        def flush(wds: list[dict]) -> None:
            if not wds:
                return
            t0 = wds[0].get("start", 0)
            t1 = wds[-1].get("end", 0)
            parts, plain_parts = [], []
            for w in wds:
                cs = max(1, round((w.get("end", 0) - w.get("start", 0)) * 100))
                tok = (w.get("word") or w.get("text", "")).strip()
                if tok:
                    parts.append(f"{{\\kf{cs}}}{tok} ")
                    plain_parts.append(tok)
            active = "".join(parts).rstrip()
            plain = " ".join(plain_parts)
            if active:
                items.append({"t0": t0, "t1": t1, "active": active, "plain": plain})

        for i, w in enumerate(words):
            if line_start is None:
                line_start = w.get("start", 0)
            current.append(w)
            duration = w.get("end", 0) - line_start
            if len(current) >= 8 or duration >= 6.0 or i == len(words) - 1:
                flush(current)
                current = []
                line_start = None

    return _render_scrolling_ass(items, tmpdir)


# ── LRC / lrclib.net helpers ─────────────────────────────────────────────────

_LRC_PATTERN = re.compile(r'\[(\d{1,3}):(\d{2})\.(\d{2,3})\](.*)')


def parse_lrc(lrc_text: str) -> list[dict]:
    """Return [{time: float, text: str}] from LRC-format text."""
    lines = []
    for raw in lrc_text.splitlines():
        m = _LRC_PATTERN.match(raw.strip())
        if not m:
            continue
        mins, secs, frac, text = m.groups()
        frac_sec = int(frac) / (100 if len(frac) == 2 else 1000)
        t = int(mins) * 60 + int(secs) + frac_sec
        text = text.strip()
        if text:
            lines.append({"time": round(t, 3), "text": text})
    return lines


def _lrclib_search(params: dict, retries: int = 3) -> list[dict]:
    """
    Hits lrclib.net's search API, retrying transient timeouts. The process
    runs this right after CPU-bound vocal separation finishes, when the
    container can still be under enough load for a single network read to
    stall — a one-shot timeout there shouldn't permanently mean "no lyrics".
    """
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": "gioKaraoke/1.0 (open-source karaoke app)"}
    )
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last_exc = exc
            if attempt < retries - 1:
                print(f"[lrclib] Search attempt {attempt + 1} failed ({exc}), retrying…", flush=True)
                time.sleep(1.5 * (attempt + 1))
    raise last_exc


def _clean_words(text: str) -> str:
    """Strip dashes/underscores/special chars, collapse whitespace, lowercase."""
    text = re.sub(r"[-_]+", " ", text)
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip().lower()


def search_lrclib_debug(raw_title: str) -> dict:
    """
    Search lrclib.net for synced lyrics, given the MP3 filename (sans extension).

    Tries an exact 'Artist - Title' split first, then falls back to a fuzzy
    word-overlap search against the filename with dashes/underscores/special
    characters removed, since most filenames aren't formatted consistently.

    Returns a debug dict: {raw_title, cleaned_query, attempts: [...], lines}
    where `lines` is [{time, text}] (≥4 lines) if a match was found, else None.
    """
    attempts_params: list[dict] = []

    if " - " in raw_title:
        artist, track = (p.strip() for p in raw_title.split(" - ", 1))
        if artist and track:
            attempts_params.append({"artist_name": artist, "track_name": track})

    cleaned = _clean_words(raw_title)
    if cleaned:
        attempts_params.append({"q": cleaned})

    cleaned_words = set(cleaned.split())
    debug: dict = {"raw_title": raw_title, "cleaned_query": cleaned, "attempts": [], "lines": None}

    for params in attempts_params:
        attempt_log: dict = {"params": params, "error": None, "result_count": 0, "candidates": [], "matched": False}
        debug["attempts"].append(attempt_log)

        try:
            results = _lrclib_search(params)
        except Exception as exc:
            attempt_log["error"] = str(exc)
            print(f"[lrclib] Fetch failed for {params}: {exc}", flush=True)
            continue

        attempt_log["result_count"] = len(results)

        best, best_score = None, 0.0
        for result in results:
            synced = (result.get("syncedLyrics") or "").strip()
            has_synced = bool(synced)
            line_count = len(parse_lrc(synced)) if has_synced else 0

            candidate = _clean_words(
                f"{result.get('artistName', '')} {result.get('trackName', '')}"
            )
            candidate_words = set(candidate.split())
            overlap = len(cleaned_words & candidate_words)
            score = overlap / max(1, len(cleaned_words | candidate_words))

            if len(attempt_log["candidates"]) < 5:
                attempt_log["candidates"].append({
                    "artistName": result.get("artistName", ""),
                    "trackName": result.get("trackName", ""),
                    "score": round(score, 2),
                    "has_synced": has_synced,
                    "line_count": line_count,
                })

            if not has_synced or line_count < 4:
                continue

            # Exact field search trusts lrclib's own ranking (first hit); the
            # fuzzy fallback needs a real word-overlap match to avoid noise.
            if "track_name" in params or score >= 0.4:
                best, best_score = parse_lrc(synced), score
                break
            if score > best_score:
                best, best_score = parse_lrc(synced), score

        if best:
            attempt_log["matched"] = True
            debug["lines"] = best
            print(
                f"[lrclib] Found {len(best)} synced lines for '{raw_title}' "
                f"via {list(params.keys())} (score={best_score:.2f})",
                flush=True,
            )
            return debug

    print(f"[lrclib] No synced lyrics found for '{raw_title}'", flush=True)
    return debug


def fetch_lrclib_lyrics(raw_title: str) -> list[dict] | None:
    return search_lrclib_debug(raw_title)["lines"]


def lrc_to_ass(lrc_lines: list[dict], tmpdir: str) -> str:
    """Convert [{time, text}] LRC lines to a scrolling karaoke ASS file."""
    items = []
    for i, line in enumerate(lrc_lines):
        t0 = line["time"]
        t1 = lrc_lines[i + 1]["time"] if i + 1 < len(lrc_lines) else t0 + 5.0
        t1 = min(t1, t0 + 8.0)
        duration_cs = max(1, round((t1 - t0) * 100))
        items.append({
            "t0": t0, "t1": t1,
            "active": f"{{\\kf{duration_cs}}}{line['text']}",
            "plain": line["text"],
        })

    return _render_scrolling_ass(items, tmpdir)


# ── Video rendering ──────────────────────────────────────────────────────────

def render_video(
    instrumental_path: str,
    bg_path: str,
    ass_path: str,
    output_path: str,
) -> str:
    # Escape colon in path (ffmpeg filter option separator)
    ass_escaped = ass_path.replace("\\", "\\\\").replace(":", "\\:")

    # -loop 1 keeps the static image looping; -shortest stops when audio ends.
    # No ffprobe needed — duration is handled automatically by -shortest.
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "25", "-i", bg_path,
        "-i", instrumental_path,
        "-vf", f"ass='{ass_escaped}'",
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-crf", "23",
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{result.stderr[-800:]}")
    return output_path


# ── Processing pipeline ───────────────────────────────────────────────────────

async def process_job(job_id: str, mp3_path: str, tmpdir: str, song_title: str, raw_title: str) -> None:
    loop = asyncio.get_event_loop()

    try:
        # ── Step 1: Vocal separation ────────────────────────────────────────
        update_job(job_id, status="separating", progress=8,
                   step="Separating vocals from instrumental track…")

        def _separate() -> list[str]:
            from audio_separator.separator import Separator
            sep = Separator(
                output_dir=tmpdir,
                model_file_dir=SEPARATOR_CACHE,
                output_format="mp3",
                log_level=20,
            )
            sep.load_model("UVR_MDXNET_KARA_2.onnx")
            return sep.separate(mp3_path)

        async def _heartbeat_separate() -> list[str]:
            elapsed = 0
            MAX_SECS = 40 * 60  # 40-minute hard limit
            future = loop.run_in_executor(None, _separate)
            while not future.done():
                await asyncio.sleep(10)
                elapsed += 10
                if elapsed >= MAX_SECS:
                    raise TimeoutError(
                        f"Vocal separation exceeded {MAX_SECS // 60} min — "
                        "file may be too large for CPU-only processing."
                    )
                m, s = divmod(elapsed, 60)
                update_job(
                    job_id,
                    step=f"Separating vocals… ({m}m {s:02d}s elapsed — CPU mode can take 10–20 min)",
                )
            return await future

        outputs = await _heartbeat_separate()

        # audio-separator returns bare filenames in some versions; resolve to full paths
        resolved = [
            f if os.path.isabs(f) else os.path.join(tmpdir, f)
            for f in outputs
            if os.path.exists(f if os.path.isabs(f) else os.path.join(tmpdir, f))
        ]

        if not resolved:
            raise RuntimeError(
                "Vocal separation produced no output files — "
                "the audio may be corrupt or the process was killed (check available RAM)."
            )

        # Find the instrumental file (avoids vocals)
        instrumental_path: Optional[str] = None
        for f in resolved:
            fn = os.path.basename(f).lower()
            if any(k in fn for k in ("instrumental", "no_vocal", "(inst")):
                instrumental_path = f
                break
        if instrumental_path is None:
            # Fall back: pick the larger output file (usually instrumental)
            instrumental_path = max(resolved, key=lambda p: os.path.getsize(p))

        # ── Step 2: Fetch lyrics from lrclib.net (75 s hard timeout — covers retries) ──
        update_job(job_id, status="transcribing", progress=38,
                   step="Fetching lyrics from lrclib.net…")

        try:
            lrc_lines = await asyncio.wait_for(
                loop.run_in_executor(None, fetch_lrclib_lyrics, raw_title),
                timeout=75.0,
            )
        except asyncio.TimeoutError:
            print(f"[lrclib] Timed out for '{raw_title}'", flush=True)
            lrc_lines = None

        # ── Step 3: ASS subtitles ───────────────────────────────────────────
        if lrc_lines and len(lrc_lines) >= 4:
            update_job(
                job_id, status="subtitles", progress=55,
                step=f"Found {len(lrc_lines)} lyric lines — building subtitles…",
            )
            ass_path = lrc_to_ass(lrc_lines, tmpdir)
        else:
            # Fall back to Whisper transcription
            update_job(job_id, status="transcribing", progress=42,
                       step="No online lyrics found — transcribing with Whisper…")

            def _transcribe() -> dict:
                import whisper_timestamped as whisper
                audio = whisper.load_audio(mp3_path)
                model = whisper.load_model("base", download_root=WHISPER_CACHE)
                return whisper.transcribe(
                    model, audio,
                    language=None,
                    detect_disfluencies=False,
                    verbose=False,
                )

            transcript = await loop.run_in_executor(None, _transcribe)

            update_job(job_id, status="subtitles", progress=65,
                       step="Generating karaoke subtitle file from Whisper…")
            ass_path = generate_ass(transcript, tmpdir)

        # Validate that the ASS file has at least one Dialogue line
        with open(ass_path, encoding="utf-8") as _f:
            _ass_content = _f.read()
        if "Dialogue:" not in _ass_content:
            print(f"[karaoke] WARNING: ASS file has no Dialogue lines — video will have no lyrics", flush=True)
            update_job(job_id, step="⚠ Could not generate lyrics — video will have no subtitles")

        # ── Step 4: Background ──────────────────────────────────────────────
        update_job(job_id, status="background", progress=72,
                   step="Creating background artwork…")
        bg_path = generate_background(tmpdir, song_title)

        # ── Step 5: Render video ────────────────────────────────────────────
        update_job(job_id, status="rendering", progress=78,
                   step="Rendering MP4 with FFmpeg…")
        output_path = os.path.join(tmpdir, "karaoke_output.mp4")

        def _render() -> str:
            return render_video(instrumental_path, bg_path, ass_path, output_path)

        await loop.run_in_executor(None, _render)

        update_job(job_id, status="done", progress=100,
                   step="Done! Your karaoke video is ready.",
                   output_path=output_path)

    except Exception as exc:
        import traceback
        err = f"{exc}"
        update_job(job_id, status="error", progress=0,
                   step=f"Error: {err}", error=err)
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── API ───────────────────────────────────────────────────────────────────────

@app.post("/api/convert/lyrics-test")
async def lyrics_test(file: UploadFile):
    """Debug endpoint: runs the lrclib.net lookup for a filename and returns
    the full search trail (attempts, candidates, scores) without running the
    rest of the conversion pipeline."""
    if not file.filename:
        raise HTTPException(400, detail="No filename provided.")
    raw_title = os.path.splitext(file.filename)[0]
    return search_lrclib_debug(raw_title)


@app.post("/api/convert/upload")
async def upload(file: UploadFile, background_tasks: BackgroundTasks):
    if not file.filename or not file.filename.lower().endswith(".mp3"):
        raise HTTPException(400, detail="Only .mp3 files are accepted.")

    job_id = str(uuid.uuid4())
    tmpdir = tempfile.mkdtemp(prefix="karaoke-")
    mp3_path = os.path.join(tmpdir, file.filename)
    raw_title = os.path.splitext(file.filename)[0]
    song_title = raw_title.replace("_", " ").replace("-", " ").title()

    content = await file.read()
    with open(mp3_path, "wb") as fh:
        fh.write(content)

    jobs[job_id] = {
        "status": "queued",
        "progress": 2,
        "step": "Queued — waiting for processing slot…",
        "tmpdir": tmpdir,
        "mp3_path": mp3_path,
        "song_title": song_title,
        "output_path": None,
        "error": None,
    }

    background_tasks.add_task(process_job, job_id, mp3_path, tmpdir, song_title, raw_title)
    return {"job_id": job_id, "song_title": song_title}


@app.get("/api/convert/status/{job_id}")
async def status_stream(job_id: str):
    async def _gen():
        while True:
            job = jobs.get(job_id)
            if job is None:
                yield f"data: {json.dumps({'status': 'not_found'})}\n\n"
                break
            payload = {
                "status": job["status"],
                "progress": job["progress"],
                "step": job["step"],
                "error": job.get("error"),
            }
            yield f"data: {json.dumps(payload)}\n\n"
            if job["status"] in ("done", "error"):
                break
            await asyncio.sleep(1.5)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/convert/download/{job_id}")
async def download(job_id: str, background_tasks: BackgroundTasks):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found.")
    if job["status"] != "done":
        raise HTTPException(400, detail=f"Job not ready (status: {job['status']}).")

    output_path = job.get("output_path")
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(500, detail="Output file missing.")

    tmpdir = job["tmpdir"]
    song_title = job.get("song_title", "karaoke")

    def _cleanup():
        shutil.rmtree(tmpdir, ignore_errors=True)
        jobs.pop(job_id, None)

    background_tasks.add_task(_cleanup)

    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=f"{song_title}_karaoke.mp4",
    )


@app.get("/health")
async def health():
    return {"status": "ok", "jobs": len(jobs)}


# ── YouTube → MP3 ─────────────────────────────────────────────────────────────

SONGS_PATH = os.environ.get("SONGS_PATH", "/songs")
yt_jobs: dict[str, dict] = {}


_UNSAFE_FILENAME_CHARS = set('/\\:*?"<>|\x00')

def _safe_filename(title: str, maxlen: int = 80) -> str:
    """Strip filesystem-unsafe characters; preserve unicode letters and accents."""
    safe = "".join(c for c in title if c not in _UNSAFE_FILENAME_CHARS).strip()
    safe = " ".join(safe.split())  # collapse whitespace
    return safe[:maxlen] or "audio"


class YTSubmit(BaseModel):
    url: str
    bitrate: str = "320"
    enhance: bool = False
    save_to_library: bool = False


def update_yt_job(job_id: str, **kwargs) -> None:
    if job_id in yt_jobs:
        yt_jobs[job_id].update(kwargs)


async def process_youtube_job(
    job_id: str,
    url: str,
    bitrate: str,
    enhance: bool,
    save_to_library: bool,
    tmpdir: str,
) -> None:
    import traceback as _tb

    loop = asyncio.get_event_loop()

    class _YTLogger:
        """Redirect yt-dlp output to stdout so errors appear in Docker logs."""
        def debug(self, msg):
            if not msg.startswith("[debug] "):
                print(f"[yt-dlp] {msg}", flush=True)
        def warning(self, msg):
            print(f"[yt-dlp WARNING] {msg}", flush=True)
        def error(self, msg):
            print(f"[yt-dlp ERROR] {msg}", flush=True)

    _YT_BASE_OPTS = {
        "logger": _YTLogger(),
        "socket_timeout": 30,
        "retries": 3,
        "noplaylist": True,
    }

    try:
        # ── Step 1: URL Parse + metadata ──────────────────────────────────────
        update_yt_job(job_id, status="parsing", progress=5,
                      step="Fetching video information from YouTube…")

        def _get_info():
            import yt_dlp
            opts = {**_YT_BASE_OPTS, "skip_download": True}
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    raise RuntimeError(
                        "yt-dlp returned no info. The video may be unavailable, "
                        "private, or region-blocked."
                    )
                return info

        async def _heartbeat_info():
            elapsed = 0
            future = loop.run_in_executor(None, _get_info)
            while not future.done():
                await asyncio.sleep(8)
                elapsed += 8
                if yt_jobs.get(job_id, {}).get("status") == "parsing":
                    update_yt_job(job_id,
                                  step=f"Fetching video info… ({elapsed}s elapsed)")
            return await future

        info = await _heartbeat_info()
        title = info.get("title", "audio")
        safe_title = _safe_filename(title)

        # ── Step 2: Stream extraction notice ─────────────────────────────────
        update_yt_job(job_id, status="extracting", progress=15,
                      step=f'Locating best audio-only stream for "{title}"…',
                      title=title)

        # ── Step 3: Download ──────────────────────────────────────────────────
        def _download():
            import yt_dlp

            def _hook(d):
                try:
                    if d["status"] == "downloading":
                        total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                        done = d.get("downloaded_bytes", 0)
                        pct = 20 + int((done / total) * 30) if total else 25
                        speed = d.get("speed") or 0
                        spd = f" — {speed / 1024:.0f} KB/s" if speed else ""
                        update_yt_job(job_id, status="downloading", progress=pct,
                                      step=f"Downloading audio stream{spd}…")
                except Exception as hook_exc:
                    print(f"[yt-dlp hook error] {hook_exc}", flush=True)

            opts = {
                **_YT_BASE_OPTS,
                "format": "bestaudio/best",
                "outtmpl": os.path.join(tmpdir, "raw_audio.%(ext)s"),
                "progress_hooks": [_hook],
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])

        async def _heartbeat_download():
            elapsed = 0
            future = loop.run_in_executor(None, _download)
            while not future.done():
                await asyncio.sleep(8)
                elapsed += 8
                m, s = divmod(elapsed, 60)
                if yt_jobs.get(job_id, {}).get("status") in ("extracting", "downloading"):
                    update_yt_job(job_id,
                                  step=f"Downloading audio… ({m}m {s:02d}s elapsed)")
            await future

        await _heartbeat_download()

        raw_files = [f for f in os.listdir(tmpdir) if f.startswith("raw_audio.")]
        if not raw_files:
            raise RuntimeError("Download produced no output file.")
        raw_audio = os.path.join(tmpdir, raw_files[0])

        # ── Step 4: Transcode to MP3 ──────────────────────────────────────────
        update_yt_job(job_id, status="transcoding", progress=60,
                      step=f"Transcoding to MP3 at {bitrate} kbps…")
        mp3_path = os.path.join(tmpdir, f"{safe_title}.mp3")

        def _transcode():
            cmd = [
                "ffmpeg", "-y", "-i", raw_audio,
                "-vn", "-c:a", "libmp3lame", "-b:a", f"{bitrate}k",
                "-id3v2_version", "3", "-metadata", f"title={title}",
                mp3_path,
            ]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"FFmpeg transcode failed:\n{r.stderr[-600:]}")

        await loop.run_in_executor(None, _transcode)
        output_path = mp3_path

        # ── Step 5: AI Enhancement (optional) ────────────────────────────────
        if enhance:
            update_yt_job(job_id, status="enhancing", progress=78,
                          step="AI enhancement — non-local means denoising + EBU R128 normalization…")
            enhanced_path = os.path.join(tmpdir, f"{safe_title}_enhanced.mp3")

            def _enhance():
                # anlmdn = AI non-local means denoising; loudnorm = EBU R128 normalization
                cmd = [
                    "ffmpeg", "-y", "-i", mp3_path,
                    "-af", (
                        "anlmdn=s=7:p=0.002:r=0.002:m=15,"
                        "loudnorm=I=-16:TP=-1.5:LRA=11"
                    ),
                    "-c:a", "libmp3lame", "-b:a", f"{bitrate}k",
                    "-id3v2_version", "3", "-metadata", f"title={title}",
                    enhanced_path,
                ]
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(f"Enhancement failed:\n{r.stderr[-600:]}")

            await loop.run_in_executor(None, _enhance)
            output_path = enhanced_path

        # ── Save to library ───────────────────────────────────────────────────
        library_saved = False
        if save_to_library and os.path.isdir(SONGS_PATH):
            dest = os.path.join(SONGS_PATH, f"{safe_title}.mp3")
            shutil.copy2(output_path, dest)
            library_saved = True

        update_yt_job(job_id, status="done", progress=100,
                      step="Done! Your MP3 is ready.",
                      output_path=output_path,
                      safe_title=safe_title,
                      library_saved=library_saved)

    except Exception as exc:
        err_msg = str(exc)
        print(f"[yt-mp3] Job {job_id} failed: {err_msg}", flush=True)
        _tb.print_exc()
        update_yt_job(job_id, status="error", progress=0,
                      step=f"Error: {err_msg}", error=err_msg)
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/youtube/submit")
async def youtube_submit(body: YTSubmit, background_tasks: BackgroundTasks):
    url = body.url.strip()
    if not url:
        raise HTTPException(400, detail="YouTube URL is required.")
    if not any(h in url for h in ("youtube.com", "youtu.be", "yt.be")):
        raise HTTPException(400, detail="Please provide a valid YouTube URL.")
    bitrate = body.bitrate if body.bitrate in ("128", "192", "320") else "320"

    is_playlist = "list=" in url or "/playlist" in url

    if is_playlist:
        def _playlist_info():
            import yt_dlp

            class _L:
                def debug(self, m): pass
                def warning(self, m): print(f"[yt-dlp] {m}", flush=True)
                def error(self, m): print(f"[yt-dlp ERROR] {m}", flush=True)

            opts = {
                "logger": _L(),
                "skip_download": True,
                "extract_flat": "in_playlist",
                "socket_timeout": 30,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url, download=False)

        loop = asyncio.get_event_loop()
        info = await loop.run_in_executor(None, _playlist_info)
        entries = (info.get("entries") or [])[:50]
        playlist_title = info.get("title", "Playlist")

        jobs_out = []
        for entry in entries:
            if not entry:
                continue
            vid_id = entry.get("id", "")
            vid_url = (entry.get("url") or "").strip()
            if "youtube.com" not in vid_url and "youtu.be" not in vid_url:
                vid_url = f"https://www.youtube.com/watch?v={vid_id}" if vid_id else None
            if not vid_url:
                continue
            vid_title = entry.get("title", "Unknown")
            job_id = str(uuid.uuid4())
            tmpdir = tempfile.mkdtemp(prefix="yt-mp3-")
            yt_jobs[job_id] = {
                "status": "queued", "progress": 2,
                "step": "Queued — waiting for processing slot…",
                "url": vid_url, "bitrate": bitrate, "enhance": body.enhance,
                "tmpdir": tmpdir, "title": vid_title, "output_path": None,
                "safe_title": None, "library_saved": False, "error": None,
            }
            background_tasks.add_task(
                process_youtube_job, job_id, vid_url, bitrate,
                body.enhance, body.save_to_library, tmpdir,
            )
            jobs_out.append({"job_id": job_id, "title": vid_title})

        return {"jobs": jobs_out, "is_playlist": True, "playlist_title": playlist_title}

    # Single video
    job_id = str(uuid.uuid4())
    tmpdir = tempfile.mkdtemp(prefix="yt-mp3-")
    yt_jobs[job_id] = {
        "status": "queued", "progress": 2,
        "step": "Queued — waiting for processing slot…",
        "url": url, "bitrate": bitrate, "enhance": body.enhance,
        "tmpdir": tmpdir, "title": None, "output_path": None,
        "safe_title": None, "library_saved": False, "error": None,
    }
    background_tasks.add_task(
        process_youtube_job, job_id, url, bitrate,
        body.enhance, body.save_to_library, tmpdir,
    )
    return {"jobs": [{"job_id": job_id, "title": None}], "is_playlist": False}


@app.get("/api/youtube/status/{job_id}")
async def youtube_status(job_id: str):
    async def _gen():
        while True:
            job = yt_jobs.get(job_id)
            if job is None:
                yield f"data: {json.dumps({'status': 'not_found'})}\n\n"
                break
            payload = {
                "status": job["status"],
                "progress": job["progress"],
                "step": job["step"],
                "title": job.get("title"),
                "error": job.get("error"),
                "library_saved": job.get("library_saved", False),
            }
            yield f"data: {json.dumps(payload)}\n\n"
            if job["status"] in ("done", "error"):
                break
            await asyncio.sleep(1.5)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/youtube/download/{job_id}")
async def youtube_download(job_id: str, background_tasks: BackgroundTasks):
    job = yt_jobs.get(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found.")
    if job["status"] != "done":
        raise HTTPException(400, detail=f"Job not ready (status: {job['status']}).")

    output_path = job.get("output_path")
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(500, detail="Output file missing.")

    tmpdir = job["tmpdir"]
    safe_title = job.get("safe_title", "audio")

    def _cleanup():
        shutil.rmtree(tmpdir, ignore_errors=True)
        yt_jobs.pop(job_id, None)

    background_tasks.add_task(_cleanup)

    return FileResponse(
        output_path,
        media_type="audio/mpeg",
        filename=f"{safe_title}.mp3",
    )


# ── Local audio file → enhanced MP3 ──────────────────────────────────────────

async def process_enhance_job(
    job_id: str,
    src_path: str,
    tmpdir: str,
    safe_title: str,
    title: str,
    bitrate: str,
    enhance: bool,
    save_to_library: bool,
) -> None:
    import traceback as _tb

    loop = asyncio.get_event_loop()
    try:
        # ── Step 1: Transcode to MP3 ──────────────────────────────────────────
        update_yt_job(job_id, status="transcoding", progress=20,
                      step=f"Transcoding to MP3 at {bitrate} kbps…")
        mp3_path = os.path.join(tmpdir, f"{safe_title}.mp3")

        def _transcode():
            cmd = [
                "ffmpeg", "-y", "-i", src_path,
                "-vn", "-c:a", "libmp3lame", "-b:a", f"{bitrate}k",
                "-id3v2_version", "3", "-metadata", f"title={title}",
                mp3_path,
            ]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"FFmpeg transcode failed:\n{r.stderr[-600:]}")

        await loop.run_in_executor(None, _transcode)
        output_path = mp3_path

        # ── Step 2: AI Enhancement (optional) ────────────────────────────────
        if enhance:
            update_yt_job(job_id, status="enhancing", progress=70,
                          step="AI enhancement — noise reduction + EBU R128 normalization…")
            enhanced_path = os.path.join(tmpdir, f"{safe_title}_enhanced.mp3")

            def _enhance():
                cmd = [
                    "ffmpeg", "-y", "-i", mp3_path,
                    "-af", (
                        "anlmdn=s=7:p=0.002:r=0.002:m=15,"
                        "loudnorm=I=-16:TP=-1.5:LRA=11"
                    ),
                    "-c:a", "libmp3lame", "-b:a", f"{bitrate}k",
                    "-id3v2_version", "3", "-metadata", f"title={title}",
                    enhanced_path,
                ]
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(f"Enhancement failed:\n{r.stderr[-600:]}")

            await loop.run_in_executor(None, _enhance)
            output_path = enhanced_path

        # ── Save to library ───────────────────────────────────────────────────
        library_saved = False
        if save_to_library and os.path.isdir(SONGS_PATH):
            dest = os.path.join(SONGS_PATH, f"{safe_title}.mp3")
            shutil.copy2(output_path, dest)
            library_saved = True

        update_yt_job(job_id, status="done", progress=100,
                      step="Done! Your MP3 is ready.",
                      output_path=output_path,
                      safe_title=safe_title,
                      library_saved=library_saved)

    except Exception as exc:
        err_msg = str(exc)
        print(f"[yt-enh] Job {job_id} failed: {err_msg}", flush=True)
        _tb.print_exc()
        update_yt_job(job_id, status="error", progress=0,
                      step=f"Error: {err_msg}", error=err_msg)
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/youtube/enhance-upload")
async def enhance_upload(
    background_tasks: BackgroundTasks,
    file: UploadFile,
    bitrate: str = Form("320"),
    enhance: bool = Form(True),
    save_to_library: bool = Form(False),
):
    if not file.filename:
        raise HTTPException(400, detail="No file provided.")

    orig_name = os.path.splitext(file.filename)[0]
    safe_title = _safe_filename(orig_name)
    if bitrate not in ("128", "192", "320"):
        bitrate = "320"

    job_id = str(uuid.uuid4())
    tmpdir = tempfile.mkdtemp(prefix="yt-enh-")
    ext = os.path.splitext(file.filename)[1].lower() or ".audio"
    src_path = os.path.join(tmpdir, f"source{ext}")

    content = await file.read()
    with open(src_path, "wb") as fh:
        fh.write(content)

    yt_jobs[job_id] = {
        "status": "queued", "progress": 5,
        "step": "Queued — waiting for processing slot…",
        "url": None, "bitrate": bitrate, "enhance": enhance,
        "tmpdir": tmpdir, "title": orig_name, "output_path": None,
        "safe_title": safe_title, "library_saved": False, "error": None,
    }

    background_tasks.add_task(
        process_enhance_job, job_id, src_path, tmpdir,
        safe_title, orig_name, bitrate, enhance, save_to_library,
    )
    return {"job_id": job_id, "title": orig_name}

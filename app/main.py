import os
import random
import re
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import connect, init_db
from .security import hash_password, hash_token, new_token, verify_password

STATIC = Path(__file__).parent / "static"
TZ = ZoneInfo(os.environ.get("TZ_NAME", "Europe/Athens"))
SESSION_COOKIE = "greek_session"
# The app is served under a prefix (/greek) by nginx; scope the cookie to it.
COOKIE_PATH = os.environ.get("COOKIE_PATH", "/")
SESSION_TTL = 60 * 60 * 24 * 180
# Days until the next showing, indexed by Leitner box.
BOX_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30]

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.on_event("startup")
def startup() -> None:
    init_db()


def get_db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def current_user(request: Request, db=Depends(get_db)) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        row = db.execute(
            "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (hash_token(token), int(time.time())),
        ).fetchone()
        if row:
            return dict(row)
    raise HTTPException(401, "Нужно войти")


def local_day(ts: int) -> date:
    return datetime.fromtimestamp(ts, TZ).date()


# ---------- pages ----------


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


# ---------- auth ----------


class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response, db=Depends(get_db)):
    row = db.execute(
        "SELECT id, username, password_hash FROM users WHERE username = ?",
        (body.username.strip().lower(),),
    ).fetchone()
    if not row or not verify_password(body.password, row["password_hash"]):
        time.sleep(1)
        raise HTTPException(401, "Неверный логин или пароль")
    token = new_token()
    now = int(time.time())
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (hash_token(token), row["id"], now + SESSION_TTL),
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL,
        path=COOKIE_PATH,
        httponly=True,
        samesite="lax",
        secure=request.headers.get("x-forwarded-proto") == "https",
    )
    return {"id": row["id"], "username": row["username"]}


@app.post("/api/logout")
def logout(request: Request, response: Response, db=Depends(get_db)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
    response.delete_cookie(SESSION_COOKIE, path=COOKIE_PATH)
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(current_user)):
    return user


class PasswordIn(BaseModel):
    old: str
    new: str = Field(min_length=6)


@app.post("/api/password")
def change_password(body: PasswordIn, user=Depends(current_user), db=Depends(get_db)):
    stored = db.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()[0]
    if not verify_password(body.old, stored):
        raise HTTPException(400, "Старый пароль неверный")
    db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(body.new), user["id"])
    )
    return {"ok": True}


# ---------- groups ----------


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@app.get("/api/groups")
def list_groups(user=Depends(current_user), db=Depends(get_db)):
    rows = db.execute(
        """
        SELECT g.id, g.name,
               COUNT(w.id) AS total,
               COALESCE(SUM(p.learned), 0) AS learned
        FROM groups g
        LEFT JOIN words w ON w.group_id = g.id
        LEFT JOIN progress p ON p.word_id = w.id AND p.user_id = ?
        GROUP BY g.id ORDER BY g.position, g.id
        """,
        (user["id"],),
    ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/groups")
def create_group(body: GroupIn, user=Depends(current_user), db=Depends(get_db)):
    name = body.name.strip()
    if db.execute("SELECT 1 FROM groups WHERE name = ?", (name,)).fetchone():
        raise HTTPException(400, "Такая группа уже есть")
    pos = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM groups").fetchone()[0]
    gid = db.execute("INSERT INTO groups (name, position) VALUES (?, ?)", (name, pos)).lastrowid
    return {"id": gid, "name": name}


@app.patch("/api/groups/{group_id}")
def rename_group(group_id: int, body: GroupIn, user=Depends(current_user), db=Depends(get_db)):
    try:
        cur = db.execute("UPDATE groups SET name = ? WHERE id = ?", (body.name.strip(), group_id))
    except Exception:
        raise HTTPException(400, "Такая группа уже есть")
    if cur.rowcount == 0:
        raise HTTPException(404, "Группа не найдена")
    return {"ok": True}


@app.delete("/api/groups/{group_id}")
def delete_group(group_id: int, user=Depends(current_user), db=Depends(get_db)):
    db.execute("DELETE FROM groups WHERE id = ?", (group_id,))
    return {"ok": True}


# ---------- words ----------


class WordIn(BaseModel):
    group_id: int
    greek: str = Field(min_length=1, max_length=200)
    russian: str = Field(min_length=1, max_length=300)
    note: str = Field(default="", max_length=500)


class BulkIn(BaseModel):
    group_id: int
    text: str = Field(max_length=200_000)


def _check_group(db, group_id: int) -> None:
    if not db.execute("SELECT 1 FROM groups WHERE id = ?", (group_id,)).fetchone():
        raise HTTPException(400, "Группа не найдена")


@app.get("/api/words")
def list_words(user=Depends(current_user), db=Depends(get_db)):
    rows = db.execute(
        """
        SELECT w.id, w.group_id, w.greek, w.russian, w.note,
               COALESCE(p.learned, 0) AS learned, COALESCE(p.box, 0) AS box,
               COALESCE(p.correct, 0) AS correct, COALESCE(p.wrong, 0) AS wrong
        FROM words w
        LEFT JOIN progress p ON p.word_id = w.id AND p.user_id = ?
        ORDER BY w.id
        """,
        (user["id"],),
    ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/words")
def create_word(body: WordIn, user=Depends(current_user), db=Depends(get_db)):
    _check_group(db, body.group_id)
    wid = db.execute(
        "INSERT INTO words (group_id, greek, russian, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (body.group_id, body.greek.strip(), body.russian.strip(), body.note.strip(), user["id"], int(time.time())),
    ).lastrowid
    return {"id": wid}


@app.patch("/api/words/{word_id}")
def update_word(word_id: int, body: WordIn, user=Depends(current_user), db=Depends(get_db)):
    _check_group(db, body.group_id)
    cur = db.execute(
        "UPDATE words SET group_id = ?, greek = ?, russian = ?, note = ? WHERE id = ?",
        (body.group_id, body.greek.strip(), body.russian.strip(), body.note.strip(), word_id),
    )
    if cur.rowcount == 0:
        raise HTTPException(404, "Слово не найдено")
    return {"ok": True}


@app.delete("/api/words/{word_id}")
def delete_word(word_id: int, user=Depends(current_user), db=Depends(get_db)):
    db.execute("DELETE FROM words WHERE id = ?", (word_id,))
    return {"ok": True}


BULK_SPLIT = re.compile(r"\s*(?:\t|\||\s[—–-]\s)\s*")


@app.post("/api/words/bulk")
def bulk_words(body: BulkIn, user=Depends(current_user), db=Depends(get_db)):
    """One word per line: `греческое — русское [— заметка]` (also tab or | as separator)."""
    _check_group(db, body.group_id)
    existing = {
        r[0].strip().lower()
        for r in db.execute("SELECT greek FROM words WHERE group_id = ?", (body.group_id,))
    }
    added, skipped, bad = 0, 0, []
    now = int(time.time())
    for line in body.text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = BULK_SPLIT.split(line, maxsplit=2)
        if len(parts) < 2 or not parts[0] or not parts[1]:
            bad.append(line)
            continue
        greek, russian = parts[0], parts[1]
        note = parts[2] if len(parts) > 2 else ""
        if greek.lower() in existing:
            skipped += 1
            continue
        existing.add(greek.lower())
        db.execute(
            "INSERT INTO words (group_id, greek, russian, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (body.group_id, greek, russian, note, user["id"], now),
        )
        added += 1
    return {"added": added, "skipped": skipped, "bad": bad[:20]}


class LearnedIn(BaseModel):
    learned: bool


def _upsert_progress(db, user_id: int, word_id: int) -> None:
    db.execute(
        "INSERT OR IGNORE INTO progress (user_id, word_id) VALUES (?, ?)", (user_id, word_id)
    )


@app.post("/api/words/{word_id}/learned")
def set_learned(word_id: int, body: LearnedIn, user=Depends(current_user), db=Depends(get_db)):
    if not db.execute("SELECT 1 FROM words WHERE id = ?", (word_id,)).fetchone():
        raise HTTPException(404, "Слово не найдено")
    _upsert_progress(db, user["id"], word_id)
    db.execute(
        "UPDATE progress SET learned = ?, learned_at = ? WHERE user_id = ? AND word_id = ?",
        (int(body.learned), int(time.time()) if body.learned else None, user["id"], word_id),
    )
    return {"ok": True}


@app.post("/api/progress/reset")
def reset_progress(user=Depends(current_user), db=Depends(get_db)):
    db.execute("DELETE FROM progress WHERE user_id = ?", (user["id"],))
    db.execute("DELETE FROM reviews WHERE user_id = ?", (user["id"],))
    return {"ok": True}


# ---------- study ----------


@app.get("/api/study")
def study(
    groups: str,
    mode: Literal["unlearned", "learned", "all"] = "unlearned",
    limit: int = 20,
    user=Depends(current_user),
    db=Depends(get_db),
):
    ids = [int(x) for x in groups.split(",") if x.strip().isdigit()]
    if not ids:
        raise HTTPException(400, "Выбери хотя бы одну группу")
    limit = max(1, min(limit, 500))
    now = int(time.time())
    where = {
        "unlearned": "COALESCE(p.learned, 0) = 0",
        "learned": "p.learned = 1",
        "all": "1 = 1",
    }[mode]
    # Due repeats first, then never-seen words, then the rest by how soon they are due.
    order = (
        "CASE WHEN p.word_id IS NOT NULL AND p.due_at <= :now THEN 0 "
        "WHEN p.word_id IS NULL THEN 1 ELSE 2 END, p.due_at, RANDOM()"
        if mode == "unlearned"
        else "RANDOM()"
    )
    placeholders = ",".join(f":g{i}" for i in range(len(ids)))
    params = {f"g{i}": gid for i, gid in enumerate(ids)}
    params.update(uid=user["id"], now=now, limit=limit)
    rows = db.execute(
        f"""
        SELECT w.id, w.greek, w.russian, w.note, g.name AS group_name,
               COALESCE(p.learned, 0) AS learned, COALESCE(p.box, 0) AS box
        FROM words w
        JOIN groups g ON g.id = w.group_id
        LEFT JOIN progress p ON p.word_id = w.id AND p.user_id = :uid
        WHERE w.group_id IN ({placeholders}) AND {where}
        ORDER BY {order}
        LIMIT :limit
        """,
        params,
    ).fetchall()
    cards = [dict(r) for r in rows]
    random.shuffle(cards)
    return cards


class ReviewIn(BaseModel):
    word_id: int
    correct: bool
    direction: Literal["gr-ru", "ru-gr"]


@app.post("/api/review")
def review(body: ReviewIn, user=Depends(current_user), db=Depends(get_db)):
    if not db.execute("SELECT 1 FROM words WHERE id = ?", (body.word_id,)).fetchone():
        raise HTTPException(404, "Слово не найдено")
    now = int(time.time())
    _upsert_progress(db, user["id"], body.word_id)
    box = db.execute(
        "SELECT box FROM progress WHERE user_id = ? AND word_id = ?", (user["id"], body.word_id)
    ).fetchone()[0]
    box = min(box + 1, len(BOX_INTERVAL_DAYS) - 1) if body.correct else 0
    due = now + BOX_INTERVAL_DAYS[box] * 86400
    db.execute(
        f"""UPDATE progress SET box = ?, due_at = ?, last_seen = ?,
            {'correct = correct + 1' if body.correct else 'wrong = wrong + 1'}
            WHERE user_id = ? AND word_id = ?""",
        (box, due, now, user["id"], body.word_id),
    )
    db.execute(
        "INSERT INTO reviews (user_id, word_id, ts, correct, direction) VALUES (?, ?, ?, ?, ?)",
        (user["id"], body.word_id, now, int(body.correct), body.direction),
    )
    return {"box": box}


# ---------- stats ----------


@app.get("/api/stats")
def stats(days: int = 30, user=Depends(current_user), db=Depends(get_db)):
    days = max(7, min(days, 365))
    total = db.execute("SELECT COUNT(*) FROM words").fetchone()[0]
    groups = db.execute(
        "SELECT g.id, g.name, COUNT(w.id) AS total FROM groups g "
        "LEFT JOIN words w ON w.group_id = g.id GROUP BY g.id ORDER BY g.position, g.id"
    ).fetchall()
    today = datetime.now(TZ).date()
    day_list = [today - timedelta(days=i) for i in range(days - 1, -1, -1)]

    result = []
    for u in db.execute("SELECT id, username FROM users ORDER BY id").fetchall():
        uid = u["id"]
        learned_by_group = defaultdict(
            int,
            db.execute(
                "SELECT w.group_id, COUNT(*) FROM progress p JOIN words w ON w.id = p.word_id "
                "WHERE p.user_id = ? AND p.learned = 1 GROUP BY w.group_id",
                (uid,),
            ).fetchall(),
        )
        learned_days = defaultdict(int)
        for (ts,) in db.execute(
            "SELECT learned_at FROM progress WHERE user_id = ? AND learned = 1 AND learned_at IS NOT NULL",
            (uid,),
        ):
            learned_days[local_day(ts)] += 1
        seen = db.execute("SELECT COUNT(*) FROM progress WHERE user_id = ?", (uid,)).fetchone()[0]

        per_day = defaultdict(lambda: [0, 0])  # day -> [answers, correct]
        all_correct = all_answers = 0
        for ts, correct in db.execute("SELECT ts, correct FROM reviews WHERE user_id = ?", (uid,)):
            d = per_day[local_day(ts)]
            d[0] += 1
            d[1] += correct
            all_answers += 1
            all_correct += correct

        streak = 0
        d = today if per_day.get(today) else today - timedelta(days=1)
        while per_day.get(d):
            streak += 1
            d -= timedelta(days=1)

        result.append(
            {
                "id": uid,
                "username": u["username"],
                "learned": sum(learned_by_group.values()),
                "seen": seen,
                "answers": all_answers,
                "accuracy": round(100 * all_correct / all_answers) if all_answers else None,
                "streak": streak,
                "today": per_day.get(today, [0, 0])[0],
                "groups": [
                    {"id": g["id"], "name": g["name"], "total": g["total"], "learned": learned_by_group[g["id"]]}
                    for g in groups
                ],
                "daily": [
                    {
                        "date": day.isoformat(),
                        "answers": per_day.get(day, [0, 0])[0],
                        "correct": per_day.get(day, [0, 0])[1],
                        "learned": learned_days.get(day, 0),
                    }
                    for day in day_list
                ],
            }
        )
    return {"total": total, "me": user["id"], "users": result}

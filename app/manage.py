"""Usage:
  python -m app.manage set-password <username> [password]
      Creates the user if missing. Without a password a random one is generated and printed.
  python -m app.manage import <file.tsv>
      Imports words from a TSV: group <TAB> greek <TAB> russian [<TAB> note].
      Missing groups are created; words already present in the group are skipped.
"""
import secrets
import sys
import time

from .db import connect, init_db
from .security import hash_password


def set_password(username: str, password: str | None) -> None:
    username = username.strip().lower()
    password = password or secrets.token_urlsafe(9)
    conn = connect()
    conn.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?) "
        "ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash",
        (username, hash_password(password)),
    )
    conn.execute(
        "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)", (username,)
    )
    conn.commit()
    print(f"{username}: {password}")


def import_tsv(path: str) -> None:
    conn = connect()
    groups = {name: gid for gid, name in conn.execute("SELECT id, name FROM groups")}
    existing = {
        (gid, greek.strip().lower()) for gid, greek in conn.execute("SELECT group_id, greek FROM words")
    }
    added = skipped = 0
    now = int(time.time())
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3 or not parts[1].strip():
                continue
            group, greek, russian = (p.strip() for p in parts[:3])
            note = parts[3].strip() if len(parts) > 3 else ""
            if group not in groups:
                pos = conn.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM groups").fetchone()[0]
                groups[group] = conn.execute(
                    "INSERT INTO groups (name, position) VALUES (?, ?)", (group, pos)
                ).lastrowid
            gid = groups[group]
            if (gid, greek.lower()) in existing:
                skipped += 1
                continue
            existing.add((gid, greek.lower()))
            conn.execute(
                "INSERT INTO words (group_id, greek, russian, note, created_at) VALUES (?, ?, ?, ?, ?)",
                (gid, greek, russian, note, now),
            )
            added += 1
    conn.commit()
    print(f"added {added}, skipped {skipped}")


def main() -> None:
    init_db()
    if len(sys.argv) >= 3 and sys.argv[1] == "set-password":
        set_password(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif len(sys.argv) == 3 and sys.argv[1] == "import":
        import_tsv(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()

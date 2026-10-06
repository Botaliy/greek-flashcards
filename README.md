# greek-cards

Flashcards for learning Greek (A2): FastAPI + SQLite + vanilla JS.
Served at https://expense-tracker.site/greek/ through the expense-tracker nginx
(`location /greek/`), container `greek-cards` on the `expense-tracker_default` network.

Deploy (no rsync on the server):

    COPYFILE_DISABLE=1 tar czf - --exclude .venv --exclude data --exclude __pycache__ . \
      | ssh de-vpn 'cd /root/greek-cards && tar xzf - && docker compose up -d --build'

Manage:

    docker compose exec greek-cards python -m app.manage set-password <user> [password]
    docker compose exec greek-cards python -m app.manage import app/import_flashcardo.tsv

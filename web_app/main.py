import os
import sqlite3
import uuid
import json
import shutil
import requests
import base64
import threading
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, HTTPException, UploadFile, File, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="Moca Stack API")

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOAD_DIR = os.path.join(STATIC_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# --- Global Sync State ---
_sync_timer = None
_sync_lock = threading.Lock()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS notes 
                 (id TEXT PRIMARY KEY, title TEXT, content TEXT, tags TEXT, 
                  created_at TEXT, updated_at TEXT, is_synced INTEGER DEFAULT 0)""")
    
    c.execute("""CREATE TABLE IF NOT EXISTS config 
                 (key TEXT PRIMARY KEY, value TEXT)""")
    
    # Initialize default config keys if missing
    defaults = {
        "sync_dirty": "0",
        "last_success_at": "",
        "last_error": "",
        "last_attempt_at": ""
    }
    for k, v in defaults.items():
        c.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", (k, v))

    # Migration: Add is_synced column if it doesn't exist
    try:
        c.execute("ALTER TABLE notes ADD COLUMN is_synced INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass # Column already exists
    
    # Simple migration: try to add updated_at if it's an old DB
    try:
        c.execute("ALTER TABLE notes ADD COLUMN updated_at TEXT")
        c.execute("UPDATE notes SET updated_at = created_at WHERE updated_at IS NULL")
    except sqlite3.OperationalError:
        pass # Column already exists
        
    conn.commit()
    conn.close()

init_db()

def get_sync_stats():
    """Helper to get current sync metadata for API responses."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # Get counts
    c.execute("SELECT COUNT(*) FROM notes WHERE is_synced = 0")
    pending = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM notes")
    total = c.fetchone()[0]
    
    # Get config metadata
    c.execute("SELECT key, value FROM config WHERE key IN ('sync_dirty', 'last_success_at', 'last_error', 'last_attempt_at')")
    meta = {row[0]: row[1] for row in c.fetchall()}
    
    conn.close()
    return {
        "pending_count": pending,
        "total_count": total,
        "threshold": 50,
        "has_unsynced_changes": meta.get("sync_dirty") == "1",
        "last_success_at": meta.get("last_success_at"),
        "last_error": meta.get("last_error"),
        "last_attempt_at": meta.get("last_attempt_at")
    }

def mark_dirty(c):
    """Internal helper to flag that a sync is needed."""
    c.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('sync_dirty', '1')")
class NoteCreate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: List[str] = []
    created_at: Optional[str] = None

class BatchDeleteRequest(BaseModel):
    ids: List[str]

class BatchTagRequest(BaseModel):
    ids: List[str]
    add_tags: List[str] = []
    remove_tags: List[str] = []

class NoteResponse(BaseModel):
    id: str
    title: Optional[str]
    content: Optional[str]
    tags: List[str]
    created_at: str
    updated_at: Optional[str] = None

@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1]
    if not ext:
        ext = ".png"
    unique_filename = f"{uuid.uuid4().hex}{ext}"
    file_path = os.path.join(UPLOAD_DIR, unique_filename)
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    return {"url": f"/static/uploads/{unique_filename}"}

@app.post("/api/notes")
def create_note(note: NoteCreate):
    if not note.title and not note.content:
        raise HTTPException(status_code=400, detail="Either title or content must be provided.")
        
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    note_id = str(uuid.uuid4())
    
    # Use provided created_at for migration, or current time
    created_at = note.created_at if note.created_at else datetime.now().isoformat()
    # For a new note, updated_at is the same as created_at
    updated_at = created_at 
    
    tags_json = json.dumps(note.tags)
    
    c.execute(
        "INSERT INTO notes (id, title, content, tags, created_at, updated_at, is_synced) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (note_id, note.title, note.content, tags_json, created_at, updated_at, 0)
    )
    mark_dirty(c)
    conn.commit()
    conn.close()
    
    # Auto-sync in background
    sync_push_silent()
    
    return {
        "id": note_id, 
        "message": "Note created successfully"
    }

@app.put("/api/notes/{note_id}", response_model=NoteResponse)
def update_note(note_id: str, note: NoteCreate):
    if not note.title and not note.content:
        raise HTTPException(status_code=400, detail="Either title or content must be provided.")
        
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # Check if exists
    c.execute("SELECT created_at FROM notes WHERE id = ?", (note_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Note not found")
        
    tags_json = json.dumps(note.tags)
    updated_at = datetime.now().isoformat()
    
    c.execute(
        "UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = ?, is_synced = 0 WHERE id = ?",
        (note.title, note.content, tags_json, updated_at, note_id)
    )
    mark_dirty(c)
    conn.commit()
    conn.close()
    
    # Auto-sync in background
    sync_push_silent()
    
    res = {
        "id": note_id,
        "title": note.title,
        "content": note.content,
        "tags": note.tags,
        "created_at": row[0],
        "updated_at": updated_at
    }
    return res

@app.delete("/api/notes/{note_id}")
def delete_single_note(note_id: str):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Actually delete and mark as sync needed? 
    # For simplicity in this demo, deletion just triggers a full sync.
    c.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    mark_dirty(c)
    conn.commit()
    conn.close()
    
    sync_push_silent()
    return {"status": "success"}

@app.post("/api/notes/batch-delete")
def batch_delete_notes(request: BatchDeleteRequest):
    if not request.ids:
        return {"status": "success", "count": 0}
        
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Using parameterized placeholders for security
    placeholders = ",".join(["?"] * len(request.ids))
    c.execute(f"DELETE FROM notes WHERE id IN ({placeholders})", request.ids)
    mark_dirty(c)
    conn.commit()
    conn.close()
    
    sync_push_silent()
    return {"status": "success", "count": len(request.ids)}

@app.post("/api/notes/batch-tag")
def batch_tag_notes(request: BatchTagRequest):
    if not request.ids:
        return {"status": "success", "count": 0}
        
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    placeholders = ",".join(["?"] * len(request.ids))
    c.execute(f"SELECT id, tags FROM notes WHERE id IN ({placeholders})", request.ids)
    rows = c.fetchall()
    
    updated_at = datetime.now().isoformat()
    count = 0
    for row in rows:
        n_id = row["id"]
        n_tags = json.loads(row["tags"]) if row["tags"] else []
        
        # Add new tags
        for t in request.add_tags:
            if t not in n_tags:
                n_tags.append(t)
        
        # Remove tags
        for t in request.remove_tags:
            if t in n_tags:
                n_tags.remove(t)
                
        c.execute("UPDATE notes SET tags = ?, updated_at = ?, is_synced = 0 WHERE id = ?", 
                  (json.dumps(n_tags), updated_at, n_id))
        count += 1
    
    mark_dirty(c)
    conn.commit()
    conn.close()
    
    sync_push_silent()
    return {"status": "success", "count": count}

def sync_push_silent():
    """Trigger background sync with professional debounce and threshold logic."""
    global _sync_timer
    
    with _sync_lock:
        if _sync_timer is not None:
            _sync_timer.cancel()
        
        # Debounce for 5 seconds to avoid excessive API calls during rapid edits.
        _sync_timer = threading.Timer(5.0, _sync_worker_start)
        _sync_timer.start()

def _sync_worker_start():
    try:
        sync_push()
    except Exception as e:
        print(f"Background Sync Failed: {e}")

@app.get("/api/notes/check_title")
def check_title(title: str):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM notes WHERE LOWER(title) = LOWER(?)", (title,))
    count = c.fetchone()[0]
    conn.close()
    
    return {"exists": count > 0, "count": count}

@app.get("/api/notes", response_model=List[NoteResponse])
def get_notes(query: Optional[str] = None, tag: Optional[str] = None):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM notes ORDER BY created_at DESC")
    rows = c.fetchall()
    conn.close()
    
    notes = []
    for row in rows:
        n = dict(row)
        n_tags = json.loads(n["tags"]) if n["tags"] else []
        
        match = True
        if tag and tag not in n_tags:
            match = False
        if query:
            search_target = f"{n['title'] or ''} {n['content'] or ''}".lower()
            if query.lower() not in search_target:
                match = False
                
        if match:
            notes.append({
                "id": n["id"],
                "title": n["title"],
                "content": n["content"],
                "tags": n_tags,
                "created_at": n["created_at"],
                "updated_at": n.get("updated_at")
            })
            
    return notes

@app.get("/api/tags", response_model=List[str])
def get_all_tags():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT tags FROM notes")
    rows = c.fetchall()
    conn.close()
    
    all_tags = set()
    for row in rows:
        tags = json.loads(row[0]) if row[0] else []
        for t in tags:
            all_tags.add(t)
            
    return sorted(list(all_tags))

# --- Settings & Sync ---
@app.get("/api/settings")
def get_settings():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT key, value FROM config")
    rows = c.fetchall()
    conn.close()
    return {row[0]: row[1] for row in rows}

@app.post("/api/settings")
def update_settings(settings: dict):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    for key, value in settings.items():
        c.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, value))
    conn.commit()
    conn.close()
    return {"status": "success"}

@app.get("/api/sync/status")
def get_sync_status():
    return get_sync_stats()

@app.post("/api/sync/push")
def sync_push(force: bool = False):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    # Internal helper to log status
    def log_sync(status_key, value):
        c.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (status_key, value))

    now_str = datetime.now().isoformat()
    try:
        # 1. Update attempt time immediately and commit
        log_sync("last_attempt_at", now_str)
        conn.commit()
        
        # 2. Check pending items
        c.execute("SELECT COUNT(*) FROM notes WHERE is_synced = 0")
        pending_count = c.fetchone()[0]
        c.execute("SELECT value FROM config WHERE key = 'sync_dirty'")
        row = c.fetchone()
        is_dirty = row[0] == "1" if row else False
        
        # Threshold check: force overcomes all skip logic
        if not force:
            if not is_dirty:
                conn.close()
                return {"status": "skipped", "message": "Nothing to sync."}
            if pending_count < 50:
                conn.close()
                return {"status": "skipped", "message": f"Threshold not met ({pending_count}/50)."}

        # 3. Get settings
        c.execute("SELECT value FROM config WHERE key = 'github_token'")
        token = c.fetchone()
        c.execute("SELECT value FROM config WHERE key = 'github_repo'")
        repo = c.fetchone()
        
        if not token or not repo:
            log_sync("last_error", "GitHub not configured (token/repo missing).")
            conn.commit()
            conn.close()
            return {"status": "error", "message": "GitHub not configured."}
        
        token = token[0]
        repo = repo[0]
        
        # 3. Prepare full data for backup
        c.execute("SELECT * FROM notes")
        notes = [dict(row) for row in c.fetchall()]
        
        for n in notes:
            n["tags"] = json.loads(n["tags"]) if n["tags"] else []

        data_json = json.dumps(notes, indent=2, ensure_ascii=False)
        content_b64 = base64.b64encode(data_json.encode("utf-8")).decode("utf-8")
        
        url = f"https://api.github.com/repos/{repo}/contents/knowlet_backup.json"
        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        res = requests.get(url, headers=headers)
        sha = None
        if res.status_code == 200:
            sha = res.json()["sha"]
            
        commit_msg = f"Archive: {pending_count} knowledge stacks unified 🌸"
        if pending_count > 1000:
            commit_msg = f"Heavy Archive: {pending_count} items migrated 🚀"

        payload = {
            "message": commit_msg,
            "content": content_b64
        }
        if sha: payload["sha"] = sha
            
        res = requests.put(url, headers=headers, json=payload)
        if res.status_code not in [200, 201]:
            log_sync("last_error", f"GitHub Error ({res.status_code}): {res.text[:100]}")
            conn.commit()
            conn.close()
            return {"status": "error", "message": f"GitHub returned {res.status_code}"}
            
        # 4. Mark all as synced and clear dirty
        c.execute("UPDATE notes SET is_synced = 1")
        log_sync("sync_dirty", "0")
        log_sync("last_success_at", now_str)
        log_sync("last_error", "") # Clear previous errors
        conn.commit()
        conn.close()
        
        return {"status": "success", "synced_count": pending_count}

    except Exception as e:
        # Catch network errors, timeouts, etc.
        log_sync("last_error", f"Sync Failed: {str(e)}")
        conn.commit()
        conn.close()
        return {"status": "error", "message": str(e)}


@app.post("/api/sync/pull")
def sync_pull():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    c.execute("SELECT value FROM config WHERE key = 'github_token'")
    token = c.fetchone()
    c.execute("SELECT value FROM config WHERE key = 'github_repo'")
    repo = c.fetchone()
    
    if not token or not repo:
        conn.close()
        raise HTTPException(status_code=400, detail="GitHub settings not configured.")
    
    token = token[0]
    repo = repo[0]
    
    url = f"https://api.github.com/repos/{repo}/contents/knowlet_backup.json"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    res = requests.get(url, headers=headers)
    if res.status_code != 200:
        conn.close()
        raise HTTPException(status_code=res.status_code, detail="Backup file not found on GitHub.")
    
    file_data = res.json()
    content_b64 = file_data["content"]
    data_json = base64.b64decode(content_b64).decode("utf-8")
    notes = json.loads(data_json)
    
    # Restore: clear current and insert
    c.execute("DELETE FROM notes")
    for n in notes:
        c.execute("""INSERT INTO notes (id, title, content, tags, created_at, updated_at, is_synced) 
                     VALUES (?, ?, ?, ?, ?, ?, 1)""", 
                  (n.get("id"), n.get("title"), n.get("content"), 
                   json.dumps(n.get("tags", [])), n.get("created_at"), n.get("updated_at")))
    
    # Sync Metadata Reset: after successful pull, the local state matches the remote exactly.
    now_str = datetime.now().isoformat()
    c.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('sync_dirty', '0')")
    c.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('last_error', '')")
    c.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('last_success_at', ?)", (now_str,))
    
    conn.commit()
    conn.close()
    return {"status": "success"}


@app.delete("/api/tags/{tag_name}")
def delete_tag(tag_name: str):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    # Find all notes that might contain this tag (simple LIKE for efficiency, exact match in python)
    c.execute("SELECT id, tags FROM notes WHERE tags LIKE ?", (f'%"{tag_name}"%',))
    rows = c.fetchall()
    
    updated_count = 0
    for row in rows:
        n_tags = json.loads(row["tags"]) if row["tags"] else []
        if tag_name in n_tags:
            n_tags.remove(tag_name)
            c.execute("UPDATE notes SET tags = ?, is_synced = 0 WHERE id = ?", (json.dumps(n_tags), row["id"]))
            updated_count += 1
            
    mark_dirty(c)
    conn.commit()
    conn.close()
    sync_push_silent()
    return {"message": f"Tag removed from {updated_count} notes."}

# Mount static folder
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static/", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=48291)

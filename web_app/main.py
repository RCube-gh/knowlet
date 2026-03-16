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

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    ''')
    
    c.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
    
    # Simple migration: try to add updated_at if it's an old DB
    try:
        c.execute("ALTER TABLE notes ADD COLUMN updated_at TEXT")
        c.execute("UPDATE notes SET updated_at = created_at WHERE updated_at IS NULL")
    except sqlite3.OperationalError:
        pass # Column already exists
        
    conn.commit()
    conn.close()

init_db()

class NoteCreate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: List[str] = []

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
    created_at = datetime.now().isoformat()
    tags_json = json.dumps(note.tags)
    
    c.execute(
        "INSERT INTO notes (id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (note_id, note.title, note.content, tags_json, created_at, created_at)
    )
    conn.commit()
    conn.close()
    
    # Auto-sync in background
    sync_push_silent()
    
    return {"id": note_id, "message": "Note created successfully"}

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
        "UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?",
        (note.title, note.content, tags_json, updated_at, note_id)
    )
    conn.commit()
    conn.close()
    
    # Auto-sync in background
    sync_push_silent()
    
    return {
        "id": note_id,
        "title": note.title,
        "content": note.content,
        "tags": note.tags,
        "created_at": row[0],
        "updated_at": updated_at
    }

def sync_push_silent():
    """Trigger background sync, ignore all errors and config issues."""
    try:
        def worker():
            try:
                sync_push()
            except:
                pass
        threading.Thread(target=worker).start()
    except:
        pass

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

@app.post("/api/sync/push")
def sync_push():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    # Get settings
    c.execute("SELECT value FROM config WHERE key = 'github_token'")
    token = c.fetchone()
    c.execute("SELECT value FROM config WHERE key = 'github_repo'")
    repo = c.fetchone()
    
    if not token or not repo:
        conn.close()
        raise HTTPException(status_code=400, detail="GitHub settings not configured.")
    
    token = token[0]
    repo = repo[0]
    
    # Get all notes
    c.execute("SELECT * FROM notes")
    notes = [dict(row) for row in c.fetchall()]
    conn.close()
    
    # Convert tags back to array for the JSON backup
    for n in notes:
        n["tags"] = json.loads(n["tags"]) if n["tags"] else []

    data_json = json.dumps(notes, indent=2, ensure_ascii=False)
    content_b64 = base64.b64encode(data_json.encode("utf-8")).decode("utf-8")
    
    url = f"https://api.github.com/repos/{repo}/contents/knowlet_backup.json"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    # Check if file exists to get SHA
    res = requests.get(url, headers=headers)
    sha = None
    if res.status_code == 200:
        sha = res.json()["sha"]
        
    payload = {
        "message": "Update Knowlet backup",
        "content": content_b64
    }
    if sha:
        payload["sha"] = sha
        
    res = requests.put(url, headers=headers, json=payload)
    if res.status_code not in [200, 201]:
        raise HTTPException(status_code=res.status_code, detail=res.text)
        
    return {"status": "success"}

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
        c.execute("""INSERT INTO notes (id, title, content, tags, created_at, updated_at) 
                     VALUES (?, ?, ?, ?, ?, ?)""", 
                  (n.get("id"), n.get("title"), n.get("content"), 
                   json.dumps(n.get("tags", [])), n.get("created_at"), n.get("updated_at")))
    
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
            c.execute("UPDATE notes SET tags = ? WHERE id = ?", (json.dumps(n_tags), row["id"]))
            updated_count += 1
            
    conn.commit()
    conn.close()
    return {"message": f"Tag removed from {updated_count} notes."}

# Mount static folder
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static/", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=48291)

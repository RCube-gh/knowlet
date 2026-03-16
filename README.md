# Knowlet 🌸

Knowlet is a lightweight, effortless knowledge stacking web application. It's designed for friction-less input, allowing you to capture ideas, vocabulary, and formulas the moment they strike.

![Knowlet Preview Placeholder](https://via.placeholder.com/800x450?text=Knowlet+Interface+Preview)

## ✨ Features

- **Friction-less Stacking**: Quick input for titles, content, and tags.
- **Markdown & Math Support**: Full Markdown support with KaTeX for beautiful math formulas (`$E=mc^2$`).
- **Seamless Editing**: Edit your notes directly in the viewer without switching context.
- **Smart Image Handling**: Paste or drag-and-drop images directly into your notes.
- **Tag Management**: Organize your knowledge with an intuitive tagging system and global tag management.
- **Visual Progress**: Track your learning with an activity heatmap and streak tracking.
- **Cloud Sync**: Optional automatic backup and restore using GitHub as a storage backend.

## 🚀 Getting Started

### Prerequisites

- Python 3.8+
- [Optional] GitHub account for Cloud Sync features.

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/knowlet.git
   cd knowlet
   ```

2. Create and activate a virtual environment:
   ```bash
   python -m venv .venv
   # Windows:
   .\.venv\Scripts\activate
   # macOS/Linux:
   source .venv/bin/activate
   ```

3. Install requirements (coming soon):
   ```bash
   pip install fastapi uvicorn python-multipart requests
   ```

### Running the App

```bash
python web_app/main.py
```

Open your browser and navigate to `http://127.0.0.1:48291`.

## ⚙️ Configuration

- Data is stored locally in `data.db` (SQLite).
- GitHub Cloud Sync can be configured in the Settings tab.

## 🌸 Aesthetics

Knowlet is built with a focus on modern, clean, and vibrant aesthetics, making the process of stacking knowledge a delightful experience.

---

Made with 💖 for effortless learning.

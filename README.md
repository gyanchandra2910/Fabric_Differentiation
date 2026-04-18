# 🧵 PTT Fabric Fiber Classifier

An AI-powered fabric fiber classification system that combines **computer vision (YOLOv8)**, a **FastAPI inference server**, an **ESP32 IoT sensor device**, and a **mobile-friendly web interface** to identify fabric types from close-up macro photos.

---

## 📁 Project Structure

```
📦 PTT Fabric Classifier
├── 📁 Frontend/          → Web app (HTML, CSS, JS) — deployed on Netlify
├── 📁 Backend/           → FastAPI inference server — deployed on Hugging Face Spaces (Docker)
├── 📁 Firmware/          → ESP32 Arduino firmware for sensor readings
├── 📁 ML_Models/         → Trained YOLO model files (.onnx, .pt)
├── 📁 3D_Models/         → 3D-printed enclosure STL files
├── 📁 Documents/         → Project report, poster, and presentation (PDFs)
└── 📁 Media/             → Demo videos
```

---

## 🚀 How It Works

1. **User opens the web app** on their phone and takes a close-up photo of the fabric.
2. The image is sent to the **FastAPI backend**, which runs **YOLOv8 classification** and returns the top predicted fabric classes with confidence scores.
3. Simultaneously, the server signals the **ESP32 device** (via long-polling) to physically rub the fabric and measure:
   - ⚡ Static Charge (V)
   - 🌡️ Temperature (°C)
   - 💧 Humidity (%)
4. Results from both the AI model and the physical sensors are shown together on the web app.
5. In **Training Mode**, authorized users can capture labeled images and upload them directly to **Google Drive** for retraining.

---

## 🧩 Components

### 🌐 Frontend (`Frontend/`)
- Pure HTML, CSS, JavaScript — no framework
- Mobile-first, camera-integrated UI
- Two modes: **Classify** and **Training**
- Deployed on **Netlify**
- Key files:
  - `index.html` — App structure
  - `script.js` — All app logic (camera, API calls, polling)
  - `style.css` — Styling

### ⚙️ Backend (`Backend/`)
- **FastAPI** server with async long-polling for ESP32
- **YOLOv8** (Ultralytics) for image classification
- **Google Drive API** integration for training data upload
- **Google OAuth2** for authorized user authentication
- Dockerized and deployed on **Hugging Face Spaces** (port 7860)
- Key endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Server health check |
| `/predict` | POST | Standalone image classification |
| `/capture` | POST | Start job (inference + signal device) |
| `/job/{job_id}` | GET | Poll job status |
| `/device/poll` | GET | ESP32 long-poll for pending work |
| `/device/result` | POST | ESP32 posts sensor readings |
| `/device/status` | GET | Check if ESP32 is online |
| `/train/upload` | POST | Upload labeled training image to Drive |

### 🔌 Firmware (`Firmware/`)
- Arduino code (`device.ino`) for **ESP32**
- Connects to backend via WiFi
- Measures static charge, temperature, humidity on command
- Communicates via HTTP long-polling

### 🤖 ML Models (`ML_Models/`)
- Multiple trained YOLOv8 classification models (`.pt` and `.onnx` formats)
- Different model sizes for accuracy vs. speed tradeoffs
- `best.onnx` — Lightweight model for edge/web inference
- `best (2).onnx` — Larger, higher-accuracy model

### 🖨️ 3D Models (`3D_Models/`)
- STL files for the custom 3D-printed device enclosure
- `Batch-53.stl` — Full assembly
- `Body1.stl` to `Body6.stl` — Individual parts

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JS |
| Backend | Python, FastAPI, Uvicorn |
| AI Model | YOLOv8 (Ultralytics) |
| IoT Device | ESP32 (Arduino) |
| Auth | Google OAuth2 / Google Sign-In |
| Storage | Google Drive API |
| Deployment (Frontend) | Netlify |
| Deployment (Backend) | Hugging Face Spaces (Docker) |
| 3D Printing | STL files (FDM) |

---

## 🏃 Running Locally

### Backend
```bash
cd Backend
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 7860 --reload
```

### Frontend
Just open `Frontend/index.html` in a browser, or serve with:
```bash
cd Frontend
npx serve .
```

### Using Docker (Backend)
```bash
cd Backend
docker build -t ptt-fabric-backend .
docker run -p 7860:7860 ptt-fabric-backend
```

---

## 🎬 Demo Video

A live demonstration of the full system — from fabric photo capture to AI classification and ESP32 sensor readings — is available in the `Media/` folder.

| File | Description |
|---|---|
| [`WhatsApp Video 2026-04-18 at 5.12.23 PM.mp4`](Media/WhatsApp%20Video%202026-04-18%20at%205.12.23%20PM.mp4) | Full end-to-end demo of the PTT Fabric Classifier |

> 📌 **Note:** If viewing on GitHub, download the video from the `Media/` folder to play it locally.

---

## 📄 Documents

| File | Description |
|---|---|
| `Batch53_Poster.pdf` | Project poster (Batch 53) |
| `IDF_Batch53.pdf` | IDF (Innovation/Design Fest) submission |
| `ptt_end_sem.pdf` | End-semester project presentation |

---

## 👥 Batch 53 — Prototyping and Testing Project

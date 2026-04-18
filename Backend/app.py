import asyncio
import base64
import io
import logging
import os
import json
import time
import uuid
from datetime import datetime
from contextlib import asynccontextmanager
from threading import Thread

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.oauth2 import id_token
from google.auth.transport import requests

logger = logging.getLogger("fiber-classifier")

# --- Model singleton ---
model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the YOLO classification model at startup."""
    global model
    logger.info("Loading custom YOLOv8n model from best_5.pt …")
    model = YOLO("best.pt")
    logger.info("Model loaded successfully.")
    yield


app = FastAPI(
    title="PTT Fabric Fiber Classifier",
    description="Broker server: YOLO inference + ESP32 device relay",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
#  In-memory state (single-user prototype)
# ============================================================

# Current job being processed
current_job = None  # dict or None
# Asyncio event to wake up the long-polling ESP32
device_event = asyncio.Event()
# Device heartbeat
device_last_heartbeat = 0.0


# ============================================================
#  Schemas
# ============================================================
class CaptureRequest(BaseModel):
    image: str  # base64-encoded JPEG/PNG


class PredictionItem(BaseModel):
    class_name: str
    confidence: float


class DeviceResult(BaseModel):
    static_charge_v: float
    temperature_c: float
    humidity_pct: float


class PredictRequest(BaseModel):
    image: str


# ============================================================
#  Helper: run YOLO inference (called in background thread)
# ============================================================
def run_inference(job_id: str, img: Image.Image):
    global current_job
    try:
        results = model(img, verbose=False)
        result = results[0]
        probs = result.probs
        top3_indices = probs.top5[:3]
        top3_confs = probs.top5conf.tolist()[:3]

        predictions = [
            {"class_name": result.names[idx], "confidence": round(conf, 4)}
            for idx, conf in zip(top3_indices, top3_confs)
        ]

        if current_job and current_job["id"] == job_id:
            current_job["inference"] = predictions
            logger.info(f"Job {job_id}: inference complete")
    except Exception as exc:
        logger.error(f"Job {job_id}: inference failed: {exc}")
        if current_job and current_job["id"] == job_id:
            current_job["inference_error"] = str(exc)


# ============================================================
#  Routes
# ============================================================

@app.get("/health")
async def health():
    return {"status": "ok"}


# ---------- Legacy endpoint (backward compat) ----------
@app.post("/predict")
async def predict(req: PredictRequest):
    """Standalone predict (no device involvement)."""
    try:
        img_data = req.image
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]
        raw = base64.b64decode(img_data)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}")

    results = model(img, verbose=False)
    result = results[0]
    probs = result.probs
    top3_indices = probs.top5[:3]
    top3_confs = probs.top5conf.tolist()[:3]

    predictions = [
        PredictionItem(class_name=result.names[idx], confidence=round(conf, 4))
        for idx, conf in zip(top3_indices, top3_confs)
    ]
    return {"predictions": predictions}


# ---------- Capture: starts inference + signals device ----------
@app.post("/capture")
async def capture(req: CaptureRequest):
    global current_job

    try:
        img_data = req.image
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]
        raw = base64.b64decode(img_data)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}")

    job_id = uuid.uuid4().hex[:12]

    # Is the device currently online?
    device_online = (time.time() - device_last_heartbeat) < 30.0

    # Create job
    current_job = {
        "id": job_id,
        "created_at": time.time(),
        "inference": None,
        "inference_error": None,
        "device_readings": None,
        "device_needed": device_online,       # skip device if offline
        "device_picked_up_at": None,
        "device_was_offline": not device_online,
    }

    # Start inference in background thread
    thread = Thread(target=run_inference, args=(job_id, img), daemon=True)
    thread.start()

    # Signal the ESP32 long-poll only if device is online
    if device_online:
        device_event.set()

    return {"job_id": job_id, "device_online": device_online}


# ---------- Job status (frontend polls this) ----------
@app.get("/job/{job_id}")
async def get_job(job_id: str):
    if not current_job or current_job["id"] != job_id:
        raise HTTPException(status_code=404, detail="Job not found")

    job = current_job
    now = time.time()

    # Determine overall status
    inference_done = job["inference"] is not None or job["inference_error"] is not None
    device_done = job["device_readings"] is not None
    device_offline = False

    if not device_done:
        if job.get("device_was_offline"):
            # Device was offline at capture time — skip immediately
            device_done = True
            device_offline = True
        elif job["device_picked_up_at"]:
            # Device picked up the job — give it up to 30s to finish
            if (now - job["device_picked_up_at"]) > 30.0:
                device_done = True
                device_offline = True
        elif job["device_needed"]:
            # Device hasn't picked up work yet — check heartbeat
            heartbeat_ok = (now - device_last_heartbeat) < 20.0
            if not heartbeat_ok and (now - job["created_at"]) > 10.0:
                device_done = True
                device_offline = True

    if inference_done and device_done:
        status = "complete"
    else:
        status = "processing"

    response = {
        "status": status,
        "job_id": job_id,
    }

    if inference_done:
        if job["inference"]:
            response["predictions"] = job["inference"]
        elif job["inference_error"]:
            response["inference_error"] = job["inference_error"]

    if job["device_readings"]:
        response["sensor_readings"] = job["device_readings"]
    elif device_offline:
        response["device_offline"] = True

    return response


# ---------- Device: long-poll for pending work ----------
@app.get("/device/poll")
async def device_poll():
    """ESP32 calls this. Blocks up to 25s waiting for a job."""
    global device_last_heartbeat
    # The device is online if it's calling this endpoint
    device_last_heartbeat = time.time()

    # Clear the event before waiting
    device_event.clear()

    # If there's already a pending job, return immediately
    if current_job and current_job["device_needed"] and current_job["device_readings"] is None:
        current_job["device_needed"] = False
        current_job["device_picked_up_at"] = time.time()
        device_last_heartbeat = time.time()
        return {"action": "rub", "job_id": current_job["id"]}

    # Otherwise wait for up to 25 seconds
    try:
        await asyncio.wait_for(device_event.wait(), timeout=25.0)
    except asyncio.TimeoutError:
        device_last_heartbeat = time.time()  # still alive after wait
        return {"action": "none"}

    # Event fired — check if there's a job
    if current_job and current_job["device_readings"] is None:
        current_job["device_needed"] = False
        current_job["device_picked_up_at"] = time.time()
        device_last_heartbeat = time.time()
        return {"action": "rub", "job_id": current_job["id"]}

    device_last_heartbeat = time.time()
    return {"action": "none"}


# ---------- Device: post sensor readings ----------
@app.post("/device/result")
async def device_result(result: DeviceResult):
    global device_last_heartbeat
    if not current_job:
        raise HTTPException(status_code=404, detail="No active job")

    current_job["device_readings"] = {
        "static_charge_v": result.static_charge_v,
        "temperature_c": result.temperature_c,
        "humidity_pct": result.humidity_pct,
    }
    device_last_heartbeat = time.time()  # device just posted, it's online
    logger.info(f"Job {current_job['id']}: device readings received")
    return {"status": "ok"}


# ---------- Device: heartbeat ----------
@app.post("/device/heartbeat")
async def device_heartbeat():
    global device_last_heartbeat
    device_last_heartbeat = time.time()
    return {"status": "ok"}


# ---------- Device status (frontend checks this) ----------
@app.get("/device/status")
async def device_status():
    online = (time.time() - device_last_heartbeat) < 30.0
    return {"online": online}


# ---------- Frontend Config ----------
@app.get("/config")
async def get_config():
    return {
        "google_client_id": os.environ.get("GOOGLE_CLIENT_ID", "")
    }


# ============================================================
#  TRAINING MODE — Google Drive Proxy
# ============================================================

class TrainUpload(BaseModel):
    image: str       # base64 data URL
    class_name: str  # e.g., "Cotton"
    google_token: str # Signed JWT from Google Sign-In

@app.post("/train/upload")
async def train_upload(payload: TrainUpload):
    # 0. Verify AuthN
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        raise HTTPException(status_code=500, detail="Server missing Google Client ID")
        
    try:
        idinfo = id_token.verify_oauth2_token(payload.google_token, requests.Request(), client_id)
        email = idinfo.get("email", "")
        
        allowed_users_raw = os.environ.get("ALLOWED_USERS", "")
        allowed_users = [u.strip().lower() for u in allowed_users_raw.split(",") if u.strip()]
        
        if not allowed_users or email.lower() not in allowed_users:
            logger.warning(f"Unauthorized upload attempt by {email}")
            raise HTTPException(status_code=403, detail="Your Google account is not authorized to upload.")
            
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid Google Identity token")

    # 1. Parse Image
    if not payload.image.startswith("data:image"):
        raise HTTPException(status_code=400, detail="Image must be a data URL")
        
    _, encoded = payload.image.split(",", 1)
    file_bytes = base64.b64decode(encoded)
    
    # 2. Fetch Folder ID
    # e.g. "Mixed (Cotton+)" -> "MIXED_COTTON" -> env var "DRIVE_FOLDER_MIXED_COTTON"
    clean_cls = payload.class_name.replace(" ", "_").replace("(", "").replace(")", "").replace("+", "").upper()
    env_key = f"DRIVE_FOLDER_{clean_cls}"
    folder_id = os.environ.get(env_key)
    if not folder_id:
        raise HTTPException(status_code=500, detail=f"No missing folder ID secret for class: {payload.class_name} ({env_key})")

    # 2. Authenticate using Refresh Token
    refresh_token = os.environ.get("GOOGLE_REFRESH_TOKEN")
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    
    if not refresh_token or not client_id or not client_secret:
        raise HTTPException(status_code=500, detail="Missing Google OAuth credentials in Secrets")
        
    try:
        from google.oauth2.credentials import Credentials
        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            client_id=client_id,
            client_secret=client_secret,
            token_uri="https://oauth2.googleapis.com/token"
        )
        drive_service = build("drive", "v3", credentials=creds)
    except Exception as e:
        logger.error(f"Auth error: {e}")
        raise HTTPException(status_code=500, detail="Failed to initialize Google Auth")

    # 3. Upload file
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    clean_filename = payload.class_name.replace(" ", "").replace("+", "")
    filename = f"{timestamp}_{clean_filename}.jpg"
    
    file_metadata = {
        "name": filename,
        "parents": [folder_id]
    }
    media = MediaIoBaseUpload(io.BytesIO(file_bytes), mimetype="image/jpeg", resumable=False)
    
    try:
        drive_service.files().create(body=file_metadata, media_body=media, fields="id").execute()
        return {"status": "success", "filename": filename}
    except Exception as e:
        logger.error(f"Drive API Error: {e}")
        raise HTTPException(status_code=500, detail=f"Google Drive upload failed: {str(e)}")

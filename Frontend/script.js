// ============================================================
//  PTT Fabric Fiber Classifier — script.js
//  Modes: Classify (inference + sensor) | Train (label + Drive upload)
// ============================================================

// ─── CONFIG ────────────────────────────────────────────────
const API_URL = "https://hsakaletap-ptt-fabric-classifier.hf.space";
let GOOGLE_CLIENT_ID = "";

async function fetchConfig() {
    try {
        const res = await fetch(`${API_URL}/config`);
        const data = await res.json();
        GOOGLE_CLIENT_ID = data.google_client_id;
    } catch (e) {
        console.error("Failed to fetch config.");
    }
}


// ───────────────────────────────────────────────────────────

// ─── DOM REFS ───────────────────────────────────────────────
const captureScreen = document.getElementById("capture-screen");
const resultScreen = document.getElementById("result-screen");
const trainCaptureScreen = document.getElementById("train-capture-screen");
const trainLabelScreen = document.getElementById("train-label-screen");
const allScreens = [captureScreen, resultScreen, trainCaptureScreen, trainLabelScreen];

// Classify mode
const nativeInput = document.getElementById("native-camera-input");
const galleryInput = document.getElementById("gallery-input");
const btnOpenCamera = document.getElementById("btn-open-camera");
const btnOpenGallery = document.getElementById("btn-open-gallery");
const captureCanvas = document.getElementById("capture-canvas");
const capturedPreview = document.getElementById("captured-preview");
const btnRetake = document.getElementById("btn-retake");

// Result UI
const resultLoading = document.getElementById("result-loading");
const resultSuccess = document.getElementById("result-success");
const resultError = document.getElementById("result-error");
const resultClass = document.getElementById("result-class");
const resultConfText = document.getElementById("result-confidence-text");
const resultConfBar = document.getElementById("result-confidence-bar");
const otherPredictions = document.getElementById("other-predictions");
const errorMessage = document.getElementById("error-message");
const stepInference = document.getElementById("step-inference");
const stepDevice = document.getElementById("step-device");
const sensorSection = document.getElementById("sensor-section");
const sensorCharge = document.getElementById("sensor-charge");
const sensorTemp = document.getElementById("sensor-temp");
const sensorHumidity = document.getElementById("sensor-humidity");
const deviceOfflineNote = document.getElementById("device-offline-note");

// Training mode
const trainCameraInput = document.getElementById("train-camera-input");
const trainGalleryInput = document.getElementById("train-gallery-input");
const btnTrainPhoto = document.getElementById("btn-train-photo");
const btnTrainGallery = document.getElementById("btn-train-gallery");
const trainCanvas = document.getElementById("train-canvas");
const trainPreview = document.getElementById("train-preview");
const classGrid = document.getElementById("class-grid");
const btnUploadDrive = document.getElementById("btn-upload-drive");
const uploadStatus = document.getElementById("upload-status");
const driveAuthRow = document.getElementById("drive-auth-row");
const btnTrainRetake = document.getElementById("btn-train-retake");

// Mode toggle
const modeBanner = document.querySelector(".mode-banner");
const modeLabel = document.getElementById("mode-label");
const btnModeToggle = document.getElementById("btn-mode-toggle");
const modeToggleText = document.getElementById("mode-toggle-text");

// Device status
const deviceStatusDot = document.querySelector(".status-dot");

// ─── MODE STATE ─────────────────────────────────────────────
let isTrainingMode = false;
let selectedClass = null;
let googleToken = null;  // JWT from Google Identity
let trainImageBlobs = []; // array of raw JPEG blobs for backend batch uploads

// ─── FABRIC CLASSES ─────────────────────────────────────────
const FABRIC_CLASSES = ["Cotton", "Polyester", "Denim", "Wool", "Microfiber", "Nylon", "Mixed (Cotton+)"];

// ============================================================
//  Device status polling
// ============================================================
async function checkDeviceStatus() {
    try {
        const res = await fetch(`${API_URL}/device/status`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        deviceStatusDot.classList.toggle("online", data.online);
        deviceStatusDot.classList.toggle("offline", !data.online);
    } catch {
        deviceStatusDot.classList.remove("online");
        deviceStatusDot.classList.add("offline");
    }
}
setInterval(checkDeviceStatus, 5000);
checkDeviceStatus();

// ============================================================
//  Screen navigation
// ============================================================
function showScreen(screen) {
    allScreens.forEach(s => s.classList.remove("active"));
    screen.classList.add("active");
}

// ============================================================
//  Mode toggle
// ============================================================
btnModeToggle.addEventListener("click", () => {
    isTrainingMode = !isTrainingMode;
    if (isTrainingMode) {
        modeLabel.textContent = "Training Mode";
        modeToggleText.textContent = "Switch to Classify";
        modeBanner.classList.add("training");
        showScreen(trainCaptureScreen);
    } else {
        modeLabel.textContent = "Classify Mode";
        modeToggleText.textContent = "Switch to Training";
        modeBanner.classList.remove("training");
        showScreen(captureScreen);
    }
});

// ============================================================
//  CLASSIFY MODE — Image capture + inference pipeline
// ============================================================
btnOpenCamera.addEventListener("click", () => nativeInput.click());
btnOpenGallery.addEventListener("click", () => galleryInput.click());

function handleClassifyChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Clear both inputs so same file can trigger change again
    nativeInput.value = "";
    galleryInput.value = "";

    readAndProcess(file, captureCanvas, capturedPreview, (dataUrl) => {
        showScreen(resultScreen);
        startCapturePipeline(dataUrl);
    });
}

nativeInput.addEventListener("change", handleClassifyChange);
galleryInput.addEventListener("change", handleClassifyChange);

btnRetake.addEventListener("click", () => showScreen(captureScreen));

function readAndProcess(file, canvas, previewEl, onReady) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const blob = cropToSquare(img, canvas, 640);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
            if (previewEl) previewEl.src = dataUrl;
            onReady(dataUrl, blob);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

/** Center-crops <img> to a square and scales to exactly targetSize x targetSize for YOLO */
function cropToSquare(img, canvas, targetSize) {
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;

    // YOLO models typically expect 640x640
    canvas.width = targetSize;
    canvas.height = targetSize;

    // Draw the cropped center portion directly into the 640x640 canvas
    canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
    return canvas;
}

// ─── Capture pipeline ───────────────────────────────────────
async function startCapturePipeline(base64DataUrl) {
    resultLoading.classList.remove("hidden");
    resultSuccess.classList.add("hidden");
    resultError.classList.add("hidden");
    resultConfBar.style.width = "0%";
    sensorSection.classList.add("hidden");
    deviceOfflineNote.classList.add("hidden");
    stepInference.classList.remove("done");
    stepDevice.classList.remove("done", "skipped");

    try {
        const res = await fetch(`${API_URL}/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64DataUrl }),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);

        const { job_id, device_online } = await res.json();
        if (!device_online) stepDevice.classList.add("skipped");
        await pollJob(job_id);
    } catch (err) {
        showClassifyError(err.message || "Network error");
    }
}

async function pollJob(jobId) {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`${API_URL}/job/${jobId}`);
            if (!res.ok) throw new Error(`Poll error ${res.status}`);
            const data = await res.json();
            if (data.predictions) stepInference.classList.add("done");
            if (data.sensor_readings || data.device_offline)
                stepDevice.classList.add(data.device_offline ? "skipped" : "done");
            if (data.status === "complete") { showResult(data); return; }
        } catch (e) { console.error("Poll:", e); }
        await sleep(1000);
    }
    showClassifyError("Timed out waiting for results.");
}

function showResult(data) {
    if (data.inference_error) { showClassifyError("Inference failed: " + data.inference_error); return; }
    const preds = data.predictions;
    if (!preds?.length) { showClassifyError("No predictions returned."); return; }

    const top = preds[0];
    resultClass.textContent = top.class_name.replace(/_/g, " ");
    const pct = (top.confidence * 100).toFixed(1);
    resultConfText.textContent = `${pct}%`;
    requestAnimationFrame(() => resultConfBar.style.width = `${pct}%`);

    otherPredictions.innerHTML = "";
    if (preds.length > 1) {
        const h = document.createElement("h4");
        h.textContent = "Other possibilities";
        otherPredictions.appendChild(h);
        preds.slice(1).forEach(p => {
            const row = document.createElement("div");
            row.className = "pred-row";
            row.innerHTML = `<span class="name">${p.class_name.replace(/_/g, " ")}</span><span class="conf">${(p.confidence * 100).toFixed(1)}%</span>`;
            otherPredictions.appendChild(row);
        });
    }

    if (data.sensor_readings) {
        const s = data.sensor_readings;
        sensorCharge.textContent = s.static_charge_v.toFixed(4);
        sensorTemp.textContent = s.temperature_c >= 0 ? s.temperature_c.toFixed(1) : "err";
        sensorHumidity.textContent = s.humidity_pct >= 0 ? s.humidity_pct.toFixed(1) : "err";
        sensorSection.classList.remove("hidden");
    } else if (data.device_offline) {
        deviceOfflineNote.classList.remove("hidden");
    }

    resultLoading.classList.add("hidden");
    resultSuccess.classList.remove("hidden");
}

function showClassifyError(msg) {
    errorMessage.textContent = msg;
    resultLoading.classList.add("hidden");
    resultError.classList.remove("hidden");
}

// ============================================================
//  TRAINING MODE — Photo → label → upload to Drive
// ============================================================

// Startup: build the class grid
async function init() {
    await fetchConfig();
    buildClassGrid();
    initGoogleIdentity();
}
init();

function initGoogleIdentity() {
    if (typeof google === "undefined" || !GOOGLE_CLIENT_ID) return;
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (res) => {
            googleToken = res.credential;
            document.getElementById("google-signin-btn").style.display = "none";
            setUploadStatus("Signed in correctly.", "success");
        }
    });
    google.accounts.id.renderButton(
        document.getElementById("google-signin-btn"),
        { theme: "outline", size: "large", width: "100%" }
    );
}

btnTrainPhoto.addEventListener("click", () => trainCameraInput.click());
btnTrainGallery.addEventListener("click", () => trainGalleryInput.click());

function handleTrainingChange(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    trainImageBlobs = [];
    let processedCount = 0;
    document.getElementById("train-preview").src = "";
    const countEl = document.getElementById("train-multi-count");
    countEl.classList.add("hidden");

    files.forEach((file) => {
        readAndProcess(file, trainCanvas, trainPreview, (_dataUrl, canvas) => {
            canvas.toBlob((blob) => {
                trainImageBlobs.push(blob);
                processedCount++;

                if (processedCount === files.length) {
                    resetTrainUploadUI();
                    showScreen(trainLabelScreen);

                    if (files.length > 1) {
                        countEl.textContent = `${files.length} images selected (uploading together)`;
                        countEl.classList.remove("hidden");
                    }
                }
            }, "image/jpeg", 0.88);
        });
    });

    // Clear inputs
    trainCameraInput.value = "";
    trainGalleryInput.value = "";
}

trainCameraInput.addEventListener("change", handleTrainingChange);
trainGalleryInput.addEventListener("change", handleTrainingChange);

btnTrainRetake.addEventListener("click", () => {
    trainImageBlobs = [];
    showScreen(trainCaptureScreen);
});

function buildClassGrid() {
    classGrid.innerHTML = "";
    FABRIC_CLASSES.forEach(cls => {
        const btn = document.createElement("button");
        btn.className = "class-btn";
        btn.textContent = cls;
        btn.dataset.cls = cls;
        btn.addEventListener("click", () => selectClass(cls));
        classGrid.appendChild(btn);
    });
}

function selectClass(cls) {
    selectedClass = cls;
    classGrid.querySelectorAll(".class-btn").forEach(b =>
        b.classList.toggle("selected", b.dataset.cls === cls)
    );
    // Enable upload button only if we have a class AND either already signed in or need to sign in
    btnUploadDrive.disabled = false;
    setUploadStatus("");
}

function resetTrainUploadUI() {
    selectedClass = null;
    classGrid.querySelectorAll(".class-btn").forEach(b => b.classList.remove("selected"));
    btnUploadDrive.disabled = true;
    uploadStatus.className = "upload-status hidden";
    uploadStatus.textContent = "";
}

// ─── HF Space Backend Upload ─────────────────────────────────────
btnUploadDrive.addEventListener("click", async () => {
    if (!selectedClass) return;
    if (trainImageBlobs.length === 0) { setUploadStatus("No image captured.", "error"); return; }
    if (!googleToken) { setUploadStatus("Please sign in with Google first.", "error"); return; }
    await doUpload();
});

async function doUpload() {
    if (!selectedClass || trainImageBlobs.length === 0 || !googleToken) return;

    btnUploadDrive.disabled = true;
    let successCount = 0;

    for (let i = 0; i < trainImageBlobs.length; i++) {
        setUploadStatus(`Uploading image ${i + 1} of ${trainImageBlobs.length} to server…`, "uploading");
        const blob = trainImageBlobs[i];

        try {
            await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64data = reader.result;

                    const payload = {
                        image: base64data,
                        class_name: selectedClass,
                        google_token: googleToken
                    };

                    const res = await fetch(`${API_URL}/train/upload`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });

                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        reject(`Upload failed: ${err.detail || res.statusText}`);
                        return;
                    }
                    resolve();
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            successCount++;
        } catch (err) {
            setUploadStatus(typeof err === "string" ? err : "Network error during upload.", "error");
            btnUploadDrive.disabled = false;
            return;
        }
    }

    setUploadStatus(`✓ Uploaded ${successCount} image(s) to Drive → ${selectedClass}`, "success");
    btnUploadDrive.disabled = false;
}

function setUploadStatus(msg, type) {
    uploadStatus.textContent = msg;
    uploadStatus.className = `upload-status${msg ? "" : " hidden"}${type ? ` ${type}` : ""}`;
}

// ─── Utility ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

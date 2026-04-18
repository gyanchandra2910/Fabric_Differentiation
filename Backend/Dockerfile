FROM python:3.11-slim

# HF Spaces expects port 7860
ENV PORT=7860

WORKDIR /app

# Install system deps for OpenCV (ultralytics dependency)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the YOLO model so it's baked into the image
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n-cls.pt')"

COPY . .

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    fonts-dejavu-core \
    gcc \
    python3-dev \
    curl \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch — all three packages must come from the same index
RUN pip install --no-cache-dir \
    torch torchaudio torchvision \
    --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV MODEL_CACHE=/model_cache

RUN mkdir -p "$MODEL_CACHE" \
    && groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser \
    && chown -R appuser:appuser /app "$MODEL_CACHE"
USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:5000/ || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
